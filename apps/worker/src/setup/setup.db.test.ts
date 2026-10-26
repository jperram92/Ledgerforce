/**
 * SS-PLAT-85 — first start of a self-hosted install (T-0094, design §6.3, RQ-0041, ADR-0037).
 * `runSetup` applies the migrations and installs the queue as lf_migrator, refuses unsafe roles,
 * then — as lf_app, under the new tenant's RLS — creates the tenant and invites the first Owner
 * bound to the IdP subject (ADR-0027 invite model), and prints a one-time owner setup link with a
 * unique one-time password. Run again, it changes nothing and prints no password; with `reissue`
 * it issues a new one only while the Owner has not completed the first sign-in.
 */
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '@ledgerforce/db/testing';
import { OUTBOX_QUEUE } from '@ledgerforce/outbox';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertRole, oneTimePassword, runSetup, type IdentityAdmin, type SetupOptions } from './setup.ts';

const MIGRATIONS = readdirSync(
  resolve(import.meta.dirname, '..', '..', '..', '..', 'packages', 'db', 'migrations'),
).filter((f) => /^\d{4}_.*\.sql$/.test(f));

class FakeIdp implements IdentityAdmin {
  users = new Map<string, string>();
  passwords: { subject: string; password: string }[] = [];
  ensureUser(u: { email: string; displayName: string }) {
    const key = u.email.toLowerCase();
    const existing = this.users.get(key);
    if (existing) return Promise.resolve({ subject: existing, created: false });
    const subject = `kc-${String(this.users.size + 1)}`;
    this.users.set(key, subject);
    return Promise.resolve({ subject, created: true });
  }
  setOneTimePassword(subject: string, password: string) {
    this.passwords.push({ subject, password });
    return Promise.resolve();
  }
}

let tdb: TestDatabase;
const idp = new FakeIdp();
let opts: SetupOptions;

const run = async (extra: Partial<SetupOptions> = {}) => {
  const lines: string[] = [];
  const outcome = await runSetup({ ...opts, ...extra }, idp, (l) => lines.push(l));
  return { outcome, out: lines.join('\n') };
};

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: false });
  opts = {
    migratorUrl: tdb.url('lf_migrator'),
    appUrl: tdb.url('lf_app'),
    publicUrl: 'http://ledgerforce.localhost:8080',
    issuer: 'http://ledgerforce.localhost:8080/realms/ledgerforce',
    tenant: { slug: 'harbour-co', name: 'Harbour Co' },
    owner: { email: 'owner@example.test', displayName: 'Olivia Owner' },
  };
});
afterAll(async () => {
  await tdb?.close();
});

describe('SS-PLAT-85 first-start setup', () => {
  it('SS-PLAT-85 refuses to run with the roles swapped or with a superuser', async () => {
    await expect(run({ migratorUrl: tdb.url('lf_app') })).rejects.toThrow(/lf_migrator/);
    await expect(run({ appUrl: tdb.url('lf_migrator') })).rejects.toThrow(/lf_app/);
    await expect(run({ appUrl: tdb.url('superuser') })).rejects.toThrow(/lf_app/);
    const { rows } = await tdb.admin.query(
      `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tablename = 'schema_migrations'`,
    );
    expect(rows[0]).toEqual({ n: 0 });
  });

  it('SS-PLAT-85 refuses a role with BYPASSRLS or SUPERUSER, even under the expected name', async () => {
    const role = `lf_unsafe_${randomBytes(4).toString('hex')}`;
    const pw = randomBytes(12).toString('hex');
    await tdb.admin.query(`CREATE ROLE ${role} LOGIN BYPASSRLS PASSWORD '${pw}'`);
    try {
      const u = new URL(tdb.url('lf_app'));
      u.username = role;
      u.password = pw;
      await expect(assertRole(u.href, role)).rejects.toThrow(/BYPASSRLS/);
      await expect(assertRole(tdb.url('superuser'), new URL(tdb.url('superuser')).username)).rejects.toThrow(
        /superuser/i,
      );
      await expect(assertRole(tdb.url('lf_app'), 'lf_app')).resolves.toBeUndefined();
    } finally {
      await tdb.admin.query(`DROP ROLE ${role}`);
    }
  });

  it('SS-PLAT-85 first run: migrations and queue as lf_migrator, owner invited, one-time link printed', async () => {
    const { outcome, out } = await run();
    expect(outcome.kind).toBe('provisioned');

    const applied = await tdb.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.schema_migrations`,
    );
    expect(applied.rows[0]?.n).toBe(MIGRATIONS.length);
    const owners = await tdb.admin.query<{ owner: string }>(
      `SELECT DISTINCT tableowner AS owner FROM pg_tables WHERE schemaname IN ('app','audit','pgboss')`,
    );
    expect(owners.rows.map((r) => r.owner)).toEqual(['lf_migrator']);
    const q = await tdb.admin.query(`SELECT name FROM pgboss.queue WHERE name = $1`, [OUTBOX_QUEUE]);
    expect(q.rowCount).toBe(1);

    const t = await tdb.admin.query<{ id: string; name: string; status: string }>(
      `SELECT id, name, status FROM app.tenant WHERE slug = 'harbour-co'`,
    );
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]).toMatchObject({ name: 'Harbour Co', status: 'active' });
    const tenantId = t.rows[0]?.id;
    const u = await tdb.admin.query(
      `SELECT email, display_name, idp_issuer, idp_subject, status, invited_by
         FROM app.app_user WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(u.rows).toEqual([
      {
        email: 'owner@example.test',
        display_name: 'Olivia Owner',
        idp_issuer: 'http://ledgerforce.localhost:8080/realms/ledgerforce',
        idp_subject: 'kc-1',
        status: 'invited',
        invited_by: null,
      },
    ]);
    const r = await tdb.admin.query(
      `SELECT role, granted_by, revoked_at FROM app.user_role WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(r.rows).toEqual([{ role: 'owner', granted_by: null, revoked_at: null }]);
    const audit = await tdb.admin.query<{ actor_type: string; action: string }>(
      `SELECT actor_type, action FROM audit.audit_log WHERE tenant_id = $1 ORDER BY id`,
      [tenantId],
    );
    expect(audit.rows).toEqual([
      { actor_type: 'system', action: 'tenant.provisioned' },
      { actor_type: 'system', action: 'user.invited' },
    ]);

    expect(idp.passwords).toHaveLength(1);
    const pw = idp.passwords[0]?.password ?? '';
    expect(idp.passwords[0]?.subject).toBe('kc-1');
    expect(out).toContain('Owner setup link: http://ledgerforce.localhost:8080/t/harbour-co/auth/login');
    expect(out).toContain('Sign in as: owner@example.test');
    expect(out).toContain(`One-time password: ${pw}`);
    expect(out).toMatch(/authenticator app/);
  });

  it('SS-PLAT-85 run again: nothing changes and no password is printed', async () => {
    const { outcome, out } = await run();
    expect(outcome.kind).toBe('pending');
    expect(idp.passwords).toHaveLength(1);
    expect(out).not.toMatch(/One-time password/);
    expect(out).toMatch(/LF_SETUP_REISSUE=1/);
    const counts = await tdb.admin.query(
      `SELECT (SELECT count(*) FROM app.tenant)::int AS t, (SELECT count(*) FROM app.app_user)::int AS u,
              (SELECT count(*) FROM app.user_role)::int AS r`,
    );
    expect(counts.rows[0]).toEqual({ t: 1, u: 1, r: 1 });
  });

  it('SS-PLAT-85 reissue while the Owner is still invited: a new, different one-time password', async () => {
    const { outcome, out } = await run({ reissue: true });
    expect(outcome.kind).toBe('reissued');
    expect(idp.passwords).toHaveLength(2);
    const [a, b] = idp.passwords;
    expect(b?.subject).toBe('kc-1');
    expect(b?.password).not.toBe(a?.password);
    expect(out).toContain(`One-time password: ${b?.password ?? ''}`);
    const audit = await tdb.admin.query(
      `SELECT action FROM audit.audit_log WHERE action = 'user.setup_reissued'`,
    );
    expect(audit.rowCount).toBe(1);
  });

  it('SS-PLAT-85 once the Owner has signed in, reissue is refused and nothing is printed', async () => {
    await tdb.admin.query(`UPDATE app.app_user SET status = 'active'`);
    const { outcome, out } = await run({ reissue: true });
    expect(outcome.kind).toBe('complete');
    expect(idp.passwords).toHaveLength(2);
    expect(out).not.toMatch(/One-time password/);
    expect(out).toMatch(/already completed/);
  });

  it('SS-PLAT-85 refuses bad input before touching anything', async () => {
    await expect(run({ tenant: { slug: 'Bad Slug!', name: 'x' } })).rejects.toThrow(/LF_TENANT_SLUG/);
    await expect(run({ owner: { email: 'not-an-email', displayName: 'x' } })).rejects.toThrow(
      /LF_OWNER_EMAIL/,
    );
    await expect(run({ publicUrl: 'ledgerforce.localhost' })).rejects.toThrow(/LF_PUBLIC_URL/);
  });
});

describe('SS-PLAT-85 one-time password', () => {
  it('SS-PLAT-85 is long, random and meets the realm policy (12+ chars, not the e-mail)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const p = oneTimePassword();
      expect(p).toMatch(/^[A-HJ-NP-Za-km-z2-9]{5}(-[A-HJ-NP-Za-km-z2-9]{5}){4}$/);
      seen.add(p);
    }
    expect(seen.size).toBe(200);
  });

});
