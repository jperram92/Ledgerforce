/**
 * Connect a bills mailbox with OAuth (T-0216, ADR-0105 rules 3–5, RQ-0187 F4, DL-0934).
 *
 * startMailboxOAuth stores a pre-authorization (SHA-256 of a 256-bit state, PKCE verifier,
 * provider, mailbox address, folder, the starting user and session; 10-minute TTL) and returns
 * the provider's authorization URL. completeMailboxOAuth consumes it once — only for the same
 * user and session, unexpired — exchanges the code with the verifier, saves the mailbox (refresh
 * token sealed, the active mailbox superseded) and writes an audit row without any secret.
 * startMailboxOAuth runs in the caller's tenant transaction. completeMailboxOAuth gets a runner
 * that opens a fresh tenant transaction per call (T-0243, ADR-0108, RQ-0190): it consumes the
 * request in one, exchanges the code with no transaction open (the one network call, up to
 * 15 s), then saves and audits in a second. The verifier is cleared by the consuming statement
 * (and by a cancel); clearStaleMailboxOAuthVerifiers clears those of expired requests.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Database } from '@ledgerforce/db';
import type { Kms } from '@ledgerforce/shared/crypto';
import { sql, type Transaction } from 'kysely';
import {
  BillsMailboxError,
  clearStaleMailboxOAuthVerifiers,
  saveOAuthBillsMailbox,
} from './inbox-mailbox.ts';
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

/**
 * Runs `fn` in a new, committed-on-return tenant transaction of the caller's tenant (the API's
 * TenantTx.run re-verifies the session and permission in each one, ADR-0108).
 */
export type TenantRun = <T>(fn: (trx: Trx) => Promise<T>) => Promise<T>;

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
  await clearStaleMailboxOAuthVerifiers(trx);
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

/** Use up the caller's own pre-authorization when the provider answered with an error. */
export async function cancelMailboxOAuth(
  trx: Trx,
  input: Omit<CompleteMailboxOAuthInput, 'code'>,
): Promise<void> {
  if (!STATE.test(input.state)) return;
  await trx
    .updateTable('app.bill_inbox_oauth_request')
    .set({ consumed_at: input.now, code_verifier: null, verifier_cleared_at: input.now })
    .where('state_sha256', '=', sha256(input.state))
    .where('consumed_at', 'is', null)
    .where('code_verifier', 'is not', null)
    .where('user_id', '=', input.userId)
    .where('session_id', '=', input.sessionId)
    .execute();
}

interface ConsumedRequest {
  id: string;
  company_id: string;
  code_verifier: string;
  provider: MailboxOAuthProvider;
  username: string;
  folder: string;
}

/**
 * The callback: consume the pre-authorization (same user and session, unexpired, once) and clear
 * its verifier in one transaction, exchange the code with no transaction open, then save the
 * mailbox and audit it in a second transaction (T-0243, ADR-0108). Throws MailboxOAuthError
 * (`invalid_request` for an unknown, used, expired or foreign state; `auth_failed` /
 * `connect_failed` from the provider). The consumption is committed before the exchange, so a
 * failed exchange leaves the request used up.
 */
export async function completeMailboxOAuth(
  run: TenantRun,
  kms: Kms,
  config: MailboxOAuthConfig,
  input: CompleteMailboxOAuthInput,
): Promise<ConnectedMailbox> {
  if (!STATE.test(input.state)) throw new MailboxOAuthError('invalid_request');
  // 1. Consume and clear the verifier; the old value comes back from the locked row.
  const req = await run(async (trx) => {
    const r = await sql<ConsumedRequest>`
      WITH old AS (
        SELECT id, code_verifier FROM app.bill_inbox_oauth_request
         WHERE state_sha256 = ${sha256(input.state)}
           AND consumed_at IS NULL
           AND code_verifier IS NOT NULL
           AND expires_at > ${input.now}
           AND user_id = ${input.userId}::uuid
           AND session_id = ${input.sessionId}::uuid
         FOR UPDATE
      )
      UPDATE app.bill_inbox_oauth_request r
         SET consumed_at = ${input.now}, code_verifier = NULL, verifier_cleared_at = ${input.now}
        FROM old
       WHERE r.id = old.id
      RETURNING r.id::text AS id, r.company_id::text AS company_id, old.code_verifier,
                r.provider, r.username, r.folder`.execute(trx);
    return r.rows[0];
  });
  if (!req) throw new MailboxOAuthError('invalid_request');
  // 2. The network call, outside any transaction.
  const tokens = await exchangeAuthorizationCode(config, req.provider, {
    code: input.code,
    codeVerifier: req.code_verifier,
  });
  // 3. Save and audit.
  const mailboxId = await run(async (trx) => {
    const id = await saveOAuthBillsMailbox(trx, kms, req.company_id, {
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
        entity_id: id,
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
    return id;
  });
  return {
    mailboxId,
    companyId: req.company_id,
    provider: req.provider,
    username: req.username,
    folder: req.folder,
  };
}
