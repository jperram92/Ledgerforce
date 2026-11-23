/**
 * SS-PLAT-86 — the self-hosted install contract (T-0094, RQ-0041, ADR-0037), checked without a
 * Docker daemon: pinned and non-root images, no secret in an image or in the compose file, each
 * secret only where it is needed, lf_app for the runtime and lf_migrator only for setup, health
 * checks and start order, the Keycloak realm's security settings and MFA mapping, the secret
 * generator, and the ignore rules that keep generated secrets out of git.
 * The running stack is proven by SS-PLAT-23 (tests/install/install.smoke.spec.ts).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT = resolve(import.meta.dirname, '..', '..');
const read = (p: string): string => readFileSync(resolve(ROOT, p), 'utf8');

const DIGEST = /^[a-z0-9./_-]+:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/;
const SECRET_NAME = /(PASSWORD|SECRET|TOKEN|PRIVATE_KEY)/i;

it('runs the Node runtime package-update regression [T-0057]', () => {
  const result = spawnSync(process.execPath, ['--test', 'infra/test/runtime-updates.test.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  expect(result.status, result.stdout + result.stderr).toBe(0);
});

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
  command?: string[];
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
  it('SS-PLAT-86 has exactly the design §7.2 services plus the one-shot setup, the scheduler (ADR-0062) and the nightly backup (ADR-0101)', () => {
    expect(Object.keys(compose.services).sort()).toEqual(
      ['api', 'backup', 'keycloak', 'postgres', 'scheduler', 'setup', 'web', 'worker'].sort(),
    );
  });

  it('every service compose would build has an image the smoke script makes (up --no-build)', () => {
    // CI's DAST and install smoke run infra/compose/smoke.sh, which builds images itself and then
    // starts compose with --no-build. A service whose <project>-<service> image smoke.sh never makes
    // fails with "No such image" (the T-0147 scheduler, found by DAST on dbd19a5).
    const smoke = read('infra/compose/smoke.sh');
    const loop = /for target in ([a-z ]+); do/.exec(smoke)?.[1]?.split(' ') ?? [];
    const tagged = [
      ...smoke.matchAll(/docker tag "\$\{project\}-[a-z]+" "\$\{project\}-([a-z]+)"/g),
    ].map((m) => m[1]);
    const made = new Set([...loop, 'keycloak', ...tagged]);
    for (const [name, s] of Object.entries(compose.services)) {
      if (s.build) expect(made.has(name), `smoke.sh makes the ${name} image`).toBe(true);
    }
  });

  it('T-0147 the scheduler is the worker image running the owner-only scheduler CLI (ADR-0062 option 1)', () => {
    expect(svc('scheduler').build).toEqual({
      context: '../..',
      dockerfile: 'infra/docker/Dockerfile',
      target: 'worker',
    });
    expect(svc('scheduler').command).toEqual(['node', 'apps/worker/src/cli/scheduler.ts']);
    const env = svc('scheduler').environment ?? {};
    expect(env['LF_MIGRATOR_DB_PASSWORD_FILE']).toBe('/run/secrets/lf_migrator_password');
    expect(env['LF_APP_DB_PASSWORD_FILE']).toBeUndefined();
    expect(svc('scheduler').secrets).toEqual(['lf_migrator_password']);
    expect(svc('scheduler').ports).toBeUndefined();
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
        'backup_keyring',
        'keycloak_admin_client_secret',
        'keycloak_db_password',
        'lf_app_password',
        'lf_backup_password',
        'lf_migrator_password',
        'oidc_client_secret',
        'postgres_password',
      ].sort(),
    );
    // The superuser password stays in the database container; the backup reads as lf_backup
    // (BYPASSRLS + pg_read_all_data, read-only; T-0227, ADR-0106).
    expect(holders('postgres_password')).toEqual(['postgres']);
    expect(holders('lf_backup_password')).toEqual(['backup', 'postgres']);
    expect(holders('backup_keyring')).toEqual(['backup']);
    expect(holders('lf_migrator_password')).toEqual(['postgres', 'scheduler', 'setup']);
    expect(holders('lf_app_password')).toEqual(['api', 'postgres', 'setup', 'worker']);
    expect(holders('keycloak_db_password')).toEqual(['keycloak', 'postgres']);
    expect(holders('oidc_client_secret')).toEqual(['api', 'keycloak']);
    expect(holders('keycloak_admin_client_secret')).toEqual(['keycloak', 'setup']);
    expect(svc('web').secrets ?? []).toEqual([]);
  });

  it('T-0142 AC-5 the api trusts exactly the nginx hop for the client address, overridable by the operator (ADR-0054)', () => {
    expect(svc('api').environment?.['LF_TRUST_PROXY_HOPS']).toBe('${LF_TRUST_PROXY_HOPS:-1}');
    for (const n of ['worker', 'setup', 'web']) {
      expect(svc(n).environment?.['LF_TRUST_PROXY_HOPS']).toBeUndefined();
    }
  });

  it('SS-PLAT-86 the runtime connects as lf_app; only setup and the scheduler hold the migrator password', () => {
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
    for (const n of ['api', 'worker', 'scheduler']) {
      expect(svc(n).depends_on?.['setup']).toEqual({
        condition: 'service_completed_successfully',
      });
    }
    expect(svc('web').depends_on).toEqual({
      api: { condition: 'service_healthy' },
      keycloak: { condition: 'service_healthy' },
    });
    for (const n of ['postgres', 'keycloak', 'api', 'worker', 'scheduler', 'web']) {
      expect(svc(n).healthcheck?.test, `${n} healthcheck`).toBeDefined();
    }
  });

  it('SS-PLAT-86 every service drops privileges it does not need', () => {
    for (const [n, s] of Object.entries(compose.services)) {
      expect(s.security_opt, n).toContain('no-new-privileges:true');
    }
    for (const n of ['api', 'worker', 'scheduler', 'setup', 'web', 'backup']) {
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

  it('SS-PLAT-86 init-secrets.sh writes distinct random secrets (and the backup keyring) once and never overwrites', () => {
    // The install targets Linux. Use its native filesystem even from Windows: NTFS's
    // synthetic stat mode cannot prove chmod 0700. Pipe the exact script bytes to WSL,
    // avoiding Windows path conversion; all original permission/idempotency checks remain.
    const script = read('infra/compose/init-secrets.sh').replaceAll('\r\n', '\n');
    const fixture = `set -euo pipefail
work=$(mktemp -d)
cat > "$work/init-secrets.sh" <<'LF_INSTALL_SCRIPT'
${script}
LF_INSTALL_SCRIPT
dir="$work/secrets with spaces"
bash "$work/init-secrets.sh" "$dir" > "$work/first-output"
printf 'MODE:%s\\n' "$(stat -c %a "$dir")"
cat "$work/first-output"
printf 'FIRST_VALUES\\n'
for file in "$dir"/*; do printf '%s:%s\\n' "$(basename "$file")" "$(cat "$file")"; done
bash "$work/init-secrets.sh" "$dir" > "$work/second-output"
printf 'SECOND_VALUES\\n'
for file in "$dir"/*; do printf '%s:%s\\n' "$(basename "$file")" "$(cat "$file")"; done
`;
    const result = spawnSync(
      process.platform === 'win32' ? 'wsl.exe' : 'bash',
      process.platform === 'win32' ? ['--exec', 'bash', '-s'] : ['-s'],
      { input: fixture, encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    const [output = '', snapshots = ''] = result.stdout.split('FIRST_VALUES\n');
    const [first = '', second = ''] = snapshots.split('SECOND_VALUES\n');
    const records = first.trim().split('\n');
    const names = records.map((r) => r.split(':')[0]).sort();
    expect(names).toEqual(Object.keys(compose.secrets).sort());
    // backup_keyring is a LocalKeyringKms JSON keyring (one 32-byte key), checked on its own.
    const keyring = records.find((r) => r.startsWith('backup_keyring:'));
    const ring = JSON.parse(keyring?.slice('backup_keyring:'.length) ?? '') as {
      active: string;
      keys: Record<string, string>;
    };
    expect(ring.active).toMatch(/^backup-\d{8}$/);
    expect(Object.keys(ring.keys)).toEqual([ring.active]);
    expect(Buffer.from(ring.keys[ring.active] ?? '', 'base64')).toHaveLength(32);
    const values = records.filter((r) => r !== keyring).map((r) => r.split(':')[1] ?? '');
    for (const v of values) expect(v).toMatch(/^[A-Za-z0-9]{40,}$/);
    expect(new Set(values).size).toBe(values.length);
    expect(output.split('\n')[0]).toBe('MODE:700');
    expect(output).not.toContain(values[0] ?? '-');
    expect(second.trim().split('\n')).toEqual(records);
  });
});

describe('SS-PLAT-174 nightly encrypted backup service and runbook (T-0143 AC-4, ADR-0101)', () => {
  it('SS-PLAT-174 the backup image is the node runtime plus the PostgreSQL 17 client, non-root, with a /backups folder it owns', () => {
    const app = stages(read('infra/docker/Dockerfile'));
    const s = app.find((x) => x.name === 'backup');
    expect(s?.from).toBe('node-runtime');
    const body = s?.lines.join('\n') ?? '';
    // pg_dump must be at least the server's major version (postgres:17 in compose; RQ-0183 F8).
    expect(body).toMatch(/apk add --no-cache postgresql17-client/);
    expect(body).toMatch(/chown node:node \/backups/);
    expect(s ? effectiveUser(app, s) : undefined).toBe('node');
    expect(body).toMatch(
      /CMD \["node", "packages\/db\/src\/cli\/backup\.ts", "--daily", "--dir", "\/backups"\]/,
    );
    expect(read('infra/compose/smoke.sh')).toMatch(/for target in [a-z ]*\bbackup\b/);
  });

  it('SS-PLAT-174 compose runs the backup nightly with a retention setting, a dedicated keyring and its own volume', () => {
    const b = svc('backup');
    expect(b.build).toEqual({
      context: '../..',
      dockerfile: 'infra/docker/Dockerfile',
      target: 'backup',
    });
    const env = b.environment ?? {};
    expect(env['LF_BACKUP_RETENTION_DAYS']).toBe('${LF_BACKUP_RETENTION_DAYS:-14}');
    expect(env['LF_BACKUP_AT']).toBe('${LF_BACKUP_AT:-02:30}');
    expect(env['LF_KMS_PROVIDER']).toBe('local');
    expect(env['LF_KMS_KEYRING_FILE']).toBe('/run/secrets/backup_keyring');
    expect(env['LF_BACKUP_DB_USER']).toBe('lf_backup');
    expect(env['LF_BACKUP_DB_PASSWORD_FILE']).toBe('/run/secrets/lf_backup_password');
    expect(env['LF_DB_HOST']).toBe('postgres');
    expect(b.secrets?.sort()).toEqual(['backup_keyring', 'lf_backup_password']);
    expect(b.ports).toBeUndefined();
    expect(b.read_only).toBe(true);
    expect((b as { volumes?: string[] }).volumes).toEqual(['backups:/backups']);
    expect(compose.volumes).toHaveProperty('backups');
    expect(b.depends_on?.['setup']).toEqual({ condition: 'service_completed_successfully' });
    expect(compose.secrets['backup_keyring']).toEqual({ file: './secrets/backup_keyring' });
    const example = read('infra/compose/ledgerforce.env.example');
    expect(example).toMatch(/^#? ?LF_BACKUP_RETENTION_DAYS=14$/m);
    expect(example).toMatch(/^#? ?LF_BACKUP_AT=02:30$/m);
  });

  it('SS-PLAT-174 the runbook covers backup, off-host key custody, the restore drill and its failure codes', () => {
    const doc = read('Docs/ops/backup-restore.md');
    for (const needle of [
      'LF_BACKUP_RETENTION_DAYS',
      'LF_BACKUP_AT',
      'backup_keyring',
      'packages/ledger/src/cli/restore-drill.ts',
      'packages/db/src/cli/backup.ts',
      'BACKUP_DECRYPT_FAILED',
      'CHAIN_BROKEN',
      'ROW_COUNT_MISMATCH',
      'off the host',
      'quarterly',
      'ADR-0101',
    ]) {
      expect(doc, needle).toContain(needle);
    }
    expect(read('Docs/ops/install.md')).toContain('backup-restore.md');
  });
});

describe('SS-PLAT-195 the backup connects as lf_backup, only from its own network (T-0227, ADR-0106)', () => {
  type Net = { internal?: boolean; ipam?: { config?: { subnet?: string }[] } };
  const raw = compose as unknown as {
    services: Record<string, { networks?: string[] | Record<string, unknown>; volumes?: string[] }>;
    networks?: Record<string, Net>;
  };
  const netsOf = (n: string): string[] => {
    const v = raw.services[n]?.networks;
    if (v === undefined) return ['default'];
    return (Array.isArray(v) ? v : Object.keys(v)).sort();
  };

  it('SS-PLAT-195 the backup service holds lf_backup_password and never the superuser password', () => {
    const b = svc('backup');
    expect(b.environment?.['LF_BACKUP_DB_USER']).toBe('lf_backup');
    expect(b.secrets).not.toContain('postgres_password');
    expect(JSON.stringify(b)).not.toMatch(/postgres_password/);
    expect(compose.secrets['lf_backup_password']).toEqual({ file: './secrets/lf_backup_password' });
    const pg = svc('postgres');
    expect(pg.environment?.['LF_BACKUP_PASSWORD_FILE']).toBe('/run/secrets/lf_backup_password');
    expect(pg.secrets).toContain('lf_backup_password');
  });

  it('SS-PLAT-195 an internal backup network joined only by postgres and backup; postgres allows lf_backup from its subnet only', () => {
    const subnet = '${LF_BACKUP_SUBNET:-172.30.227.0/29}';
    expect(raw.networks?.['backup']).toEqual({ internal: true, ipam: { config: [{ subnet }] } });
    const members = Object.keys(raw.services)
      .filter((n) => netsOf(n).includes('backup'))
      .sort();
    expect(members).toEqual(['backup', 'postgres']);
    expect(netsOf('backup')).toEqual(['backup']);
    expect(netsOf('postgres')).toEqual(['backup', 'default']);
    expect(svc('postgres').environment?.['LF_BACKUP_ALLOWED_CIDR']).toBe(subnet);
    expect(read('infra/compose/ledgerforce.env.example')).toMatch(
      /^#? ?LF_BACKUP_SUBNET=172\.30\.227\.0\/29$/m,
    );
  });

  it('SS-PLAT-195 the init script that creates lf_backup and its pg_hba block is mounted, and the runbook gives the upgrade step', () => {
    expect(raw.services['postgres']?.volumes).toEqual(
      expect.arrayContaining([
        '../../packages/db/bootstrap:/lf-bootstrap:ro',
        './initdb/10-ledgerforce-roles.sh:/docker-entrypoint-initdb.d/10-ledgerforce-roles.sh:ro',
      ]),
    );
    const script = read('infra/compose/initdb/10-ledgerforce-roles.sh');
    expect(script).toContain('LF_BACKUP_PASSWORD');
    expect(script).toContain('LF_BACKUP_ALLOWED_CIDR');
    expect(read('packages/db/bootstrap/01_cluster_roles.sql')).toMatch(
      /ALTER ROLE lf_backup\s+NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS/,
    );
    const doc = read('Docs/ops/backup-restore.md');
    for (const needle of [
      'lf_backup',
      'ADR-0106',
      'lf_backup_password',
      'LF_BACKUP_SUBNET',
      'exec -u postgres postgres bash /docker-entrypoint-initdb.d/10-ledgerforce-roles.sh',
    ]) {
      expect(doc, needle).toContain(needle);
    }
    expect(doc).not.toMatch(/connects as the `postgres` superuser/);
  });
});
