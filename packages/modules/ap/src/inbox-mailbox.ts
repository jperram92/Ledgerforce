/**
 * Bills inbox IMAP transport (T-0127, UC-05, ADR-0095, RQ-0177, DL-0812, DL-0813).
 *
 * saveBillsMailbox stores a company's bills mailbox (server, user, folder) with the password
 * envelope-encrypted (ADR-0018), AAD-bound to tenant, company, table, row and field; a change is a
 * new row and the active one becomes superseded. listBillsMailboxes never returns a secret.
 *
 * pollBillsMailbox reads new mail read-only (EXAMINE + BODY.PEEK[]) and feeds each message to
 * ingestBillEmail (T-0051). Exactly once: every message is ingested in its own tenant transaction
 * that locks the mailbox row, skips UIDs the cursor has passed, ingests (idempotent on Message-ID)
 * and advances the cursor (uidvalidity, last_uid). A changed UIDVALIDITY restarts at UID 0.
 * Messages over the size ceiling (from RFC822.SIZE, before download) and messages ingest refuses
 * (InboxError) are counted as refused and the cursor moves on; any other error stops the poll with
 * the cursor where it is. Connection and login failures are recorded on the row as a fixed error
 * class and returned, not thrown. No network I/O runs inside a database transaction.
 *
 * OAuth mailboxes (T-0216, ADR-0105, DL-0933): saveOAuthBillsMailbox stores the provider's refresh
 * token in the same sealed columns with AAD field `refresh_token`, at the provider's fixed IMAP
 * host. Each poll refreshes an access token (outside any transaction), re-seals a rotated refresh
 * token in place, and logs in with AUTHENTICATE XOAUTH2. A refused grant is `auth_failed`, a
 * token-endpoint failure `connect_failed` (DL-0935).
 */
import { randomUUID } from 'node:crypto';
import { withTenant, type Database } from '@ledgerforce/db';
import { openField, sealField, type Kms } from '@ledgerforce/shared/crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import {
  DEFAULT_MAX_MESSAGE_BYTES,
  ImapClient,
  ImapError,
  tlsConnector,
  type ImapConnector,
  type ImapErrorKind,
} from './imap-client.ts';
import { InboxError, ingestBillEmail } from './inbox.ts';
import {
  isMailboxOAuthProvider,
  MAILBOX_OAUTH_PROVIDERS,
  MailboxOAuthError,
  refreshAccessToken,
  type MailboxOAuthConfig,
  type MailboxOAuthProvider,
} from './mailbox-oauth.ts';

type Trx = Transaction<Database>;

export class BillsMailboxError extends Error {
  readonly code = 'INVALID_MAILBOX';
  constructor(message: string) {
    super(message);
    this.name = 'BillsMailboxError';
  }
}

export interface BillsMailboxInput {
  readonly host: string;
  /** Implicit-TLS IMAP port; default 993 (RFC 8314). */
  readonly port?: number;
  readonly username: string;
  readonly password: string;
  /** Printable-ASCII folder name; default INBOX. */
  readonly folder?: string;
  readonly createdBy?: string;
}

export interface BillsMailboxView {
  readonly id: string;
  readonly companyId: string;
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly folder: string;
  readonly status: 'active' | 'superseded' | 'disabled';
  readonly uidValidity: number | null;
  readonly lastUid: number;
  readonly refusedCount: number;
  readonly lastPolledAt: Date | null;
  readonly lastError: string | null;
  readonly createdAt: Date;
  /**
   * `login`: IMAP LOGIN with a stored password; `oauth2`: signed in with Microsoft or Google
   * (T-0216). Never carries a secret.
   */
  readonly authMethod: 'login' | 'oauth2';
  readonly oauthProvider: MailboxOAuthProvider | null;
}

export interface OAuthBillsMailboxInput {
  readonly provider: MailboxOAuthProvider;
  /** The mailbox address the grant is for (XOAUTH2 `user=`). */
  readonly username: string;
  readonly refreshToken: string;
  readonly folder?: string;
  readonly createdBy?: string;
}

const HOST = /^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/;
const FOLDER = /^[ -~]{1,255}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

type SecretField = 'password' | 'refresh_token';

const aadFor = (tenantId: string, companyId: string, id: string, field: SecretField = 'password') =>
  `lf-field-v1|${tenantId}|${companyId}|app.bill_inbox_mailbox|${id}|${field}`;

const fieldOf = (authMethod: string): SecretField =>
  authMethod === 'oauth2' ? 'refresh_token' : 'password';

async function currentTenant(trx: Trx): Promise<string> {
  const t = await sql<{ tenant_id: string | null }>`
    SELECT nullif(current_setting('app.tenant_id', true), '') AS tenant_id`.execute(trx);
  const tenantId = t.rows[0]?.tenant_id;
  if (!tenantId) throw new Error('bills mailbox writes must run inside a tenant transaction');
  return tenantId;
}

const sealedColumns = (sealed: Awaited<ReturnType<typeof sealField>>) => ({
  password_ct: sealed.ciphertext,
  password_iv: sealed.iv,
  password_tag: sealed.tag,
  password_dek_wrapped: sealed.wrappedDek,
  password_kek_id: sealed.keyId,
  password_enc_version: sealed.version,
});

function checkUsername(username: string): void {
  if (username.length === 0 || username.length > 320 || CONTROL.test(username)) {
    throw new BillsMailboxError('username must be 1-320 characters without control characters');
  }
}

/** Store the company's bills mailbox; the active one (if any) becomes superseded. Returns its id. */
export async function saveBillsMailbox(
  trx: Trx,
  kms: Kms,
  companyId: string,
  input: BillsMailboxInput,
): Promise<string> {
  const company = companyId.toLowerCase();
  const host = input.host.trim();
  const username = input.username.trim();
  const folder = input.folder ?? 'INBOX';
  const port = input.port ?? 993;
  if (!HOST.test(host)) throw new BillsMailboxError('host must be a host name or IP address');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new BillsMailboxError('port must be 1-65535');
  }
  checkUsername(username);
  if (
    input.password.length === 0 ||
    input.password.length > 1024 ||
    /[\r\n\0]/.test(input.password)
  ) {
    throw new BillsMailboxError('password must be 1-1024 characters without CR, LF or NUL');
  }
  if (!FOLDER.test(folder)) throw new BillsMailboxError('folder must be printable ASCII');
  const tenantId = await currentTenant(trx);
  const id = randomUUID();
  const sealed = await sealField(kms, input.password, aadFor(tenantId, company, id));
  await trx
    .updateTable('app.bill_inbox_mailbox')
    .set({ status: 'superseded' })
    .where('company_id', '=', company)
    .where('status', '=', 'active')
    .execute();
  await trx
    .insertInto('app.bill_inbox_mailbox')
    .values({
      id,
      company_id: company,
      host,
      port,
      username,
      folder,
      ...sealedColumns(sealed),
      created_by: input.createdBy ?? null,
    })
    .execute();
  return id;
}

/**
 * Store a mailbox connected with OAuth (T-0216, ADR-0105 rule 5): the provider's fixed IMAP host,
 * the refresh token sealed with AAD field `refresh_token`. The active mailbox becomes superseded.
 */
export async function saveOAuthBillsMailbox(
  trx: Trx,
  kms: Kms,
  companyId: string,
  input: OAuthBillsMailboxInput,
): Promise<string> {
  const company = companyId.toLowerCase();
  if (!isMailboxOAuthProvider(input.provider)) throw new BillsMailboxError('unknown provider');
  const username = input.username.trim();
  const folder = input.folder ?? 'INBOX';
  checkUsername(username);
  if (!FOLDER.test(folder)) throw new BillsMailboxError('folder must be printable ASCII');
  if (!/^[\x21-\x7e]{1,4000}$/.test(input.refreshToken)) {
    throw new BillsMailboxError('refresh token must be 1-4000 printable characters');
  }
  const spec = MAILBOX_OAUTH_PROVIDERS[input.provider];
  const tenantId = await currentTenant(trx);
  const id = randomUUID();
  const sealed = await sealField(
    kms,
    input.refreshToken,
    aadFor(tenantId, company, id, 'refresh_token'),
  );
  await trx
    .updateTable('app.bill_inbox_mailbox')
    .set({ status: 'superseded' })
    .where('company_id', '=', company)
    .where('status', '=', 'active')
    .execute();
  await trx
    .insertInto('app.bill_inbox_mailbox')
    .values({
      id,
      company_id: company,
      host: spec.imapHost,
      port: spec.imapPort,
      username,
      folder,
      ...sealedColumns(sealed),
      auth_method: 'oauth2',
      oauth_provider: input.provider,
      created_by: input.createdBy ?? null,
    })
    .execute();
  return id;
}

const VIEW = [
  'id',
  'company_id',
  'host',
  'port',
  'username',
  'folder',
  'status',
  'uidvalidity',
  'last_uid',
  'refused_count',
  'last_polled_at',
  'last_error',
  'created_at',
  'auth_method',
  'oauth_provider',
] as const;

/** The company's mailboxes, newest first, without secrets. */
export async function listBillsMailboxes(trx: Trx, companyId: string): Promise<BillsMailboxView[]> {
  const rows = await trx
    .selectFrom('app.bill_inbox_mailbox')
    .select(VIEW)
    .where('company_id', '=', companyId.toLowerCase())
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    companyId: r.company_id,
    host: r.host,
    port: r.port,
    username: r.username,
    folder: r.folder,
    status: r.status,
    uidValidity: r.uidvalidity === null ? null : Number.parseInt(r.uidvalidity, 10),
    lastUid: Number.parseInt(r.last_uid, 10),
    refusedCount: r.refused_count,
    lastPolledAt: r.last_polled_at,
    lastError: r.last_error,
    createdAt: r.created_at,
    authMethod: r.auth_method === 'oauth2' ? 'oauth2' : 'login',
    oauthProvider: r.oauth_provider,
  }));
}

export interface PollDeps {
  readonly kms: Kms;
  /** How to reach a mailbox; default implicit TLS with certificate verification. */
  readonly connector?: (m: { host: string; port: number }) => ImapConnector;
  /** Message ceiling (RFC822.SIZE); default 25 MiB (RQ-0177 F5). */
  readonly maxMessageBytes?: number;
  /** Most messages handled per poll; default 50. The rest wait for the next poll. */
  readonly maxPerPoll?: number;
  readonly commandTimeoutMs?: number;
  readonly now?: () => Date;
  /** OAuth client configuration (ADR-0105 rule 2); without it OAuth mailboxes fail connect_failed. */
  readonly oauth?: MailboxOAuthConfig | null;
}

export interface PollResult {
  readonly mailboxId: string;
  readonly status: 'ok' | 'failed' | 'skipped';
  readonly error?: ImapErrorKind | 'credentials_unreadable';
  readonly ingested: number;
  /** Messages already in the inbox (same Message-ID), e.g. after a UIDVALIDITY reset. */
  readonly replayed: number;
  readonly refused: readonly { uid: number; reason: 'too_large' | 'invalid_email' }[];
  /** More new messages than maxPerPoll were waiting. */
  readonly remaining: boolean;
}

interface MailboxRow {
  id: string;
  company_id: string;
  host: string;
  port: number;
  username: string;
  folder: string;
  status: string;
  uidvalidity: string | null;
  last_uid: string;
  auth_method: 'password' | 'oauth2';
  oauth_provider: MailboxOAuthProvider | null;
}

/**
 * Advance the cursor to `uid` under `uidValidity`, after `work` ran in the same transaction.
 * Returns false (and runs nothing) when the cursor has already passed `uid` — another poller did it.
 */
async function step(
  db: Kysely<Database>,
  tenantId: string,
  mailboxId: string,
  uidValidity: number,
  uid: number,
  work: (trx: Trx, companyId: string) => Promise<{ refused: boolean; replayed?: boolean }>,
): Promise<{ done: boolean; refused: boolean; replayed: boolean }> {
  return withTenant(db, tenantId, async (trx) => {
    const row = (
      await sql<{ company_id: string; uidvalidity: string | null; last_uid: string }>`
        SELECT company_id::text, uidvalidity::text, last_uid::text FROM app.bill_inbox_mailbox
         WHERE id = ${mailboxId}::uuid FOR UPDATE`.execute(trx)
    ).rows[0];
    if (!row) return { done: false, refused: false, replayed: false };
    const sameValidity =
      row.uidvalidity !== null && Number.parseInt(row.uidvalidity, 10) === uidValidity;
    const cursor = sameValidity ? Number.parseInt(row.last_uid, 10) : 0;
    if (uid <= cursor) return { done: false, refused: false, replayed: false };
    const out = await work(trx, row.company_id);
    const replayed = out.replayed === true;
    await trx
      .updateTable('app.bill_inbox_mailbox')
      .set((eb) => ({
        uidvalidity: String(uidValidity),
        last_uid: String(uid),
        refused_count: out.refused ? eb('refused_count', '+', 1) : eb.ref('refused_count'),
      }))
      .where('id', '=', mailboxId)
      .execute();
    return { done: true, refused: out.refused, replayed };
  });
}

/** Re-seal a rotated refresh token into the same (active, oauth2) row; same AAD (ADR-0105 rule 6). */
async function rotateRefreshToken(
  db: Kysely<Database>,
  kms: Kms,
  tenantId: string,
  row: MailboxRow,
  refreshToken: string,
): Promise<void> {
  const sealed = await sealField(
    kms,
    refreshToken,
    aadFor(tenantId.toLowerCase(), row.company_id, row.id, 'refresh_token'),
  );
  // lf_app has no UPDATE on the secret columns; the narrow SECURITY DEFINER function does it
  // for an active oauth2 row of this tenant only (migration 0082). A superseded row is left alone.
  await withTenant(db, tenantId, (trx) =>
    sql`SELECT app.rotate_bill_inbox_refresh_token(
          ${row.id}::uuid, ${sealed.ciphertext}, ${sealed.iv}, ${sealed.tag},
          ${sealed.wrappedDek}, ${sealed.keyId}, ${sealed.version}::smallint)`.execute(trx),
  );
}

async function record(
  db: Kysely<Database>,
  tenantId: string,
  mailboxId: string,
  now: Date,
  error: string | null,
): Promise<void> {
  await withTenant(db, tenantId, (trx) =>
    trx
      .updateTable('app.bill_inbox_mailbox')
      .set({ last_polled_at: now, last_error: error })
      .where('id', '=', mailboxId)
      .execute(),
  );
}

/** Poll one active mailbox of a tenant. Never throws for mail-server problems (see PollResult). */
export async function pollBillsMailbox(
  db: Kysely<Database>,
  deps: PollDeps,
  c: { tenantId: string; mailboxId: string },
): Promise<PollResult> {
  const now = deps.now ?? (() => new Date());
  const maxBytes = deps.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  const maxPerPoll = deps.maxPerPoll ?? 50;
  const base = { mailboxId: c.mailboxId, ingested: 0, replayed: 0, refused: [], remaining: false };

  // 1. Read the configuration and open the password (short transaction, no network).
  const loaded = await withTenant(db, c.tenantId, async (trx) => {
    const row = await trx
      .selectFrom('app.bill_inbox_mailbox')
      .select([
        'id',
        'company_id',
        'host',
        'port',
        'username',
        'folder',
        'status',
        'uidvalidity',
        'last_uid',
        'password_ct',
        'password_iv',
        'password_tag',
        'password_dek_wrapped',
        'password_kek_id',
        'password_enc_version',
        'auth_method',
        'oauth_provider',
      ])
      .where('id', '=', c.mailboxId)
      .executeTakeFirst();
    if (!row || row.status !== 'active') return null;
    try {
      const password = await openField(
        deps.kms,
        {
          ciphertext: row.password_ct,
          iv: row.password_iv,
          tag: row.password_tag,
          wrappedDek: row.password_dek_wrapped,
          keyId: row.password_kek_id,
          version: row.password_enc_version,
        },
        aadFor(c.tenantId.toLowerCase(), row.company_id, row.id, fieldOf(row.auth_method)),
      );
      return { row: row as MailboxRow, password };
    } catch {
      // DecryptionError or an unknown KMS key: the stored secret cannot be opened (fail closed).
      return { row: row as MailboxRow, password: null };
    }
  });
  if (!loaded) return { ...base, status: 'skipped' };
  if (loaded.password === null) {
    await record(db, c.tenantId, c.mailboxId, now(), 'credentials_unreadable');
    return { ...base, status: 'failed', error: 'credentials_unreadable' };
  }
  const { row, password } = loaded;

  // 1b. OAuth: a fresh access token (network, outside any transaction); keep a rotated refresh
  // token (ADR-0105 rules 6–7). The IMAP host is the provider's, never the stored one.
  let accessToken: string | null = null;
  let endpoint = { host: row.host, port: row.port };
  if (row.auth_method === 'oauth2') {
    const provider = row.oauth_provider;
    if (!provider || !deps.oauth) {
      await record(db, c.tenantId, row.id, now(), 'connect_failed');
      return { ...base, status: 'failed', error: 'connect_failed' };
    }
    const spec = MAILBOX_OAUTH_PROVIDERS[provider];
    endpoint = { host: spec.imapHost, port: spec.imapPort };
    try {
      const t = await refreshAccessToken(deps.oauth, provider, password);
      accessToken = t.accessToken;
      if (t.refreshToken !== null && t.refreshToken !== password) {
        await rotateRefreshToken(db, deps.kms, c.tenantId, row, t.refreshToken);
      }
    } catch (e) {
      if (!(e instanceof MailboxOAuthError)) throw e;
      const kind = e.kind === 'auth_failed' ? 'auth_failed' : 'connect_failed';
      await record(db, c.tenantId, row.id, now(), kind);
      return { ...base, status: 'failed', error: kind };
    }
  }
  const connector = (deps.connector ?? ((m) => tlsConnector(m.host, m.port)))(endpoint);

  // 2. Talk to the server; each message is committed on its own.
  let client: ImapClient | null = null;
  let ingested = 0;
  let replayed = 0;
  const refused: { uid: number; reason: 'too_large' | 'invalid_email' }[] = [];
  let remaining = false;
  try {
    client = await ImapClient.connect(connector, {
      maxLiteralBytes: maxBytes,
      ...(deps.commandTimeoutMs ? { commandTimeoutMs: deps.commandTimeoutMs } : {}),
    });
    if (accessToken !== null) await client.authenticateXOAuth2(row.username, accessToken);
    else await client.login(row.username, password);
    const box = await client.examine(row.folder);
    const sameValidity =
      row.uidvalidity !== null && Number.parseInt(row.uidvalidity, 10) === box.uidValidity;
    const cursor = sameValidity ? Number.parseInt(row.last_uid, 10) : 0;
    const all = await client.searchUidsAfter(cursor);
    const uids = all.slice(0, maxPerPoll);
    remaining = all.length > uids.length;
    const sizes = await client.fetchSizes(uids);
    for (const uid of uids) {
      const size = sizes.get(uid);
      if (size === undefined) continue; // expunged meanwhile
      if (size > maxBytes) {
        const r = await step(db, c.tenantId, row.id, box.uidValidity, uid, () =>
          Promise.resolve({ refused: true }),
        );
        if (r.done) refused.push({ uid, reason: 'too_large' });
        continue;
      }
      const raw = await client.fetchMessage(uid);
      const r = await step(db, c.tenantId, row.id, box.uidValidity, uid, async (trx, companyId) => {
        await sql`SAVEPOINT bill_inbox_ingest`.execute(trx);
        try {
          const item = await ingestBillEmail(trx, { companyId, raw });
          await sql`RELEASE SAVEPOINT bill_inbox_ingest`.execute(trx);
          return { refused: false, replayed: item.replayed };
        } catch (e) {
          if (!(e instanceof InboxError)) throw e;
          await sql`ROLLBACK TO SAVEPOINT bill_inbox_ingest`.execute(trx);
          return { refused: true };
        }
      });
      if (!r.done) continue;
      if (r.refused) refused.push({ uid, reason: 'invalid_email' });
      else if (r.replayed) replayed += 1;
      else ingested += 1;
    }
    await client.logout();
  } catch (e) {
    client?.close();
    if (!(e instanceof ImapError)) throw e;
    await record(db, c.tenantId, row.id, now(), e.kind);
    return {
      mailboxId: row.id,
      status: 'failed',
      error: e.kind,
      ingested,
      replayed,
      refused,
      remaining,
    };
  }
  await record(db, c.tenantId, row.id, now(), null);
  return { mailboxId: row.id, status: 'ok', ingested, replayed, refused, remaining };
}

/** Poll every active mailbox of one tenant (the `ap.inbox.poll` job). */
export async function pollTenantMailboxes(
  db: Kysely<Database>,
  deps: PollDeps,
  tenantId: string,
): Promise<PollResult[]> {
  const ids = await withTenant(db, tenantId, (trx) =>
    trx
      .selectFrom('app.bill_inbox_mailbox')
      .select('id')
      .where('status', '=', 'active')
      .orderBy('id')
      .execute(),
  );
  const out: PollResult[] = [];
  for (const { id } of ids) out.push(await pollBillsMailbox(db, deps, { tenantId, mailboxId: id }));
  return out;
}
