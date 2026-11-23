/**
 * SS-PLAT-191 — OAuth bills mailboxes (T-0216, ADR-0105, RQ-0187, DL-0933, DL-0935) against a
 * real PostgreSQL as lf_app, the in-process fake IMAP server and recorded token responses (no
 * network). The refresh token is sealed with AAD field refresh_token; a poll refreshes, logs in
 * with XOAUTH2 at the provider's fixed host, re-seals a rotated refresh token in place; a refused
 * grant is auth_failed without moving the cursor; the database keeps password secrets write-once.
 */
import { withTenant } from '@ledgerforce/db';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { DecryptionError, LocalKeyringKms, openField } from '@ledgerforce/shared/crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  listBillsMailboxes,
  pollBillsMailbox,
  saveBillsMailbox,
  saveOAuthBillsMailbox,
  type PollDeps,
} from './inbox-mailbox.ts';
import type { MailboxOAuthConfig, MailboxOAuthProvider } from './mailbox-oauth.ts';
import { FakeImapServer } from './testing/fake-imap-server.ts';
import { recordedBody, recordedTokenFetch } from './testing/oauth-token-fetch.ts';

const kms = LocalKeyringKms.fromJson(
  JSON.stringify({ active: 'k1', keys: { k1: Buffer.alloc(32, 9).toString('base64') } }),
);
const FIRST_REFRESH = 'first-refresh-token-from-the-code-exchange';
const MS_ACCESS_2 = String(recordedBody('microsoft_refresh').access_token);
const MS_REFRESH_2 = String(recordedBody('microsoft_refresh').refresh_token);
const G_ACCESS_2 = String(recordedBody('google_refresh').access_token);
const MAIL = Buffer.from(
  'Message-ID: <oauth-1@paperco.example>\r\nFrom: Paper Co <accounts@paperco.example>\r\nTo: bills@harbour.example\r\nSubject: Invoice\r\nContent-Type: text/plain\r\n\r\nno attachment\r\n',
);

const OTHER_TENANT = '01900000-0000-7000-8000-000000021602';
let f: LedgerFixture;

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000021601');
  await withTenant(f.db, OTHER_TENANT, (trx) =>
    trx.insertInto('app.tenant').values({ id: OTHER_TENANT, name: 'Other Pty Ltd' }).execute(),
  );
}, 180_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

function oauthConfig(fetchFn: typeof fetch): MailboxOAuthConfig {
  return {
    redirectUri: 'https://books.harbour.example/api/setup/bills-mailbox/oauth/callback',
    microsoft: { clientId: 'ms-client', clientSecret: 'ms-secret' },
    google: { clientId: 'g-client', clientSecret: 'g-secret' },
    fetch: fetchFn,
  };
}

function fake(accessToken: string): FakeImapServer {
  return new FakeImapServer({
    user: 'bills@harbour.example',
    pass: 'not-used-by-oauth',
    accessToken,
    folders: { INBOX: { uidValidity: 77, messages: [] } },
  });
}

async function oauthMailbox(company: string, provider: MailboxOAuthProvider): Promise<string> {
  return f.inTenant((trx) =>
    saveOAuthBillsMailbox(trx, kms, company, {
      provider,
      username: 'bills@harbour.example',
      refreshToken: FIRST_REFRESH,
    }),
  );
}

interface SecretRow {
  id: string;
  host: string;
  port: number;
  auth_method: string;
  oauth_provider: string | null;
  status: string;
  last_uid: string;
  last_error: string | null;
  secret_rotated_at: Date | null;
  password_ct: Buffer;
  password_iv: Buffer;
  password_tag: Buffer;
  password_dek_wrapped: Buffer;
  password_kek_id: string;
  password_enc_version: number;
}

const rowOf = async (id: string): Promise<SecretRow> => {
  const r = (
    await f.admin.query<SecretRow>('SELECT * FROM app.bill_inbox_mailbox WHERE id = $1', [id])
  ).rows[0];
  if (!r) throw new Error('missing mailbox row');
  return r;
};

const open = (r: SecretRow, company: string, field: string) =>
  openField(
    kms,
    {
      ciphertext: r.password_ct,
      iv: r.password_iv,
      tag: r.password_tag,
      wrappedDek: r.password_dek_wrapped,
      keyId: r.password_kek_id,
      version: r.password_enc_version,
    },
    `lf-field-v1|${f.tenantId}|${company}|app.bill_inbox_mailbox|${r.id}|${field}`,
  );

describe('SS-PLAT-191: OAuth mailbox credentials are sealed as a refresh token', () => {
  it('SS-PLAT-191 the refresh token is sealed with AAD field refresh_token (not openable as a password), the host is the provider’s, reads carry no secret', async () => {
    const company = await f.addCompany('OAuth Co A');
    const id = await oauthMailbox(company, 'microsoft');
    const r = await rowOf(id);
    expect(r).toMatchObject({
      host: 'outlook.office365.com',
      port: 993,
      auth_method: 'oauth2',
      oauth_provider: 'microsoft',
      status: 'active',
      secret_rotated_at: null,
    });
    expect(r.password_ct.includes(Buffer.from(FIRST_REFRESH))).toBe(false);
    expect(await open(r, company, 'refresh_token')).toBe(FIRST_REFRESH);
    await expect(open(r, company, 'password')).rejects.toBeInstanceOf(DecryptionError);

    const [view] = await f.inTenant((trx) => listBillsMailboxes(trx, company));
    expect(view).toMatchObject({
      id,
      authMethod: 'oauth2',
      oauthProvider: 'microsoft',
      host: 'outlook.office365.com',
    });
    expect(JSON.stringify(view)).not.toContain(FIRST_REFRESH);

    // Connecting again (e.g. Google) supersedes the active mailbox, like a password change.
    const second = await oauthMailbox(company, 'google');
    expect((await rowOf(id)).status).toBe('superseded');
    expect(await rowOf(second)).toMatchObject({ host: 'imap.gmail.com', status: 'active' });
  });
});

describe('SS-PLAT-191: an OAuth mailbox polls with a refreshed access token', () => {
  it('SS-PLAT-191 Microsoft: refresh, XOAUTH2 at outlook.office365.com, one inbox item; the rotated refresh token is re-sealed in place and used next time', async () => {
    const company = await f.addCompany('OAuth Co B');
    const id = await oauthMailbox(company, 'microsoft');
    const s = fake(MS_ACCESS_2);
    s.deliver('INBOX', MAIL);
    const tok = recordedTokenFetch();
    tok.queue('microsoft_refresh', 'microsoft_refresh');
    const hosts: string[] = [];
    const deps: PollDeps = {
      kms,
      oauth: oauthConfig(tok.fetch),
      connector: (m) => {
        hosts.push(`${m.host}:${String(m.port)}`);
        return () => s.connect();
      },
    };
    const first = await pollBillsMailbox(f.db, deps, { tenantId: f.tenantId, mailboxId: id });
    expect(first).toMatchObject({ status: 'ok', ingested: 1 });
    expect(hosts).toEqual(['outlook.office365.com:993']);
    expect(tok.seen[0]?.form.refresh_token).toBe(FIRST_REFRESH);
    expect(s.commands.some((c) => c.startsWith('AUTHENTICATE XOAUTH2 '))).toBe(true);
    expect(s.commands.some((c) => c.startsWith('LOGIN'))).toBe(false);

    const r = await rowOf(id);
    expect(await open(r, company, 'refresh_token')).toBe(MS_REFRESH_2);
    expect(r.secret_rotated_at).not.toBeNull();
    expect(r.last_error).toBeNull();

    const again = await pollBillsMailbox(f.db, deps, { tenantId: f.tenantId, mailboxId: id });
    expect(again).toMatchObject({ status: 'ok', ingested: 0 });
    expect(tok.seen[1]?.form.refresh_token).toBe(MS_REFRESH_2);
    // The same refresh token again: nothing to rotate, the row is not rewritten.
    expect((await rowOf(id)).secret_rotated_at?.getTime()).toBe(r.secret_rotated_at?.getTime());
  });

  it('SS-PLAT-191 Google: a refresh without a new refresh token keeps the sealed one', async () => {
    const company = await f.addCompany('OAuth Co C');
    const id = await oauthMailbox(company, 'google');
    const s = fake(G_ACCESS_2);
    const tok = recordedTokenFetch();
    tok.queue('google_refresh');
    const res = await pollBillsMailbox(
      f.db,
      { kms, oauth: oauthConfig(tok.fetch), connector: () => () => s.connect() },
      { tenantId: f.tenantId, mailboxId: id },
    );
    expect(res).toMatchObject({ status: 'ok', ingested: 0 });
    expect(tok.seen[0]?.url).toBe('https://oauth2.googleapis.com/token');
    const r = await rowOf(id);
    expect(r.secret_rotated_at).toBeNull();
    expect(await open(r, company, 'refresh_token')).toBe(FIRST_REFRESH);
  });

  it('SS-PLAT-191 a revoked grant (invalid_grant) is auth_failed: no IMAP connection, cursor unchanged, no provider text stored', async () => {
    const company = await f.addCompany('OAuth Co D');
    const id = await oauthMailbox(company, 'microsoft');
    const s = fake(MS_ACCESS_2);
    s.deliver('INBOX', MAIL);
    const tok = recordedTokenFetch();
    tok.queue('microsoft_invalid_grant', 'server_error');
    const deps: PollDeps = {
      kms,
      oauth: oauthConfig(tok.fetch),
      connector: () => () => s.connect(),
    };
    const res = await pollBillsMailbox(f.db, deps, { tenantId: f.tenantId, mailboxId: id });
    expect(res).toMatchObject({ status: 'failed', error: 'auth_failed', ingested: 0 });
    expect(s.connections).toBe(0);
    let r = await rowOf(id);
    expect(r.last_error).toBe('auth_failed');
    expect(r.last_uid).toBe('0');
    // A provider outage is connect_failed (the next poll retries).
    const down = await pollBillsMailbox(f.db, deps, { tenantId: f.tenantId, mailboxId: id });
    expect(down).toMatchObject({ status: 'failed', error: 'connect_failed' });
    r = await rowOf(id);
    expect(r.last_error).toBe('connect_failed');
    expect(await open(r, company, 'refresh_token')).toBe(FIRST_REFRESH);
  });

  it('SS-PLAT-191 a wrong access token at the IMAP server is auth_failed; a worker without OAuth configuration records connect_failed', async () => {
    const company = await f.addCompany('OAuth Co E');
    const id = await oauthMailbox(company, 'microsoft');
    const s = fake('a-different-access-token');
    const tok = recordedTokenFetch();
    tok.queue('microsoft_refresh');
    const res = await pollBillsMailbox(
      f.db,
      { kms, oauth: oauthConfig(tok.fetch), connector: () => () => s.connect() },
      { tenantId: f.tenantId, mailboxId: id },
    );
    expect(res).toMatchObject({ status: 'failed', error: 'auth_failed' });
    const none = await pollBillsMailbox(
      f.db,
      { kms, connector: () => () => s.connect() },
      { tenantId: f.tenantId, mailboxId: id },
    );
    expect(none).toMatchObject({ status: 'failed', error: 'connect_failed' });
  });
});

describe('SS-PLAT-191: mailbox secrets stay write-once except an OAuth rotation (migration 0082, reserved 0084)', () => {
  const NEW_CT = Buffer.from([1, 2]);
  const rotate = (id: string, tenant = f.tenantId) =>
    withTenant(f.db, tenant, async (trx) => {
      const r = await sql<{ ok: boolean }>`SELECT app.rotate_bill_inbox_refresh_token(
          ${id}::uuid, ${NEW_CT}, ${Buffer.alloc(12)}, ${Buffer.alloc(16)},
          ${Buffer.alloc(60)}, 'k1', 1::smallint) AS ok`.execute(trx);
      return r.rows[0]?.ok;
    });

  it('SS-PLAT-191 lf_app has no UPDATE on secret or identity columns; the rotation function changes only an active OAuth row of its own tenant', async () => {
    const company = await f.addCompany('OAuth Co F');
    const pw = await f.inTenant((trx) =>
      saveBillsMailbox(trx, kms, company, {
        host: 'imap.harbour.example',
        username: 'bills@harbour.example',
        password: 'pw-1',
      }),
    );
    const old = await oauthMailbox(company, 'google');
    const active = await oauthMailbox(company, 'microsoft');
    const stmts = [
      sql`UPDATE app.bill_inbox_mailbox SET password_ct = ${NEW_CT} WHERE id = ${active}::uuid`,
      sql`UPDATE app.bill_inbox_mailbox SET secret_rotated_at = now() WHERE id = ${active}::uuid`,
      sql`UPDATE app.bill_inbox_mailbox SET host = 'evil.example' WHERE id = ${active}::uuid`,
      sql`UPDATE app.bill_inbox_mailbox SET auth_method = 'password', oauth_provider = NULL WHERE id = ${active}::uuid`,
    ];
    for (const stmt of stmts) {
      await expect(f.inTenant((trx) => stmt.execute(trx))).rejects.toThrow(/permission denied/);
    }
    expect(await rotate(pw)).toBe(false);
    expect(await rotate(old)).toBe(false);
    // Another tenant cannot rotate this tenant's mailbox (FORCE RLS filters the definer too).
    expect(await rotate(active, OTHER_TENANT)).toBe(false);
    expect((await rowOf(active)).secret_rotated_at).toBeNull();
    expect(await rotate(active)).toBe(true);
    const r = await rowOf(active);
    expect(r.password_ct.equals(NEW_CT)).toBe(true);
    expect(r.secret_rotated_at).not.toBeNull();
    expect((await rowOf(pw)).password_ct.equals(NEW_CT)).toBe(false);
  });

  it('SS-PLAT-191 the trigger refuses a secret change on a password row or without a new secret_rotated_at, for every role (defence in depth)', async () => {
    const company = await f.addCompany('OAuth Co G');
    const pw = await f.inTenant((trx) =>
      saveBillsMailbox(trx, kms, company, {
        host: 'imap.harbour.example',
        username: 'bills@harbour.example',
        password: 'pw-2',
      }),
    );
    await expect(
      f.admin.query(
        'UPDATE app.bill_inbox_mailbox SET password_ct = $2, secret_rotated_at = now() WHERE id = $1',
        [pw, NEW_CT],
      ),
    ).rejects.toThrow(/write-once/);
    const active = await oauthMailbox(company, 'microsoft');
    await expect(
      f.admin.query('UPDATE app.bill_inbox_mailbox SET password_ct = $2 WHERE id = $1', [
        active,
        NEW_CT,
      ]),
    ).rejects.toThrow(/secret_rotated_at/);
  });
});
