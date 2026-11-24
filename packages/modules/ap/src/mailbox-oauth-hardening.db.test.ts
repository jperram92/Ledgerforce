/**
 * T-0243 — bills mailbox OAuth2 hardening (security review r12, RQ-0190, ADR-0108) against a real
 * PostgreSQL as lf_app, recorded token responses (no network).
 *
 * - SS-PLAT-196: the callback consumes the pre-authorization in one committed transaction,
 *   exchanges the code with no transaction open, then saves and audits in a second one.
 * - SS-PLAT-197: a rotated refresh token whose re-seal fails is retried; if it keeps failing the
 *   poll stops before using the access token and the mailbox shows token_rotation_failed.
 * - SS-PLAT-198: the PKCE verifier is cleared when the request is consumed, cancelled or expired
 *   (write-once-to-NULL for every role); the rotation function's owner, SECURITY DEFINER flag,
 *   pinned search_path and grants are what migration 0083 says.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { withTenant, type Database } from '@ledgerforce/db';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { LocalKeyringKms, openField, type Kms } from '@ledgerforce/shared/crypto';
import { sql, type Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  clearStaleMailboxOAuthVerifiers,
  listBillsMailboxes,
  pollBillsMailbox,
  pollTenantMailboxes,
  saveOAuthBillsMailbox,
  type PollDeps,
} from './inbox-mailbox.ts';
import type { MailboxOAuthConfig } from './mailbox-oauth.ts';
import {
  cancelMailboxOAuth,
  completeMailboxOAuth,
  startMailboxOAuth,
} from './mailbox-oauth-connect.ts';
import { FakeImapServer } from './testing/fake-imap-server.ts';
import { recordedBody, recordedTokenFetch } from './testing/oauth-token-fetch.ts';

const kms = LocalKeyringKms.fromJson(
  JSON.stringify({ active: 'k1', keys: { k1: randomBytes(32).toString('base64') } }),
);
const FIRST_REFRESH = 'first-refresh-token-from-the-code-exchange';
const MS_ACCESS_2 = String(recordedBody('microsoft_refresh').access_token);
const MS_REFRESH_2 = String(recordedBody('microsoft_refresh').refresh_token);

let f: LedgerFixture;
const userId = randomUUID();
const sessionId = randomUUID();

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000024301');
  await f.admin.query(
    `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, 'fa@t0243.test', 'fa', 'active')`,
    [userId, f.tenantId],
  );
}, 180_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

const run = <T>(fn: (trx: Transaction<Database>) => Promise<T>) => withTenant(f.db, f.tenantId, fn);

function config(fetchFn: typeof fetch): MailboxOAuthConfig {
  return {
    redirectUri: 'https://books.harbour.example/api/setup/bills-mailbox/oauth/callback',
    microsoft: { clientId: 'ms-client', clientSecret: 'ms-secret' },
    fetch: fetchFn,
  };
}

async function start(company: string, cfg: MailboxOAuthConfig) {
  const started = await f.inTenant((trx) =>
    startMailboxOAuth(trx, cfg, {
      companyId: company,
      provider: 'microsoft',
      username: 'bills@harbour.example',
      userId,
      sessionId,
      now: new Date(),
    }),
  );
  return {
    id: started.requestId,
    state: new URL(started.authorizationUrl).searchParams.get('state') ?? '',
  };
}

interface RequestRow {
  code_verifier: string | null;
  verifier_cleared_at: Date | null;
  consumed_at: Date | null;
}
const requestRow = async (id: string): Promise<RequestRow> => {
  const r = (
    await f.admin.query<RequestRow>(
      'SELECT code_verifier, verifier_cleared_at, consumed_at FROM app.bill_inbox_oauth_request WHERE id = $1',
      [id],
    )
  ).rows[0];
  if (!r) throw new Error('missing request row');
  return r;
};

/** lf_app backends of this database with an open transaction (the caller's own is the admin). */
const openAppTransactions = async () =>
  Number(
    (
      await f.admin.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_stat_activity
          WHERE datname = current_database() AND usename = 'lf_app' AND xact_start IS NOT NULL`,
      )
    ).rows[0]?.n,
  );

describe('SS-PLAT-196: the code exchange runs outside any database transaction', () => {
  it('SS-PLAT-196 while the provider answers slowly the request is already consumed (committed), its verifier cleared, and no lf_app transaction is open; the save and audit follow in a second transaction', async () => {
    const company = await f.addCompany('T0243 Co A');
    const tok = recordedTokenFetch();
    const cfg = config(tok.fetch);
    const req = await start(company, cfg);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let observed: { row: RequestRow; open: number } | null = null;
    tok.queue(async () => {
      observed = { row: await requestRow(req.id), open: await openAppTransactions() };
      await gate;
      return new Response(JSON.stringify(recordedBody('microsoft_code')), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const done = completeMailboxOAuth(run, kms, cfg, {
      state: req.state,
      code: 'code-1',
      userId,
      sessionId,
      now: new Date(),
    });
    // Let the exchange start, then look while it waits.
    await new Promise((r) => setTimeout(r, 200));
    release();
    const connected = await done;
    expect(observed).not.toBeNull();
    const seen = observed as unknown as { row: RequestRow; open: number };
    expect(seen.open).toBe(0);
    expect(seen.row.consumed_at).not.toBeNull();
    expect(seen.row.code_verifier).toBeNull();
    expect(seen.row.verifier_cleared_at).not.toBeNull();
    // The verifier still reached the provider (read from the consuming statement).
    expect(tok.seen[0]?.form.code_verifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);

    const [view] = await f.inTenant((trx) => listBillsMailboxes(trx, company));
    expect(view).toMatchObject({ id: connected.mailboxId, status: 'active', authMethod: 'oauth2' });
    const audit = await f.admin.query<{ entity_id: string }>(
      `SELECT entity_id FROM audit.audit_log WHERE tenant_id = $1 AND action = 'ap.bills_mailbox.oauth_connected' AND entity_id = $2`,
      [f.tenantId, connected.mailboxId],
    );
    expect(audit.rows).toHaveLength(1);
  });

  it('SS-PLAT-196 a refused exchange leaves the request consumed (verifier cleared) and saves nothing', async () => {
    const company = await f.addCompany('T0243 Co B');
    const tok = recordedTokenFetch();
    const cfg = config(tok.fetch);
    const req = await start(company, cfg);
    tok.queue('microsoft_invalid_grant');
    await expect(
      completeMailboxOAuth(run, kms, cfg, {
        state: req.state,
        code: 'bad',
        userId,
        sessionId,
        now: new Date(),
      }),
    ).rejects.toMatchObject({ kind: 'auth_failed' });
    const row = await requestRow(req.id);
    expect(row.consumed_at).not.toBeNull();
    expect(row.code_verifier).toBeNull();
    expect(await f.inTenant((trx) => listBillsMailboxes(trx, company))).toHaveLength(0);
  });
});

/** A key service whose wrap fails `failures` times (a KMS outage while sealing). */
function flakyKms(failures: number): Kms & { wraps: number } {
  const k = {
    activeKeyId: kms.activeKeyId,
    wraps: 0,
    async wrap(dek: Buffer, aad: string) {
      k.wraps += 1;
      if (k.wraps <= failures) throw new Error('kms unavailable');
      return kms.wrap(dek, aad);
    },
    unwrap: (wrapped: Buffer, keyId: string, aad: string) => kms.unwrap(wrapped, keyId, aad),
  };
  return k;
}

describe('SS-PLAT-197: a failed re-seal of a rotated refresh token is retried or surfaced', () => {
  const fake = () =>
    new FakeImapServer({
      user: 'bills@harbour.example',
      pass: 'unused',
      accessToken: MS_ACCESS_2,
      folders: { INBOX: { uidValidity: 7, messages: [] } },
    });

  const mailbox = (company: string) =>
    f.inTenant((trx) =>
      saveOAuthBillsMailbox(trx, kms, company, {
        provider: 'microsoft',
        username: 'bills@harbour.example',
        refreshToken: FIRST_REFRESH,
      }),
    );

  const sealedToken = async (id: string, company: string) => {
    const r = (
      await f.admin.query<{
        password_ct: Buffer;
        password_iv: Buffer;
        password_tag: Buffer;
        password_dek_wrapped: Buffer;
        password_kek_id: string;
        password_enc_version: number;
        secret_rotated_at: Date | null;
        secret_rotation_failed_at: Date | null;
      }>('SELECT * FROM app.bill_inbox_mailbox WHERE id = $1', [id])
    ).rows[0];
    if (!r) throw new Error('missing mailbox');
    return {
      token: await openField(
        kms,
        {
          ciphertext: r.password_ct,
          iv: r.password_iv,
          tag: r.password_tag,
          wrappedDek: r.password_dek_wrapped,
          keyId: r.password_kek_id,
          version: r.password_enc_version,
        },
        `lf-field-v1|${f.tenantId}|${company}|app.bill_inbox_mailbox|${id}|refresh_token`,
      ),
      rotatedAt: r.secret_rotated_at,
      failedAt: r.secret_rotation_failed_at,
    };
  };

  it('SS-PLAT-197 a transient key-service failure is retried and the rotated token is sealed', async () => {
    const company = await f.addCompany('T0243 Co C');
    const id = await mailbox(company);
    const s = fake();
    const tok = recordedTokenFetch();
    tok.queue('microsoft_refresh');
    const k = flakyKms(1);
    const deps: PollDeps = {
      kms: k,
      oauth: config(tok.fetch),
      connector: () => () => s.connect(),
    };
    const res = await pollBillsMailbox(f.db, deps, { tenantId: f.tenantId, mailboxId: id });
    expect(res).toMatchObject({ status: 'ok' });
    expect(k.wraps).toBe(2);
    const sealed = await sealedToken(id, company);
    expect(sealed.token).toBe(MS_REFRESH_2);
    expect(sealed.failedAt).toBeNull();
  });

  it('SS-PLAT-197 a lasting failure stops the poll before IMAP, keeps the old token and marks the mailbox token_rotation_failed; the next good rotation clears it', async () => {
    const company = await f.addCompany('T0243 Co D');
    const id = await mailbox(company);
    const s = fake();
    const tok = recordedTokenFetch();
    tok.queue('microsoft_refresh', 'microsoft_refresh');
    const broken: PollDeps = {
      kms: flakyKms(1000),
      oauth: config(tok.fetch),
      connector: () => () => s.connect(),
    };
    const res = await pollBillsMailbox(f.db, broken, { tenantId: f.tenantId, mailboxId: id });
    expect(res).toMatchObject({ status: 'failed', error: 'token_rotation_failed', ingested: 0 });
    expect(s.connections).toBe(0);
    const before = await sealedToken(id, company);
    expect(before.token).toBe(FIRST_REFRESH);
    expect(before.failedAt).not.toBeNull();
    const [view] = await f.inTenant((trx) => listBillsMailboxes(trx, company));
    expect(view?.secretRotationFailedAt).toBeInstanceOf(Date);

    const healthy: PollDeps = { ...broken, kms };
    const again = await pollBillsMailbox(f.db, healthy, { tenantId: f.tenantId, mailboxId: id });
    expect(again).toMatchObject({ status: 'ok' });
    const after = await sealedToken(id, company);
    expect(after.token).toBe(MS_REFRESH_2);
    expect(after.failedAt).toBeNull();
  });
});

describe('SS-PLAT-198: the PKCE verifier is cleared once it cannot be used any more', () => {
  it('SS-PLAT-198 a cancelled request loses its verifier; an expired one is cleared by the tenant poll sweep; an unexpired unused one keeps it', async () => {
    const company = await f.addCompany('T0243 Co E');
    const cfg = config(recordedTokenFetch().fetch);
    const cancelled = await start(company, cfg);
    await f.inTenant((trx) =>
      cancelMailboxOAuth(trx, { state: cancelled.state, userId, sessionId, now: new Date() }),
    );
    expect(await requestRow(cancelled.id)).toMatchObject({ code_verifier: null });

    const expired = await start(company, cfg);
    await f.admin.query(
      `UPDATE app.bill_inbox_oauth_request
          SET created_at = created_at - interval '11 minutes', expires_at = expires_at - interval '11 minutes'
        WHERE id = $1`,
      [expired.id],
    );
    const live = await start(company, cfg);
    await pollTenantMailboxes(f.db, { kms }, f.tenantId);
    const e = await requestRow(expired.id);
    expect(e.code_verifier).toBeNull();
    expect(e.verifier_cleared_at).not.toBeNull();
    expect(e.consumed_at).toBeNull();
    expect((await requestRow(live.id)).code_verifier).not.toBeNull();
    // Nothing left to clear.
    expect(await f.inTenant((trx) => clearStaleMailboxOAuthVerifiers(trx))).toBe(0);
  });

  it('SS-PLAT-198 the verifier is write-once-to-NULL for every role: no new value, no clearing of a live request, no insert without one', async () => {
    const company = await f.addCompany('T0243 Co F');
    const live = await start(company, config(recordedTokenFetch().fetch));
    const other = 'A'.repeat(43);
    await expect(
      f.inTenant((trx) =>
        sql`UPDATE app.bill_inbox_oauth_request SET code_verifier = ${other}
             WHERE id = ${live.id}::uuid`.execute(trx),
      ),
    ).rejects.toThrow(/verifier/);
    await expect(
      f.admin.query(
        'UPDATE app.bill_inbox_oauth_request SET code_verifier = NULL, verifier_cleared_at = now() WHERE id = $1',
        [live.id],
      ),
    ).rejects.toThrow(/verifier/);
    await expect(
      f.admin.query(
        `INSERT INTO app.bill_inbox_oauth_request
           (id, tenant_id, company_id, state_sha256, code_verifier, provider, username, user_id, session_id, expires_at)
         VALUES ($1, $2, $3, $4, NULL, 'microsoft', 'x@y.example', $5, $6, now() + interval '5 minutes')`,
        [randomUUID(), f.tenantId, company, 'a'.repeat(64), userId, sessionId],
      ),
    ).rejects.toThrow(/verifier/);
    expect((await requestRow(live.id)).code_verifier).not.toBeNull();
  });
});

describe('SS-PLAT-198: the rotation function is a narrow, pinned SECURITY DEFINER', () => {
  it('SS-PLAT-198 owner lf_migrator, SECURITY DEFINER, search_path pinned to pg_catalog, pg_temp; EXECUTE for lf_app only (not PUBLIC)', async () => {
    const fn = (
      await f.admin.query<{
        owner: string;
        prosecdef: boolean;
        proconfig: string[] | null;
        public_exec: boolean;
        app_exec: boolean;
        provolatile: string;
      }>(
        `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig, p.provolatile,
                has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
                has_function_privilege('lf_app', p.oid, 'EXECUTE') AS app_exec
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'app' AND p.proname = 'rotate_bill_inbox_refresh_token'`,
      )
    ).rows;
    expect(fn).toHaveLength(1);
    expect(fn[0]).toEqual({
      owner: 'lf_migrator',
      prosecdef: true,
      proconfig: ['search_path=pg_catalog, pg_temp'],
      provolatile: 'v',
      public_exec: false,
      app_exec: true,
    });
    const acl = (
      await f.admin.query<{ grantee: string }>(
        `SELECT DISTINCT grantee::regrole::text AS grantee
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
                aclexplode(p.proacl) a
          WHERE n.nspname = 'app' AND p.proname = 'rotate_bill_inbox_refresh_token'
            AND a.privilege_type = 'EXECUTE' ORDER BY 1`,
      )
    ).rows.map((r) => r.grantee);
    expect(acl).toEqual(['lf_app', 'lf_migrator']);
  });

  it('SS-PLAT-198 the secret and verifier guard triggers are plain (not SECURITY DEFINER) and pin their search_path', async () => {
    const rows = (
      await f.admin.query<{ proname: string; prosecdef: boolean; proconfig: string[] | null }>(
        `SELECT p.proname, p.prosecdef, p.proconfig
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'app'
            AND p.proname IN ('bill_inbox_mailbox_secret_guard', 'bill_inbox_oauth_request_verifier_guard')
          ORDER BY p.proname`,
      )
    ).rows;
    expect(rows).toEqual([
      {
        proname: 'bill_inbox_mailbox_secret_guard',
        prosecdef: false,
        proconfig: ['search_path=pg_catalog, app'],
      },
      {
        proname: 'bill_inbox_oauth_request_verifier_guard',
        prosecdef: false,
        proconfig: ['search_path=pg_catalog, pg_temp'],
      },
    ]);
  });
});
