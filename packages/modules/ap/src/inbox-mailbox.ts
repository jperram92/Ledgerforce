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
}

const HOST = /^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/;
const FOLDER = /^[ -~]{1,255}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

const aadFor = (tenantId: string, companyId: string, id: string) =>
  `lf-field-v1|${tenantId}|${companyId}|app.bill_inbox_mailbox|${id}|password`;

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
  if (username.length === 0 || username.length > 320 || CONTROL.test(username)) {
    throw new BillsMailboxError('username must be 1-320 characters without control characters');
  }
  if (
    input.password.length === 0 ||
    input.password.length > 1024 ||
    /[\r\n\0]/.test(input.password)
  ) {
    throw new BillsMailboxError('password must be 1-1024 characters without CR, LF or NUL');
  }
  if (!FOLDER.test(folder)) throw new BillsMailboxError('folder must be printable ASCII');
  const t = await sql<{ tenant_id: string | null }>`
    SELECT nullif(current_setting('app.tenant_id', true), '') AS tenant_id`.execute(trx);
  const tenantId = t.rows[0]?.tenant_id;
  if (!tenantId) throw new Error('saveBillsMailbox must run inside a tenant transaction');
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
      password_ct: sealed.ciphertext,
      password_iv: sealed.iv,
      password_tag: sealed.tag,
      password_dek_wrapped: sealed.wrappedDek,
      password_kek_id: sealed.keyId,
      password_enc_version: sealed.version,
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
        aadFor(c.tenantId.toLowerCase(), row.company_id, row.id),
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
  const connector = (deps.connector ?? ((m) => tlsConnector(m.host, m.port)))({
    host: row.host,
    port: row.port,
  });

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
    await client.login(row.username, password);
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
