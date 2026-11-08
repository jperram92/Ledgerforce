/**
 * Raw transit API contract (SS-PLAT-87, RQ-0042). Plain `fetch` calls with the documented
 * request shapes; the assertions are the documented response shapes and the status codes and
 * messages recorded from OpenBao 2.7.1. The same suite runs against the in-process fake
 * (transit-kms.test.ts) and the real binary (transit-kms.openbao.itest.ts), so the fake cannot
 * drift from the server the adapter is written for.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TRANSIT_ERR } from './fake-transit.ts';

export interface TransitTarget {
  /** `http(s)://host:port` — no path. */
  address: string;
  /** A token allowed to create, rotate and configure keys. */
  rootToken: string;
  mount: string;
  appRole?: { roleId: string; secretId: string; mount: string };
}

interface Raw {
  status: number;
  body: Record<string, unknown>;
}

export async function transitCall(
  t: TransitTarget,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  headers: Record<string, string> = { 'X-Vault-Token': t.rootToken },
): Promise<Raw> {
  const init: RequestInit = { method, headers: { ...headers }, redirect: 'manual' };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)['content-type'] = 'application/json';
  }
  const res = await fetch(`${t.address}/v1/${path}`, init);
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');
const data = (r: Raw) => r.body['data'] as Record<string, unknown>;
const uniq = (p: string) => `${p}-${randomBytes(4).toString('hex')}`;

export function describeTransitApiContract(label: string, target: () => TransitTarget): void {
  describe(`SS-PLAT-87: transit API contract (${label})`, () => {
    const ctxA = b64('lf-kek-transit-v1|recordA');
    const ctxB = b64('lf-kek-transit-v1|recordB');

    async function derivedKey(t: TransitTarget): Promise<string> {
      const name = uniq('c-derived');
      const r = await transitCall(t, 'POST', `${t.mount}/keys/${name}`, {
        type: 'aes256-gcm96',
        derived: true,
      });
      expect([200, 204]).toContain(r.status);
      return name;
    }

    it('reads a derived key: type, derivation, versions and policy fields', async () => {
      const t = target();
      const name = await derivedKey(t);
      const r = await transitCall(t, 'GET', `${t.mount}/keys/${name}`);
      expect(r.status).toBe(200);
      expect(data(r)).toMatchObject({
        type: 'aes256-gcm96',
        derived: true,
        convergent_encryption: false,
        kdf: 'hkdf_sha256',
        exportable: false,
        allow_plaintext_backup: false,
        latest_version: 1,
        min_decryption_version: 1,
        min_encryption_version: 0,
        supports_encryption: true,
        supports_decryption: true,
        name,
      });
      expect(Object.keys(data(r)['keys'] as object)).toEqual(['1']);
    });

    it('encrypt returns vault:v1:<80 base64 chars> (60 bytes for a 32-byte key) and key_version', async () => {
      const t = target();
      const name = await derivedKey(t);
      const dek = randomBytes(32);
      const r = await transitCall(t, 'POST', `${t.mount}/encrypt/${name}`, {
        plaintext: b64(dek),
        context: ctxA,
      });
      expect(r.status).toBe(200);
      const ct = data(r)['ciphertext'] as string;
      expect(ct).toMatch(/^vault:v1:[A-Za-z0-9+/]{80}$/);
      expect(Buffer.from(ct.slice('vault:v1:'.length), 'base64')).toHaveLength(60);
      expect(data(r)['key_version']).toBe(1);
      const d = await transitCall(t, 'POST', `${t.mount}/decrypt/${name}`, {
        ciphertext: ct,
        context: ctxA,
      });
      expect(d.status).toBe(200);
      expect(data(d)['plaintext']).toBe(b64(dek));
    });

    it('wrong context, missing context, tampering and another key fail with 400 and the documented errors', async () => {
      const t = target();
      const name = await derivedKey(t);
      const other = await derivedKey(t);
      const enc = await transitCall(t, 'POST', `${t.mount}/encrypt/${name}`, {
        plaintext: b64(randomBytes(32)),
        context: ctxA,
      });
      const ct = data(enc)['ciphertext'] as string;
      const last = ct.at(-1) === 'A' ? 'B' : 'A';
      const cases: [string, Record<string, unknown>, string][] = [
        [name, { ciphertext: ct, context: ctxB }, TRANSIT_ERR.authFailed],
        [name, { ciphertext: ct }, TRANSIT_ERR.missingContext],
        [name, { ciphertext: ct.slice(0, -1) + last, context: ctxA }, TRANSIT_ERR.authFailed],
        [other, { ciphertext: ct, context: ctxA }, TRANSIT_ERR.authFailed],
      ];
      for (const [key, body, message] of cases) {
        const r = await transitCall(t, 'POST', `${t.mount}/decrypt/${key}`, body);
        expect(r.status, JSON.stringify(body)).toBe(400);
        expect(r.body).toEqual({ errors: [message] });
      }
    });

    it('context sent to a NON-derived key is silently ignored (why the adapter checks derived=true)', async () => {
      const t = target();
      const name = uniq('c-plain');
      await transitCall(t, 'POST', `${t.mount}/keys/${name}`, { type: 'aes256-gcm96' });
      const enc = await transitCall(t, 'POST', `${t.mount}/encrypt/${name}`, {
        plaintext: b64('x'.repeat(32)),
        context: ctxA,
      });
      expect(enc.status).toBe(200);
      const d = await transitCall(t, 'POST', `${t.mount}/decrypt/${name}`, {
        ciphertext: data(enc)['ciphertext'],
        context: ctxB,
      });
      expect(d.status).toBe(200);
    });

    it('rotate, rewrap with the same context, then min_decryption_version retires v1', async () => {
      const t = target();
      const name = await derivedKey(t);
      const enc = await transitCall(t, 'POST', `${t.mount}/encrypt/${name}`, {
        plaintext: b64(randomBytes(32)),
        context: ctxA,
      });
      const v1 = data(enc)['ciphertext'] as string;
      const rot = await transitCall(t, 'POST', `${t.mount}/keys/${name}/rotate`);
      expect(rot.status).toBe(200);
      expect(data(rot)['latest_version']).toBe(2);
      const rw = await transitCall(t, 'POST', `${t.mount}/rewrap/${name}`, {
        ciphertext: v1,
        context: ctxA,
      });
      expect(rw.status).toBe(200);
      expect(data(rw)['ciphertext']).toMatch(/^vault:v2:[A-Za-z0-9+/]{80}$/);
      expect(data(rw)['key_version']).toBe(2);
      const bad = await transitCall(t, 'POST', `${t.mount}/rewrap/${name}`, {
        ciphertext: v1,
        context: ctxB,
      });
      expect(bad).toEqual({ status: 400, body: { errors: [TRANSIT_ERR.authFailed] } });
      const cfg = await transitCall(t, 'POST', `${t.mount}/keys/${name}/config`, {
        min_decryption_version: 2,
      });
      expect([200, 204]).toContain(cfg.status);
      const old = await transitCall(t, 'POST', `${t.mount}/decrypt/${name}`, {
        ciphertext: v1,
        context: ctxA,
      });
      expect(old).toEqual({ status: 400, body: { errors: [TRANSIT_ERR.tooOld] } });
      const fresh = await transitCall(t, 'POST', `${t.mount}/decrypt/${name}`, {
        ciphertext: data(rw)['ciphertext'],
        context: ctxA,
      });
      expect(fresh.status).toBe(200);
    });

    it('a bad token gets 403 permission denied; a missing key 400; an unknown namespace 404', async () => {
      const t = target();
      const name = await derivedKey(t);
      const body = { plaintext: b64(randomBytes(32)), context: ctxA };
      expect(
        await transitCall(t, 'POST', `${t.mount}/encrypt/${name}`, body, {
          'X-Vault-Token': 'not-a-token',
        }),
      ).toEqual({ status: 403, body: { errors: [TRANSIT_ERR.permissionDenied] } });
      expect(
        await transitCall(t, 'POST', `${t.mount}/decrypt/${uniq('missing')}`, {
          ciphertext: 'vault:v1:AAAA',
          context: ctxA,
        }),
      ).toEqual({ status: 400, body: { errors: [TRANSIT_ERR.keyNotFound] } });
      expect(
        await transitCall(t, 'POST', `${t.mount}/encrypt/${name}`, body, {
          'X-Vault-Token': t.rootToken,
          'X-Vault-Namespace': uniq('no-such-ns'),
        }),
      ).toEqual({ status: 404, body: { errors: [TRANSIT_ERR.namespaceNotFound] } });
    });

    it('AppRole login returns auth.client_token with a lease', async () => {
      const t = target();
      if (!t.appRole) throw new Error('this target must configure AppRole');
      const r = await transitCall(
        t,
        'POST',
        `auth/${t.appRole.mount}/login`,
        { role_id: t.appRole.roleId, secret_id: t.appRole.secretId },
        {},
      );
      expect(r.status).toBe(200);
      const auth = r.body['auth'] as Record<string, unknown>;
      expect(typeof auth['client_token']).toBe('string');
      expect(auth['lease_duration']).toBeGreaterThan(0);
      expect(auth['renewable']).toBe(true);
      const bad = await transitCall(
        t,
        'POST',
        `auth/${t.appRole.mount}/login`,
        { role_id: t.appRole.roleId, secret_id: 'wrong' },
        {},
      );
      expect(bad.status).toBe(400);
    });
  });
}
