/**
 * Connect a bills mailbox with OAuth (T-0216, ADR-0105 rules 3–5, RQ-0187 F4, DL-0934).
 *
 * startMailboxOAuth stores a pre-authorization (SHA-256 of a 256-bit state, PKCE verifier,
 * provider, mailbox address, folder, the starting user and session; 10-minute TTL) and returns
 * the provider's authorization URL. completeMailboxOAuth consumes it once — only for the same
 * user and session, unexpired — exchanges the code with the verifier, saves the mailbox (refresh
 * token sealed, the active mailbox superseded) and writes an audit row without any secret.
 * Both run in the caller's tenant transaction; the code exchange is the one network call.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Database } from '@ledgerforce/db';
import type { Kms } from '@ledgerforce/shared/crypto';
import type { Transaction } from 'kysely';
import { BillsMailboxError, saveOAuthBillsMailbox } from './inbox-mailbox.ts';
import {
  authorizationUrl,
  exchangeAuthorizationCode,
  isMailboxOAuthProvider,
  MAILBOX_OAUTH_PROVIDERS,
  MailboxOAuthError,
  newOAuthState,
  newPkceVerifier,
  pkceChallenge,
  type MailboxOAuthConfig,
  type MailboxOAuthProvider,
} from './mailbox-oauth.ts';

type Trx = Transaction<Database>;

export const MAILBOX_OAUTH_REQUEST_TTL_MS = 10 * 60 * 1000;

const FOLDER = /^[ -~]{1,255}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const STATE = /^[A-Za-z0-9_-]{43}$/;

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

export interface StartMailboxOAuthInput {
  readonly companyId: string;
  readonly provider: MailboxOAuthProvider;
  /** The mailbox address to connect (login_hint, XOAUTH2 user). */
  readonly username: string;
  readonly folder?: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly now: Date;
}

export interface StartedMailboxOAuth {
  readonly requestId: string;
  readonly authorizationUrl: string;
  readonly expiresAt: Date;
}

/** Store the pre-authorization and build the provider's authorization URL. */
export async function startMailboxOAuth(
  trx: Trx,
  config: MailboxOAuthConfig,
  input: StartMailboxOAuthInput,
): Promise<StartedMailboxOAuth> {
  if (!isMailboxOAuthProvider(input.provider)) throw new BillsMailboxError('unknown provider');
  const username = input.username.trim();
  const folder = input.folder ?? 'INBOX';
  if (
    username.length === 0 ||
    username.length > 320 ||
    CONTROL.test(username) ||
    !/^[^@\s]+@[^@\s]+$/.test(username)
  ) {
    throw new BillsMailboxError('username must be the mailbox email address');
  }
  if (!FOLDER.test(folder)) throw new BillsMailboxError('folder must be printable ASCII');
  if (!config[input.provider]) throw new MailboxOAuthError('not_configured');
  const state = newOAuthState();
  const verifier = newPkceVerifier();
  const id = randomUUID();
  const expiresAt = new Date(input.now.getTime() + MAILBOX_OAUTH_REQUEST_TTL_MS);
  await trx
    .insertInto('app.bill_inbox_oauth_request')
    .values({
      id,
      company_id: input.companyId.toLowerCase(),
      state_sha256: sha256(state),
      code_verifier: verifier,
      provider: input.provider,
      username,
      folder,
      user_id: input.userId,
      session_id: input.sessionId,
      created_at: input.now,
      expires_at: expiresAt,
    })
    .execute();
  return {
    requestId: id,
    authorizationUrl: authorizationUrl(config, input.provider, {
      state,
      codeChallenge: pkceChallenge(verifier),
      loginHint: username,
    }),
    expiresAt,
  };
}

export interface CompleteMailboxOAuthInput {
  readonly state: string;
  readonly code: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly now: Date;
}

export interface ConnectedMailbox {
  readonly mailboxId: string;
  readonly companyId: string;
  readonly provider: MailboxOAuthProvider;
  readonly username: string;
  readonly folder: string;
}

/**
 * The callback: consume the pre-authorization (same user and session, unexpired, once), exchange
 * the code, save the mailbox and audit it. Throws MailboxOAuthError (`invalid_request` for an
 * unknown, used, expired or foreign state; `auth_failed`/`connect_failed` from the provider).
 * The consumption stays committed when the caller turns the error into a redirect.
 */
export async function completeMailboxOAuth(
  trx: Trx,
  kms: Kms,
  config: MailboxOAuthConfig,
  input: CompleteMailboxOAuthInput,
): Promise<ConnectedMailbox> {
  if (!STATE.test(input.state)) throw new MailboxOAuthError('invalid_request');
  const req = await trx
    .updateTable('app.bill_inbox_oauth_request')
    .set({ consumed_at: input.now })
    .where('state_sha256', '=', sha256(input.state))
    .where('consumed_at', 'is', null)
    .where('expires_at', '>', input.now)
    .where('user_id', '=', input.userId)
    .where('session_id', '=', input.sessionId)
    .returning(['id', 'company_id', 'code_verifier', 'provider', 'username', 'folder'])
    .executeTakeFirst();
  if (!req) throw new MailboxOAuthError('invalid_request');
  const tokens = await exchangeAuthorizationCode(config, req.provider, {
    code: input.code,
    codeVerifier: req.code_verifier,
  });
  const mailboxId = await saveOAuthBillsMailbox(trx, kms, req.company_id, {
    provider: req.provider,
    username: req.username,
    folder: req.folder,
    refreshToken: tokens.refreshToken,
    createdBy: input.userId,
  });
  // GET callbacks are not audited by the request interceptor: write the row here, no secret.
  await trx
    .insertInto('audit.audit_log')
    .values({
      actor_type: 'user',
      actor_user_id: input.userId,
      action: 'ap.bills_mailbox.oauth_connected',
      entity_type: 'bill_inbox_mailbox',
      entity_id: mailboxId,
      before: null,
      after: JSON.stringify({
        companyId: req.company_id,
        authMethod: 'oauth2',
        provider: req.provider,
        host: MAILBOX_OAUTH_PROVIDERS[req.provider].imapHost,
        username: req.username,
        folder: req.folder,
        oauthRequestId: req.id,
      }),
    })
    .execute();
  return {
    mailboxId,
    companyId: req.company_id,
    provider: req.provider,
    username: req.username,
    folder: req.folder,
  };
}
