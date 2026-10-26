/**
 * SS-PLAT-86 — the self-hosted install contract (T-0094, RQ-0041, ADR-0037), checked without a
 * Docker daemon: pinned and non-root images, no secret in an image or in the compose file, each
 * secret only where it is needed, lf_app for the runtime and lf_migrator only for setup, health
 * checks and start order, the Keycloak realm's security settings and MFA mapping, the secret
 * generator, and the ignore rules that keep generated secrets out of git.
 * The running stack is proven by SS-PLAT-23 (tests/install/install.smoke.spec.ts).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT = resolve(import.meta.dirname, '..', '..');
const read = (p: string): string => readFileSync(resolve(ROOT, p), 'utf8');

const DIGEST = /^[a-z0-9./_-]+:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/;
const SECRET_NAME = /(PASSWORD|SECRET|TOKEN|PRIVATE_KEY)/i;

interface Stage {
  name: string;
  from: string;
  lines: string[];
}

function stages(dockerfile: string): Stage[] {
  const out: Stage[] = [];
  for (const raw of dockerfile.split('\n')) {
    const line = raw.trim();
    const m = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?$/i.exec(line);
    if (m) {
      out.push({ from: m[1] ?? '', name: m[2] ?? '', lines: [] });
      continue;
    }
    out.at(-1)?.lines.push(line);
  }
  return out;
}

/** USER in effect at the end of a stage (following FROM <stage> chains). */
function effectiveUser(all: Stage[], s: Stage): string | undefined {
  const own = s.lines.filter((l) => /^USER\s+/i.test(l)).at(-1);
  if (own) return own.replace(/^USER\s+/i, '');
  const base = all.find((b) => b.name === s.from);
  return base ? effectiveUser(all, base) : undefined;
}

const DOCKERFILES = ['infra/docker/Dockerfile', 'infra/docker/keycloak.Dockerfile'];

describe('SS-PLAT-86 images', () => {
  it('SS-PLAT-86 every base image is pinned by tag and digest', () => {
    for (const f of DOCKERFILES) {
      const all = stages(read(f));
      expect(all.length).toBeGreaterThan(1);
      for (const s of all) {
        if (all.some((b) => b.name === s.from)) continue;
        expect(s.from, `${f}: FROM ${s.from}`).toMatch(DIGEST);
      }
    }
  });

  it('SS-PLAT-86 every runtime target runs as a non-root user', () => {
    const app = stages(read('infra/docker/Dockerfile'));
    for (const target of ['api', 'worker', 'setup', 'web']) {
      const s = app.find((x) => x.name === target);
      expect(s, `target ${target}`).toBeDefined();
      const user = s ? effectiveUser(app, s) : undefined;
      expect(user, `USER of ${target}`).toBeDefined();
      expect(user).not.toMatch(/^(root|0)(:|$)/);
    }
    const kc = stages(read('infra/docker/keycloak.Dockerfile'));
    const last = kc.at(-1);
    expect(last && effectiveUser(kc, last)).toMatch(/^[1-9][0-9]*$/);
  });

  it('SS-PLAT-86 no image bakes a secret (no ENV/ARG secret, no secrets folder copied)', () => {
    for (const f of DOCKERFILES) {
      const lines = read(f).split('\n');
      lines.forEach((line, i) => {
        const m = /^\s*(ENV|ARG)\s+([A-Za-z0-9_]+)/i.exec(line);
        if (m?.[2]) expect(m[2], `${f}: ${line}`).not.toMatch(SECRET_NAME);
        expect(line, `${f}: ${line}`).not.toMatch(/^\s*(COPY|ADD)\b.*secrets/i);
        if (line.includes('/run/secrets/') && !line.trimStart().startsWith('#')) {
          // Only a BuildKit secret mount (never written to a layer) may read /run/secrets.
          const run = lines.slice(Math.max(0, i - 1), i + 1).join('\n');
          expect(run, `${f}: ${line}`).toMatch(/--mount=type=secret,id=[a-z_]+,required=false/);
        }
      });
    }
    const ignore = read('.dockerignore');
    for (const p of ['**/.env*', 'infra/compose/secrets', '.git', '**/node_modules', '.agent']) {
      expect(ignore.split('\n')).toContain(p);
    }
  });
});

type Service = {
  image?: string;
  build?: { context: string; dockerfile: string; target?: string };
  environment?: Record<string, string>;
  secrets?: string[];
  ports?: string[];
  depends_on?: Record<string, { condition: string }>;
  healthcheck?: { test: unknown };
  security_opt?: string[];
  cap_drop?: string[];
  restart?: string;
  read_only?: boolean;
  user?: string;
};
type Compose = {
  services: Record<string, Service>;
  secrets: Record<string, { file: string }>;
  volumes?: Record<string, unknown>;
};
const compose = parse(read('infra/compose/compose.yaml'), { merge: true }) as Compose;
const svc = (n: string): Service => {
  const s = compose.services[n];
  if (!s) throw new Error(`no service ${n}`);
  return s;
};

describe('SS-PLAT-86 compose stack', () => {
  it('SS-PLAT-86 has exactly the design §7.2 services plus the one-shot setup', () => {
    expect(Object.keys(compose.services).sort()).toEqual(
      ['api', 'keycloak', 'postgres', 'setup', 'web', 'worker'].sort(),
    );
  });

  it('SS-PLAT-86 images are pinned; app services build the shared Dockerfile targets', () => {
    expect(svc('postgres').image).toMatch(DIGEST);
    expect(svc('keycloak').build).toEqual({
      context: '../..',
      dockerfile: 'infra/docker/keycloak.Dockerfile',
    });
    for (const t of ['api', 'worker', 'setup', 'web']) {
      expect(svc(t).build).toEqual({
        context: '../..',
        dockerfile: 'infra/docker/Dockerfile',
        target: t,
      });
    }
  });

  it('SS-PLAT-86 secrets are files in the ignored secrets folder, never values in the file', () => {
    for (const [name, s] of Object.entries(compose.secrets)) {
      expect(s.file).toBe(`./secrets/${name}`);
    }
    for (const [name, s] of Object.entries(compose.services)) {
      for (const [k, v] of Object.entries(s.environment ?? {})) {
        if (!SECRET_NAME.test(k)) continue;
        if (k.endsWith('_FILE')) {
          expect(v, `${name}.${k}`).toMatch(/^\/run\/secrets\/[a-z_]+$/);
          expect(s.secrets, `${name} mounts ${v}`).toContain(v.replace('/run/secrets/', ''));
        } else {
          // Keycloak's own variables are filled from files by its entrypoint; none is set here.
          throw new Error(`${name}.${k} carries a secret in the compose file`);
        }
      }
    }
  });

  it('SS-PLAT-86 each secret reaches only the services that need it', () => {
    const holders = (secret: string) =>
      Object.entries(compose.services)
        .filter(([, s]) => (s.secrets ?? []).includes(secret))
        .map(([n]) => n)
        .sort();
    expect(Object.keys(compose.secrets).sort()).toEqual(
      [
        'keycloak_admin_client_secret',
        'keycloak_db_password',
        'lf_app_password',
        'lf_migrator_password',
        'oidc_client_secret',
        'postgres_password',
      ].sort(),
    );
    expect(holders('postgres_password')).toEqual(['postgres']);
    expect(holders('lf_migrator_password')).toEqual(['postgres', 'setup']);
    expect(holders('lf_app_password')).toEqual(['api', 'postgres', 'setup', 'worker']);
    expect(holders('keycloak_db_password')).toEqual(['keycloak', 'postgres']);
    expect(holders('oidc_client_secret')).toEqual(['api', 'keycloak']);
    expect(holders('keycloak_admin_client_secret')).toEqual(['keycloak', 'setup']);
    expect(svc('web').secrets ?? []).toEqual([]);
  });

  it('SS-PLAT-86 the runtime connects as lf_app; only setup holds the migrator password', () => {
    for (const n of ['api', 'worker']) {
      const env = svc(n).environment ?? {};
      expect(env['LF_APP_DB_PASSWORD_FILE']).toBe('/run/secrets/lf_app_password');
      expect(Object.keys(env).filter((k) => k.includes('MIGRATOR'))).toEqual([]);
      expect(env['LF_DATABASE_URL']).toBeUndefined();
    }
    expect(svc('setup').environment?.['LF_MIGRATOR_DB_PASSWORD_FILE']).toBe(
      '/run/secrets/lf_migrator_password',
    );
    expect(svc('setup').restart).toBe('no');
  });

  it('SS-PLAT-86 only the web origin is published, on loopback by default; the database and IdP are not', () => {
    expect(svc('postgres').ports).toBeUndefined();
    expect(svc('keycloak').ports).toBeUndefined();
    expect(svc('api').ports).toBeUndefined();
    expect(svc('web').ports).toEqual([
      '${LF_HTTP_BIND:-127.0.0.1}:${LF_HTTP_PORT:-8080}:${LF_HTTP_PORT:-8080}',
    ]);
  });

  it('SS-PLAT-86 start order: setup waits for a healthy database and IdP; api and worker wait for setup', () => {
    expect(svc('setup').depends_on).toEqual({
      postgres: { condition: 'service_healthy' },
      keycloak: { condition: 'service_healthy' },
    });
    for (const n of ['api', 'worker']) {
      expect(svc(n).depends_on?.['setup']).toEqual({
        condition: 'service_completed_successfully',
      });
    }
    expect(svc('web').depends_on).toEqual({
      api: { condition: 'service_healthy' },
      keycloak: { condition: 'service_healthy' },
    });
    for (const n of ['postgres', 'keycloak', 'api', 'worker', 'web']) {
      expect(svc(n).healthcheck?.test, `${n} healthcheck`).toBeDefined();
    }
  });

  it('SS-PLAT-86 every service drops privileges it does not need', () => {
    for (const [n, s] of Object.entries(compose.services)) {
      expect(s.security_opt, n).toContain('no-new-privileges:true');
    }
    for (const n of ['api', 'worker', 'setup', 'web']) {
      expect(svc(n).cap_drop, n).toEqual(['ALL']);
      expect(svc(n).read_only, n).toBe(true);
    }
  });

  it('SS-PLAT-86 the old compose path includes the new file instead of being deleted', () => {
    const old = parse(read('infra/compose/docker-compose.yml')) as { include?: string[] };
    expect(old.include).toEqual(['compose.yaml']);
  });
});

describe('SS-PLAT-86 Keycloak realm', () => {
  type Realm = Record<string, unknown> & {
    attributes: Record<string, string>;
    clients: Record<string, unknown>[];
  };
  const realm = JSON.parse(read('infra/compose/keycloak/ledgerforce-realm.json')) as Realm;
  const mfa = /DEFAULT_MFA_ACR = '([^']+)'/.exec(read('apps/api/src/authz/mfa.ts'))?.[1];

  it('SS-PLAT-86 no self-registration, no e-mail reset, brute-force protection, strong password policy', () => {
    expect(realm['realm']).toBe('ledgerforce');
    expect(realm['registrationAllowed']).toBe(false);
    expect(realm['resetPasswordAllowed']).toBe(false);
    expect(realm['bruteForceProtected']).toBe(true);
    expect(realm['sslRequired']).toBe('external');
    expect(String(realm['passwordPolicy'])).toMatch(/length\(12\)/);
    expect(realm['users']).toBeUndefined();
  });

  it('SS-PLAT-86 the client: confidential, code flow + PKCE S256 only, secret from the environment', () => {
    expect(realm.clients).toHaveLength(1);
    const c = realm.clients[0] ?? {};
    expect(c['clientId']).toBe('ledgerforce');
    expect(c['publicClient']).toBe(false);
    expect(c['secret']).toBe('${LF_OIDC_CLIENT_SECRET}');
    expect(c['standardFlowEnabled']).toBe(true);
    expect(c['directAccessGrantsEnabled']).toBe(false);
    expect(c['implicitFlowEnabled']).toBe(false);
    expect(c['serviceAccountsEnabled']).toBe(false);
    expect(c['redirectUris']).toEqual(['${LF_PUBLIC_URL}/auth/callback']);
    const attrs = c['attributes'] as Record<string, string>;
    expect(attrs['pkce.code.challenge.method']).toBe('S256');
    expect(attrs['default.acr.values']).toBe(mfa);
  });

  it('SS-PLAT-86 the ACR mapping names the MFA level the API accepts (ADR-0025, HANDOVER Q13)', () => {
    expect(mfa).toBe('urn:ledgerforce:loa:mfa');
    const map = JSON.parse(realm.attributes['acr.loa.map'] ?? '{}') as Record<string, number>;
    expect(map).toEqual({ 'urn:ledgerforce:loa:pwd': 1, [mfa ?? '']: 2 });
    expect(realm['browserFlow']).toBe('ledgerforce browser');
    const flows = realm['authenticationFlows'] as {
      alias: string;
      authenticationExecutions: { authenticator?: string; authenticatorConfig?: string }[];
    }[];
    const level2 = flows.find((f) => f.alias === 'ledgerforce level 2');
    expect(level2?.authenticationExecutions.map((e) => e.authenticator)).toEqual([
      'conditional-level-of-authentication',
      'auth-otp-form',
    ]);
  });
});

describe('SS-PLAT-86 generated secrets stay out of git', () => {
  it('SS-PLAT-86 the secrets folder and the install env file are ignored; examples only are tracked', () => {
    const secretsIgnore = read('infra/compose/secrets/.gitignore').split('\n');
    expect(secretsIgnore).toEqual(expect.arrayContaining(['*', '!.gitignore', '!README.md']));
    expect(read('.gitignore').split('\n')).toContain('infra/compose/ledgerforce.env');
    const example = read('infra/compose/ledgerforce.env.example');
    for (const line of example.split('\n')) {
      const m = /^([A-Z0-9_]+)=/.exec(line);
      if (m?.[1]) expect(m[1]).not.toMatch(SECRET_NAME);
    }
  });

  it('SS-PLAT-86 init-secrets.sh writes six distinct random secrets once and never overwrites', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'lf-secrets-')), 'secrets');
    const run = () =>
      spawnSync('bash', [resolve(ROOT, 'infra/compose/init-secrets.sh'), dir], {
        encoding: 'utf8',
      });
    const first = run();
    expect(first.status, first.stderr).toBe(0);
    const names = readdirSync(dir).sort();
    expect(names).toEqual(Object.keys(compose.secrets).sort());
    const values = names.map((n) => readFileSync(join(dir, n), 'utf8').trim());
    for (const v of values) expect(v).toMatch(/^[A-Za-z0-9]{40,}$/);
    expect(new Set(values).size).toBe(values.length);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(first.stdout).not.toContain(values[0] ?? '-');

    const second = run();
    expect(second.status).toBe(0);
    expect(names.map((n) => readFileSync(join(dir, n), 'utf8').trim())).toEqual(values);
  });
});
