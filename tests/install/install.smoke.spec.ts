/**
 * SS-PLAT-23 — Self-hosted compose install works (T-0094, design §6.3, RQ-0041, ADR-0037).
 *
 * Given a fresh machine with Docker, `docker compose up` (run by infra/compose/smoke.sh) builds
 * and starts postgres, keycloak, setup, api, worker and web. Then:
 *  - setup applied every migration and installed the queue as lf_migrator, and printed a one-time
 *    owner setup link with a one-time password;
 *  - the api and worker connect as lf_app, which is neither superuser nor BYPASSRLS;
 *  - the sign-in page renders; the setup link opens the realm's sign-in page;
 *  - the Owner signs in with the one-time password, enrols MFA, chooses a password and lands in
 *    LedgerForce (the realm's acr mapping satisfies the API's MFA rule, ADR-0025);
 *  - the one-time password then no longer works; Keycloak's admin paths are not public.
 *
 * Environment (set by smoke.sh): LF_INSTALL_PUBLIC_URL, LF_INSTALL_SETUP_LOG (setup's output),
 * LF_INSTALL_COMPOSE (JSON array: the `docker compose …` command for this stack),
 * LF_INSTALL_OWNER_EMAIL, LF_INSTALL_OWNER_NAME.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from '@ledgerforce/testing/evidence';
import { totp } from './totp.ts';

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set: run this spec through infra/compose/smoke.sh`);
  return v;
}

const ROOT = resolve(import.meta.dirname, '..', '..');
const MIGRATIONS = readdirSync(resolve(ROOT, 'packages/db/migrations')).filter((f) =>
  /^\d{4}_.*\.sql$/.test(f),
);

function psql(query: string): string[] {
  const compose = JSON.parse(need('LF_INSTALL_COMPOSE')) as string[];
  const [cmd = 'docker', ...args] = compose;
  const r = spawnSync(
    cmd,
    [
      ...args,
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'postgres',
      '-d',
      'ledgerforce',
      '-At',
      '-c',
      query,
    ],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr}`);
  return r.stdout.split('\n').filter((l) => l !== '');
}

interface SetupOutput {
  link: string;
  email: string;
  password: string;
}
function setupOutput(): SetupOutput {
  const log = readFileSync(need('LF_INSTALL_SETUP_LOG'), 'utf8');
  const link = /Owner setup link: (\S+)/.exec(log)?.[1];
  const email = /Sign in as: (\S+)/.exec(log)?.[1];
  const password = /One-time password: (\S+)/.exec(log)?.[1];
  if (!link || !email || !password) throw new Error('setup output has no owner setup link');
  return { link, email, password };
}

let mfaSecret = '';
const newPassword = `Owner-${randomBytes(9).toString('base64url')}`;

test.use({ evidenceTaskId: 'T-0094' });
test.describe.configure({ mode: 'serial' });

async function submit(page: Page): Promise<void> {
  await page.locator('[type=submit]').first().click();
}

test.describe('SS-PLAT-23 self-hosted compose install', () => {
  test('SS-PLAT-23: setup ran the migrations and queue install as lf_migrator and printed a one-time owner setup link', () => {
    const publicUrl = need('LF_INSTALL_PUBLIC_URL');
    const out = setupOutput();
    expect(out.link).toMatch(
      new RegExp(`^${publicUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/t/[a-z0-9-]+/auth/login$`),
    );
    expect(out.email).toBe(need('LF_INSTALL_OWNER_EMAIL').toLowerCase());
    expect(out.password).toMatch(/^[A-Za-z0-9]{5}(-[A-Za-z0-9]{5}){4}$/);

    expect(psql('SELECT count(*) FROM public.schema_migrations')).toEqual([
      String(MIGRATIONS.length),
    ]);
    expect(
      psql(
        `SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname IN ('app','audit','pgboss','public')`,
      ),
    ).toEqual(['lf_migrator']);
    expect(psql(`SELECT name FROM pgboss.queue WHERE name = 'outbox.deliver'`)).toEqual([
      'outbox.deliver',
    ]);
    expect(psql(`SELECT status FROM app.app_user`)).toEqual(['invited']);
  });

  test('SS-PLAT-23: api and worker connect as lf_app, which is not superuser and has no BYPASSRLS', () => {
    expect(
      psql(
        `SELECT rolname || ':' || rolsuper || ':' || rolbypassrls FROM pg_roles
          WHERE rolname IN ('lf_app','lf_migrator','keycloak') ORDER BY rolname`,
      ),
    ).toEqual(['keycloak:false:false', 'lf_app:false:false', 'lf_migrator:false:false']);
    const users = psql(
      `SELECT DISTINCT usename FROM pg_stat_activity
        WHERE datname = 'ledgerforce' AND backend_type = 'client backend' AND pid <> pg_backend_pid()`,
    );
    expect(users).toEqual(['lf_app']);
    expect(
      psql(
        `SELECT DISTINCT usename FROM pg_stat_activity
          WHERE datname = 'keycloak' AND backend_type = 'client backend'`,
      ),
    ).toEqual(['keycloak']);
  });

  test('SS-PLAT-23: the sign-in page renders', async ({ page, evidence }) => {
    await page.goto(need('LF_INSTALL_PUBLIC_URL'));
    await expect(page).toHaveURL(/\/sign-in/);
    await expect(page.getByRole('heading', { name: 'Sign in to LedgerForce' })).toBeVisible();
    await evidence('SS-PLAT-23', 'sign-in-page');
  });

  test('SS-PLAT-23: the setup link opens the organisation sign-in page', async ({
    page,
    evidence,
  }) => {
    const publicUrl = need('LF_INSTALL_PUBLIC_URL');
    await page.goto(setupOutput().link);
    await expect(page).toHaveURL(
      new RegExp(`^${publicUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/realms/ledgerforce/`),
    );
    await expect(page.locator('#username')).toBeVisible();
    await expect(page.locator('#password')).toBeVisible();
    await evidence('SS-PLAT-23', 'owner-setup-link-sign-in');
  });

  test('SS-PLAT-23: the Owner signs in once with the one-time password, enrols MFA and lands in LedgerForce', async ({
    page,
    evidence,
  }) => {
    const out = setupOutput();
    await page.goto(out.link);
    await page.locator('#username').fill(out.email);
    await page.locator('#password').fill(out.password);
    await submit(page);

    // Keycloak runs the first-login actions: MFA enrolment, then the Owner's own password.
    await expect(page.locator('#totp')).toBeVisible();
    // The evidence must not carry the authenticator secret: blur the QR code and the key.
    await page.addStyleTag({
      content:
        '#kc-totp-secret-qr-code, #kc-totp-secret-key, img[src^="data:image"] { filter: blur(12px) !important; }',
    });
    await evidence('SS-PLAT-23', 'owner-mfa-enrolment');
    await page.locator('#mode-manual').click();
    mfaSecret = ((await page.locator('#kc-totp-secret-key').textContent()) ?? '').trim();
    expect(mfaSecret).toMatch(/^[A-Z2-7 ]+$/);
    await page.locator('#totp').fill(totp(mfaSecret));
    await submit(page);

    await expect(page.locator('#password-new')).toBeVisible();
    await page.locator('#password-new').fill(newPassword);
    await page.locator('#password-confirm').fill(newPassword);
    await submit(page);

    await expect(page).toHaveURL(new RegExp(`^${need('LF_INSTALL_PUBLIC_URL')}/?$`));
    await expect(page.getByText(need('LF_INSTALL_OWNER_NAME')).first()).toBeVisible();
    await evidence('SS-PLAT-23', 'owner-signed-in');

    expect(psql(`SELECT status FROM app.app_user`)).toEqual(['active']);
    expect(
      psql(`SELECT action FROM audit.audit_log WHERE action LIKE 'user.%' ORDER BY id`),
    ).toContain('user.invited');
  });

  test('SS-PLAT-23: the one-time password no longer works', async ({ page, evidence }) => {
    const out = setupOutput();
    await page.goto(out.link);
    await page.locator('#username').fill(out.email);
    await page.locator('#password').fill(out.password);
    await submit(page);
    await expect(
      page.locator('#input-error, .kc-feedback-text, [id*=error]').first(),
    ).toBeVisible();
    await expect(page.locator('#totp')).toHaveCount(0);
    await expect(page.locator('#otp')).toHaveCount(0);
    await evidence('SS-PLAT-23', 'one-time-password-spent');
  });

  test('SS-PLAT-23: Keycloak admin and the master realm are not public; the tenant realm issuer is the public URL', async ({
    page,
  }) => {
    const publicUrl = need('LF_INSTALL_PUBLIC_URL');
    // Same-origin fetches from the page: the browser resolves *.localhost to this machine.
    await page.goto(`${publicUrl}/sign-in`);
    const probe = (path: string) =>
      page.evaluate(async (p) => {
        const r = await fetch(p, { redirect: 'manual' });
        return {
          status: r.status,
          body: r.headers.get('content-type')?.includes('json')
            ? ((await r.json()) as unknown)
            : null,
        };
      }, path);
    expect((await probe('/admin/')).status).toBe(404);
    expect((await probe('/admin/master/console/')).status).toBe(404);
    expect((await probe('/realms/master/.well-known/openid-configuration')).status).toBe(404);
    const disc = await probe('/realms/ledgerforce/.well-known/openid-configuration');
    expect(disc.status).toBe(200);
    const body = disc.body as { issuer: string; acr_values_supported: string[] };
    expect(body.issuer).toBe(`${publicUrl}/realms/ledgerforce`);
    expect(body.acr_values_supported).toContain('urn:ledgerforce:loa:mfa');
    expect(await probe('/health')).toEqual({ status: 200, body: { status: 'ok', db: 'ok' } });
  });
});
