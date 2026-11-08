/**
 * SS-PLAT-87 / SS-PLAT-88 — OpenBao/Vault transit KMS adapter (T-0108, RQ-0042, ADR-0038).
 * Runs the raw transit API contract and the KMS contract against an in-process fake transit
 * server (testing/fake-transit.ts); the same contracts run against the real OpenBao binary in
 * transit-kms.openbao.itest.ts (`pnpm test:openbao`).
 */
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DecryptionError, LocalKeyringKms, openField, sealField } from './envelope.ts';
import { kmsFromEnv } from './kms-config.ts';
import { FakeTransitServer } from './testing/fake-transit.ts';
import { describeKmsContract } from './testing/kms-contract.ts';
import { describeTransitApiContract } from './testing/transit-contract.ts';
import {
  TransitKms,
  TransitKmsError,
  type TransitKmsLogEvent,
  type TransitKmsOptions,
} from './transit-kms.ts';

const AAD = 'lf-field-v1|tenant-1|company-1|party-1|record-1|account_number';
const APPROLE = { roleId: 'role-id-7f3a', secretId: 'secret-id-c41b9e', mount: 'approle' };
const uniq = (p: string) => `${p}-${randomBytes(4).toString('hex')}`;

let fake: FakeTransitServer;
beforeAll(async () => {
  fake = await FakeTransitServer.start({
    rootToken: 'root-token-5e1d0c',
    appRole: { ...APPROLE, leaseSeconds: 1200 },
    namespaces: ['finance'],
  });
});
afterAll(async () => {
  await fake.close();
});

function opts(over: Partial<TransitKmsOptions> = {}): TransitKmsOptions {
  return {
    address: fake.url,
    keyName: 'lf-kek',
    auth: { token: fake.rootToken },
    allowInsecureLoopbackHttp: true,
    sleep: () => Promise.resolve(),
    ...over,
  };
}

async function connect(over: Partial<TransitKmsOptions> = {}): Promise<TransitKms> {
  const keyName = over.keyName ?? uniq('lf-kek');
  fake.createKey(keyName);
  return TransitKms.connect(opts({ ...over, keyName }));
}

async function rotateOnServer(kms: TransitKms): Promise<TransitKms> {
  const res = await fetch(`${fake.url}/v1/transit/keys/${kms.keyName}/rotate`, {
    method: 'POST',
    headers: { 'X-Vault-Token': fake.rootToken },
  });
  expect(res.status).toBe(200);
  await kms.refresh();
  return kms;
}

// ── contracts ──────────────────────────────────────────────────────────────────────────────

describeTransitApiContract('fake', () => ({
  address: fake.url,
  rootToken: fake.rootToken,
  mount: 'transit',
  appRole: APPROLE,
}));

const k = () => randomBytes(32).toString('base64');
const ring = (active: string, keys: Record<string, string>) =>
  LocalKeyringKms.fromJson(JSON.stringify({ active, keys }));

describeKmsContract('local keyring', () => {
  const k1 = k();
  return Promise.resolve({
    kms: ring('k1', { k1 }),
    other: ring('k1', { k1: k() }),
    stranger: ring('k9', { k9: k() }),
    rotate: () => Promise.resolve(ring('k2', { k1, k2: k() })),
  });
});

describeKmsContract('transit, fake server, static token', async () => {
  const kms = await connect();
  const other = await connect();
  return { kms, other, stranger: other, rotate: () => rotateOnServer(kms) };
});

describeKmsContract('transit, fake server, AppRole', async () => {
  const auth = { appRole: APPROLE };
  const kms = await connect({ auth });
  const other = await connect({ auth });
  return { kms, other, stranger: other, rotate: () => rotateOnServer(kms) };
});

// ── SS-PLAT-87: versions ───────────────────────────────────────────────────────────────────

describe('SS-PLAT-87: transit key versions', () => {
  it('key ids carry the key name and version; activeKeyId follows the server after rotation', async () => {
    const kms = await connect();
    expect(kms.activeKeyId).toBe(`tr.${kms.keyName}.v1`);
    await rotateOnServer(kms);
    expect(kms.activeKeyId).toBe(`tr.${kms.keyName}.v2`);
    expect((await sealField(kms, 'x', AAD)).keyId).toBe(`tr.${kms.keyName}.v2`);
  });

  it('activeKeyId also learns a rotation from the next encrypt response, without refresh()', async () => {
    const kms = await connect();
    await fetch(`${fake.url}/v1/transit/keys/${kms.keyName}/rotate`, {
      method: 'POST',
      headers: { 'X-Vault-Token': fake.rootToken },
    });
    expect(kms.activeKeyId).toBe(`tr.${kms.keyName}.v1`);
    const sealed = await sealField(kms, 'x', AAD);
    expect(sealed.keyId).toBe(`tr.${kms.keyName}.v2`);
    expect(kms.activeKeyId).toBe(`tr.${kms.keyName}.v2`);
  });

  it('a field still on a version below min_decryption_version fails closed, and the log says why', async () => {
    const events: TransitKmsLogEvent[] = [];
    const kms = await connect({ log: (e) => events.push(e) });
    const old = await sealField(kms, '987654321', AAD);
    await rotateOnServer(kms);
    await fetch(`${fake.url}/v1/transit/keys/${kms.keyName}/config`, {
      method: 'POST',
      headers: { 'X-Vault-Token': fake.rootToken },
      body: JSON.stringify({ min_decryption_version: 2 }),
    });
    await expect(openField(kms, old, AAD)).rejects.toBeInstanceOf(DecryptionError);
    expect(events.at(-1)).toMatchObject({
      op: 'decrypt',
      outcome: 'error',
      status: 400,
      reason: 'version_too_old',
    });
  });

  it('a key id whose version does not match the wrapped key fails closed', async () => {
    const kms = await connect();
    const v1 = await sealField(kms, '987654321', AAD);
    await rotateOnServer(kms);
    await expect(
      openField(kms, { ...v1, keyId: `tr.${kms.keyName}.v2` }, AAD),
    ).rejects.toBeInstanceOf(DecryptionError);
  });

  it('malformed key ids are refused as unknown, never sent to the server', async () => {
    const kms = await connect();
    const sealed = await sealField(kms, 'x', AAD);
    const before = fake.requests.length;
    for (const keyId of [
      'k1',
      `tr.${kms.keyName}.v0`,
      `tr.${kms.keyName}.v`,
      `tr.${kms.keyName}.vx`,
      `tr.${kms.keyName}.v01`,
      `tr.${kms.keyName}x.v1`,
      `tr.${kms.keyName}.v1.v1`,
    ]) {
      await expect(openField(kms, { ...sealed, keyId }, AAD), keyId).rejects.toThrow(
        /unknown key id/,
      );
    }
    expect(fake.requests.length).toBe(before);
  });

  it('a wrapped key that is not 60 bytes fails closed without a request', async () => {
    const kms = await connect();
    const sealed = await sealField(kms, 'x', AAD);
    const before = fake.requests.length;
    for (const wrappedDek of [
      sealed.wrappedDek.subarray(0, 59),
      Buffer.concat([sealed.wrappedDek, Buffer.alloc(1)]),
    ]) {
      await expect(openField(kms, { ...sealed, wrappedDek }, AAD)).rejects.toBeInstanceOf(
        DecryptionError,
      );
    }
    expect(fake.requests.length).toBe(before);
  });
});

// ── SS-PLAT-88: transport, auth, key policy, redaction, configuration ─────────────────────

describe('SS-PLAT-88: transit adapter transport is safe', () => {
  it('requires https; plain http only for a loopback host with explicit opt-in; no credentials or path in the address', async () => {
    const keyName = uniq('lf-kek');
    fake.createKey(keyName);
    const base = { keyName, auth: { token: fake.rootToken } };
    const bad = [
      { address: fake.url }, // loopback http without opt-in
      { address: 'http://10.1.2.3:8200', allowInsecureLoopbackHttp: true },
      { address: 'http://bao.example.com:8200', allowInsecureLoopbackHttp: true },
      { address: 'ftp://127.0.0.1:8200', allowInsecureLoopbackHttp: true },
      { address: 'https://user:pw@bao.example.com:8200' },
      { address: 'https://bao.example.com:8200/v1/transit' },
      { address: 'https://bao.example.com:8200?x=1' },
      { address: 'not a url' },
    ];
    for (const b of bad) {
      await expect(TransitKms.connect({ ...base, ...b }), b.address).rejects.toMatchObject({
        name: 'TransitKmsError',
        kind: 'config',
      });
    }
    await expect(
      TransitKms.connect({ ...base, address: fake.url, allowInsecureLoopbackHttp: true }),
    ).resolves.toBeInstanceOf(TransitKms);
  });

  it('validates key name, mount and namespace so they cannot escape the URL path', async () => {
    for (const o of [
      { keyName: '../sys/seal' },
      { keyName: 'a.b' },
      { keyName: 'x'.repeat(49) },
      { keyName: '' },
      { mount: '../sys' },
      { mount: 'transit/' },
      { namespace: 'a b' },
      { namespace: '../x' },
    ]) {
      await expect(TransitKms.connect(opts(o)), JSON.stringify(o)).rejects.toMatchObject({
        kind: 'config',
      });
    }
  });

  it('refuses redirects: the token never reaches the redirect target', async () => {
    const seen: (string | undefined)[] = [];
    const target = createServer((req, res) => {
      const t = req.headers['x-vault-token'];
      seen.push(Array.isArray(t) ? t[0] : t);
      res.end('{}');
    });
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
    try {
      const kms = await connect();
      fake.inject({
        redirect: `http://127.0.0.1:${String((target.address() as AddressInfo).port)}`,
      });
      const before = fake.requests.length;
      await expect(kms.wrap(randomBytes(32), AAD)).rejects.toMatchObject({
        kind: 'redirect_refused',
        status: 307,
      });
      expect(fake.requests.length - before).toBe(1); // not retried
      expect(seen).toEqual([]);
    } finally {
      await new Promise<void>((r) => target.close(() => r()));
    }
  });

  it('retries 503/500/502/429 and dropped connections with exponential backoff, then succeeds', async () => {
    const delays: number[] = [];
    const kms = await connect({
      maxAttempts: 6,
      random: () => 1,
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });
    fake.inject(
      { status: 503 },
      { status: 500 },
      { reset: true },
      { status: 502 },
      { status: 429 },
    );
    const before = fake.count('/encrypt/' + kms.keyName);
    const sealed = await sealField(kms, '123', AAD);
    expect(fake.count('/encrypt/' + kms.keyName) - before).toBe(6);
    expect(delays).toEqual([100, 200, 400, 800, 1600]);
    expect(await openField(kms, sealed, AAD)).toBe('123');
  });

  it('full jitter: each delay is random × the exponential step, capped', async () => {
    const delays: number[] = [];
    const kms = await connect({
      maxAttempts: 8,
      backoffBaseMs: 100,
      backoffCapMs: 1000,
      random: () => 0.5,
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });
    fake.inject(...Array.from({ length: 7 }, () => ({ status: 503 })));
    await kms.wrap(randomBytes(32), AAD);
    expect(delays).toEqual([50, 100, 200, 400, 500, 500, 500]);
  });

  it('honours Retry-After on 429/503, capped at the backoff cap', async () => {
    const delays: number[] = [];
    const kms = await connect({
      maxAttempts: 4,
      backoffCapMs: 2000,
      random: () => 0,
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });
    fake.inject(
      { status: 429, retryAfter: '1' },
      { status: 503, retryAfter: '30' },
      { status: 503, retryAfter: 'soon' },
    );
    await kms.wrap(randomBytes(32), AAD);
    expect(delays).toEqual([1000, 2000, 0]);
  });

  it('gives up after maxAttempts with an unavailable error carrying the last status', async () => {
    const kms = await connect({ maxAttempts: 3 });
    fake.inject({ status: 503 }, { status: 503 }, { status: 503 });
    const before = fake.count('/encrypt/' + kms.keyName);
    await expect(kms.wrap(randomBytes(32), AAD)).rejects.toMatchObject({
      name: 'TransitKmsError',
      kind: 'unavailable',
      status: 503,
      op: 'encrypt',
    });
    expect(fake.count('/encrypt/' + kms.keyName) - before).toBe(3);
    fake.inject({ status: 500 });
    await expect(kms.wrap(randomBytes(32), AAD)).resolves.toMatchObject({ keyId: kms.activeKeyId });
    fake.inject({ status: 502 }, { status: 502 }, { status: 502 });
    await expect(kms.wrap(randomBytes(32), AAD)).rejects.toBeInstanceOf(TransitKmsError);
  });

  it('never retries 4xx: 400 on encrypt, 403 with a static token, 404, 405', async () => {
    const kms = await connect({ maxAttempts: 5 });
    const cases: [number, string][] = [
      [400, 'bad_request'],
      [403, 'permission_denied'],
      [404, 'not_found'],
      [405, 'bad_request'],
    ];
    for (const [status, kind] of cases) {
      fake.inject({ status });
      const before = fake.count('/encrypt/' + kms.keyName);
      await expect(kms.wrap(randomBytes(32), AAD), String(status)).rejects.toMatchObject({
        kind,
        status,
      });
      expect(fake.count('/encrypt/' + kms.keyName) - before).toBe(1);
    }
  });

  it('a 400 on decrypt or rewrap is a DecryptionError and is not retried', async () => {
    const kms = await connect({ maxAttempts: 5 });
    const sealed = await sealField(kms, 'x', AAD);
    const before = fake.count('/decrypt/' + kms.keyName);
    await expect(openField(kms, sealed, AAD + 'x')).rejects.toBeInstanceOf(DecryptionError);
    expect(fake.count('/decrypt/' + kms.keyName) - before).toBe(1);
    await expect(kms.rewrap(sealed.wrappedDek, sealed.keyId, AAD + 'x')).rejects.toBeInstanceOf(
      DecryptionError,
    );
  });

  it('times out a hung server per attempt and reports timeout after the last attempt', async () => {
    const kms = await connect({ timeoutMs: 80, maxAttempts: 2 });
    fake.inject({ hang: true }, { hang: true });
    const started = Date.now();
    await expect(kms.wrap(randomBytes(32), AAD)).rejects.toMatchObject({
      kind: 'timeout',
      op: 'encrypt',
    });
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(150);
    expect(took).toBeLessThan(2000);
  });

  it('a 2xx body that is not the documented shape is refused (bad_response), never stored', async () => {
    const kms = await connect();
    const bodies = [
      { ciphertext: 'vault:v1:AAAA', key_version: 1 }, // not 60 bytes
      { ciphertext: 'nope', key_version: 1 },
      { ciphertext: `vault:v2:${Buffer.alloc(60).toString('base64')}`, key_version: 1 }, // mismatch
      { ciphertext: `vault:v1:${Buffer.alloc(60).toString('base64')}!`, key_version: 1 },
      {},
      null,
    ];
    for (const okData of bodies) {
      fake.inject({ okData });
      await expect(kms.wrap(randomBytes(32), AAD), JSON.stringify(okData)).rejects.toMatchObject({
        kind: 'bad_response',
      });
    }
    const sealed = await kms.wrap(randomBytes(32), AAD);
    for (const okData of [{ plaintext: 'AAAA' }, { plaintext: 42 }, {}]) {
      fake.inject({ okData });
      await expect(kms.unwrap(sealed.wrapped, sealed.keyId, AAD)).rejects.toBeInstanceOf(
        DecryptionError,
      );
    }
  });
});

describe('SS-PLAT-88: transit key policy is checked at start', () => {
  it.each([
    ['not derived', { derived: false }],
    ['convergent', { convergent: true }],
    ['exportable', { exportable: true }],
    ['plaintext backup allowed', { allowPlaintextBackup: true }],
    ['another key type', { type: 'chacha20-poly1305' }],
  ])('refuses a key that is %s', async (_label, keyOpts) => {
    const keyName = uniq('lf-bad');
    fake.createKey(keyName, keyOpts);
    await expect(TransitKms.connect(opts({ keyName }))).rejects.toMatchObject({
      kind: 'key_policy',
    });
  });

  it('a missing key or a namespace that does not exist fails to connect', async () => {
    await expect(TransitKms.connect(opts({ keyName: uniq('missing') }))).rejects.toMatchObject({
      kind: 'not_found',
      status: 404,
    });
    const keyName = uniq('lf-kek');
    fake.createKey(keyName);
    await expect(TransitKms.connect(opts({ keyName, namespace: 'nope' }))).rejects.toMatchObject({
      kind: 'not_found',
      status: 404,
    });
  });

  it('sends X-Vault-Namespace on every request when configured', async () => {
    const keyName = uniq('lf-kek');
    fake.createKey(keyName);
    const kms = await TransitKms.connect(
      opts({ keyName, namespace: 'finance', auth: { appRole: APPROLE } }),
    );
    const sealed = await sealField(kms, 'x', AAD);
    await openField(kms, sealed, AAD);
    const mine = fake.requests.filter(
      (r) => r.path.includes(keyName) || r.path.endsWith('/approle/login'),
    );
    expect(mine.length).toBeGreaterThanOrEqual(3);
    expect(new Set(mine.slice(-3).map((r) => r.namespace))).toEqual(new Set(['finance']));
  });
});

describe('SS-PLAT-88: transit authentication', () => {
  it('AppRole: logs in once, sends the issued token (never the secret) to transit', async () => {
    const logins = fake.appRoleLogins;
    const kms = await connect({ auth: { appRole: APPROLE } });
    await sealField(kms, 'x', AAD);
    expect(fake.appRoleLogins - logins).toBe(1);
    const enc = fake.requests.filter((r) => r.path.endsWith(`/encrypt/${kms.keyName}`)).at(-1);
    expect(enc?.token).toMatch(/^s\./);
    expect(JSON.stringify(enc)).not.toContain(APPROLE.secretId);
  });

  it('AppRole: logs in again when two thirds of the lease have passed', async () => {
    let now = 1_000_000;
    const kms = await connect({ auth: { appRole: APPROLE }, now: () => now });
    const logins = fake.appRoleLogins;
    now += 799_000; // < 2/3 of 1200 s
    await kms.wrap(randomBytes(32), AAD);
    expect(fake.appRoleLogins - logins).toBe(0);
    now += 2_000; // > 800 s
    await kms.wrap(randomBytes(32), AAD);
    expect(fake.appRoleLogins - logins).toBe(1);
  });

  it('AppRole: on 403 logs in again once and retries; a second 403 is permission_denied', async () => {
    const kms = await connect({ auth: { appRole: APPROLE } });
    fake.revokeAppRoleTokens();
    const logins = fake.appRoleLogins;
    await kms.wrap(randomBytes(32), AAD);
    expect(fake.appRoleLogins - logins).toBe(1);
    const only = `/encrypt/${kms.keyName}`;
    fake.inject({ status: 403, only }, { status: 403, only });
    await expect(kms.wrap(randomBytes(32), AAD)).rejects.toMatchObject({
      kind: 'permission_denied',
      status: 403,
    });
    expect(fake.appRoleLogins - logins).toBe(2);
  });

  it('AppRole: wrong credentials fail to connect with auth_failed', async () => {
    await expect(
      connect({ auth: { appRole: { ...APPROLE, secretId: 'wrong' } } }),
    ).rejects.toMatchObject({ kind: 'auth_failed', op: 'login' });
  });

  it('a static token that is refused is permission_denied (no re-login possible)', async () => {
    await expect(connect({ auth: { token: 'not-the-token' } })).rejects.toMatchObject({
      kind: 'permission_denied',
      status: 403,
      op: 'read_key',
    });
  });
});

describe('SS-PLAT-88: no secret ever appears in errors or logs', () => {
  it('tokens, AppRole secrets, data keys, plaintext, AAD and context stay out of errors and log events', async () => {
    const events: TransitKmsLogEvent[] = [];
    const errors: unknown[] = [];
    const catchIt = (p: Promise<unknown>) => p.catch((e: unknown) => errors.push(e));
    const kms = await connect({
      auth: { appRole: APPROLE },
      log: (e) => events.push(e),
      maxAttempts: 2,
    });
    const dek = randomBytes(32);
    const { wrapped, keyId } = await kms.wrap(dek, AAD);
    await kms.unwrap(wrapped, keyId, AAD);
    await catchIt(kms.unwrap(wrapped, keyId, AAD + 'x'));
    fake.inject({ status: 503, errors: [`echo ${dek.toString('base64')}`] }, { status: 503 });
    await catchIt(kms.wrap(dek, AAD));
    fake.inject({ status: 400, errors: [`echo ${dek.toString('base64')} ${AAD}`] });
    await catchIt(kms.wrap(dek, AAD));
    fake.inject({ status: 403 }, { status: 403 });
    await catchIt(kms.wrap(dek, AAD));
    await catchIt(connect({ auth: { appRole: { ...APPROLE, secretId: 'wrong-secret-31x' } } }));
    await catchIt(connect({ auth: { token: 'bad-static-token-99' } }));
    fake.inject({ hang: true });
    await catchIt(
      TransitKms.connect(opts({ keyName: kms.keyName, timeoutMs: 50, maxAttempts: 1 })),
    );

    expect(errors.length).toBeGreaterThanOrEqual(6);
    expect(events.length).toBeGreaterThan(5);
    const tokens = fake.requests.map((r) => r.token).filter((t): t is string => !!t);
    const ctx = Buffer.from(`lf-kek-transit-v1|${AAD}`).toString('base64');
    const secrets = [
      ...new Set(tokens),
      fake.rootToken,
      APPROLE.secretId,
      APPROLE.roleId,
      'wrong-secret-31x',
      'bad-static-token-99',
      dek.toString('base64'),
      dek.toString('hex'),
      AAD,
      ctx,
    ];
    const text = [
      JSON.stringify(events),
      ...errors.map((e) =>
        e instanceof Error
          ? `${e.name} ${e.message} ${e.stack ?? ''} ${JSON.stringify(e)} ${String((e as { cause?: unknown }).cause)}`
          : String(e),
      ),
    ].join('\n');
    for (const s of secrets) expect(text, 'leaked a secret').not.toContain(s);
    for (const e of events) {
      expect(Object.keys(e).sort()).toEqual(
        expect.arrayContaining(['attempt', 'ms', 'op', 'outcome']),
      );
      for (const key of Object.keys(e)) {
        expect(['op', 'outcome', 'attempt', 'status', 'ms', 'reason', 'kind']).toContain(key);
      }
    }
  });
});

describe('SS-PLAT-88: configuration selects the KMS (LF_KMS_PROVIDER)', () => {
  async function secretFile(content: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'lf-kmscfg-'));
    const file = join(dir, 'secret');
    await writeFile(file, content, { mode: 0o600 });
    return file;
  }

  it('unset (or empty) means no KMS: the MVP behaviour is unchanged', async () => {
    expect(await kmsFromEnv({})).toBeNull();
    expect(await kmsFromEnv({ LF_KMS_PROVIDER: '' })).toBeNull();
  });

  it('local reads the keyring file', async () => {
    const file = await secretFile(JSON.stringify({ active: 'k1', keys: { k1: k() } }));
    const kms = await kmsFromEnv({ LF_KMS_PROVIDER: 'local', LF_KMS_KEYRING_FILE: file });
    expect(kms).toBeInstanceOf(LocalKeyringKms);
    await expect(kmsFromEnv({ LF_KMS_PROVIDER: 'local' })).rejects.toThrow(/LF_KMS_KEYRING_FILE/);
  });

  it('transit connects with a token file or AppRole files, and the result seals and opens', async () => {
    const keyName = uniq('lf-kek');
    fake.createKey(keyName);
    const common = {
      LF_KMS_PROVIDER: 'transit',
      LF_KMS_TRANSIT_ADDR: fake.url,
      LF_KMS_TRANSIT_KEY: keyName,
      LF_KMS_TRANSIT_ALLOW_LOOPBACK_HTTP: 'true',
    };
    const byToken = await kmsFromEnv({
      ...common,
      LF_KMS_TRANSIT_TOKEN_FILE: await secretFile(`${fake.rootToken}\n`),
    });
    expect(byToken).toBeInstanceOf(TransitKms);
    const byRole = await kmsFromEnv({
      ...common,
      LF_KMS_TRANSIT_NAMESPACE: 'finance',
      LF_KMS_TRANSIT_TIMEOUT_MS: '2000',
      LF_KMS_TRANSIT_APPROLE_ROLE_ID_FILE: await secretFile(APPROLE.roleId),
      LF_KMS_TRANSIT_APPROLE_SECRET_ID_FILE: await secretFile(`${APPROLE.secretId}\n`),
    });
    expect(byRole).toBeInstanceOf(TransitKms);
    if (!byToken || !byRole) throw new Error('unreachable');
    const sealed = await sealField(byToken, 'x', AAD);
    expect(await openField(byRole, sealed, AAD)).toBe('x');
  });

  it('refuses unknown providers, missing settings, ambiguous auth, and never echoes secrets', async () => {
    const tokenFile = await secretFile('super-secret-token-abc');
    const base = {
      LF_KMS_PROVIDER: 'transit',
      LF_KMS_TRANSIT_ADDR: fake.url,
      LF_KMS_TRANSIT_KEY: 'lf-kek',
      LF_KMS_TRANSIT_ALLOW_LOOPBACK_HTTP: 'true',
    };
    const bad: Record<string, string>[] = [
      { LF_KMS_PROVIDER: 'vault-sdk' },
      { ...base, LF_KMS_TRANSIT_ADDR: '' },
      { ...base, LF_KMS_TRANSIT_KEY: '' },
      { ...base }, // no auth
      {
        ...base,
        LF_KMS_TRANSIT_TOKEN_FILE: tokenFile,
        LF_KMS_TRANSIT_APPROLE_ROLE_ID_FILE: tokenFile,
        LF_KMS_TRANSIT_APPROLE_SECRET_ID_FILE: tokenFile,
      },
      { ...base, LF_KMS_TRANSIT_APPROLE_ROLE_ID_FILE: tokenFile }, // secret id missing
      { ...base, LF_KMS_TRANSIT_TOKEN_FILE: tokenFile, LF_KMS_TRANSIT_TIMEOUT_MS: 'fast' },
      { ...base, LF_KMS_TRANSIT_TOKEN_FILE: tokenFile, LF_KMS_TRANSIT_ALLOW_LOOPBACK_HTTP: 'yes' },
      { ...base, LF_KMS_TRANSIT_TOKEN_FILE: join(tmpdir(), uniq('missing')) },
      { ...base, LF_KMS_TRANSIT_TOKEN_FILE: await secretFile('  \n') },
    ];
    for (const env of bad) {
      const error = await kmsFromEnv(env).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error, JSON.stringify(env)).toBeInstanceOf(Error);
      expect(String(error)).not.toContain('super-secret-token-abc');
    }
  });
});
