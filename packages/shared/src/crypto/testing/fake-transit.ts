/**
 * In-process fake of the OpenBao/Vault transit secrets engine (test support for T-0108).
 *
 * It follows the request/response shapes documented in RQ-0042 (OpenBao api-docs/secret/transit,
 * api-docs/index, api-docs/auth/approle) and the responses recorded from OpenBao 2.7.1
 * (Docs/research/assets/RQ-0042/spike-output.txt): `vault:v<N>:` + base64(nonce ‖ ct ‖ tag),
 * `{"data":{…}}` success bodies, `{"errors":[…]}` with the same status codes and messages, derived
 * keys that need `context` (HKDF-SHA256), `context` silently ignored on non-derived keys, rewrap
 * without associated data, `min_decryption_version`, AppRole login, `X-Vault-Namespace`.
 * The same raw contract (transit-contract.ts) runs against this fake and against the real binary
 * (`pnpm test:openbao`), which is what keeps the fake honest.
 *
 * Not modelled: ACL policies (every valid token may do everything), batch_input, convergent
 * encryption, key types other than aes256-gcm96 (they can be *declared* to test the adapter's
 * key policy, but encrypting with them is refused).
 *
 * Fault injection (`inject`) lets tests make the next requests answer a status, hang, drop the
 * connection or redirect, so retry, timeout and redirect handling can be proven.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const TRANSIT_ERR = {
  authFailed: 'cipher: message authentication failed',
  missingContext:
    "missing 'context' for key derivation; the key was created using a derived key, which means additional, per-request information must be included in order to perform operations with the key",
  tooOld: 'ciphertext or signature version is disallowed by policy (too old)',
  keyNotFound: 'encryption key not found',
  permissionDenied: 'permission denied',
  namespaceNotFound: 'namespace not found',
  sealed: 'Vault is sealed',
} as const;

export interface FakeKeyOptions {
  type?: string;
  derived?: boolean;
  exportable?: boolean;
  allowPlaintextBackup?: boolean;
  convergent?: boolean;
}

interface FakeKey {
  name: string;
  type: string;
  derived: boolean;
  exportable: boolean;
  allowPlaintextBackup: boolean;
  convergent: boolean;
  versions: Map<number, { material: Buffer; created: number }>;
  latest: number;
  minDecryption: number;
  minEncryption: number;
}

export type FakeFault =
  | { status: number; retryAfter?: string; errors?: string[] }
  | { hang: true }
  | { reset: true }
  | { redirect: string }
  /** A 200 whose `data` is whatever the test supplies (to prove the client validates it). */
  | { okData: unknown };

export interface RecordedRequest {
  method: string;
  path: string;
  token: string | undefined;
  namespace: string | undefined;
  body: Record<string, unknown> | undefined;
}

export interface FakeTransitOptions {
  /** Root-like token accepted for every operation. */
  rootToken?: string;
  /** AppRole credentials accepted at `auth/<appRoleMount>/login`. */
  appRole?: { roleId: string; secretId: string; leaseSeconds?: number; mount?: string };
  /** Transit mount path (default `transit`). */
  mount?: string;
  /** Namespaces that exist besides the root one (header `X-Vault-Namespace`). */
  namespaces?: string[];
}

const PREFIX = /^vault:v(\d+):(.*)$/s;
const NONCE = 12;
const TAG = 16;

function deriveKey(key: FakeKey, version: number, context: Buffer | undefined): Buffer {
  const v = key.versions.get(version);
  if (!v) throw new Error('no such version');
  if (!key.derived) return v.material;
  return Buffer.from(hkdfSync('sha256', v.material, Buffer.alloc(0), context ?? Buffer.alloc(0), 32));
}

export class FakeTransitServer {
  readonly rootToken: string;
  readonly requests: RecordedRequest[] = [];
  appRoleLogins = 0;
  readonly #server: Server;
  readonly #keys = new Map<string, FakeKey>();
  readonly #appTokens = new Set<string>();
  readonly #faults: FakeFault[] = [];
  readonly #hung = new Set<ServerResponse>();
  readonly #mount: string;
  readonly #namespaces: Set<string>;
  readonly #appRole: FakeTransitOptions['appRole'];
  #sealed = false;
  url = '';

  private constructor(opts: FakeTransitOptions) {
    this.rootToken = opts.rootToken ?? `root-${randomUUID()}`;
    this.#mount = opts.mount ?? 'transit';
    this.#namespaces = new Set((opts.namespaces ?? []).map((n) => n.replace(/\/+$/, '')));
    this.#appRole = opts.appRole;
    this.#server = createServer((req, res) => {
      void this.#handle(req, res);
    });
  }

  static async start(opts: FakeTransitOptions = {}): Promise<FakeTransitServer> {
    const fake = new FakeTransitServer(opts);
    await new Promise<void>((resolve) => fake.#server.listen(0, '127.0.0.1', resolve));
    const { port } = fake.#server.address() as AddressInfo;
    fake.url = `http://127.0.0.1:${String(port)}`;
    return fake;
  }

  async close(): Promise<void> {
    for (const res of this.#hung) res.destroy();
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  /** The next requests (one fault each) answer with these faults instead of the real result. */
  inject(...faults: FakeFault[]): void {
    this.#faults.push(...faults);
  }

  /** Invalidate every token issued by AppRole login (simulates expiry/revocation). */
  revokeAppRoleTokens(): void {
    this.#appTokens.clear();
  }

  seal(sealed = true): void {
    this.#sealed = sealed;
  }

  count(pathSuffix: string): number {
    return this.requests.filter((r) => r.path.endsWith(pathSuffix)).length;
  }

  // ── request handling ────────────────────────────────────────────────────────────────────

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: Record<string, unknown> | undefined;
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return this.#error(res, 400, ['failed to parse JSON input']);
      }
    }
    const url = new URL(req.url ?? '/', 'http://fake');
    const token = header(req, 'x-vault-token');
    const namespace = header(req, 'x-vault-namespace');
    this.requests.push({ method: req.method ?? 'GET', path: url.pathname, token, namespace, body });

    const fault = this.#faults.shift();
    if (fault) {
      if ('hang' in fault) {
        this.#hung.add(res);
        return;
      }
      if ('reset' in fault) {
        req.socket.destroy();
        return;
      }
      if ('okData' in fault) return this.#ok(res, fault.okData);
      if ('redirect' in fault) {
        res.writeHead(307, { location: fault.redirect + url.pathname });
        res.end();
        return;
      }
      const headers: Record<string, string> = {};
      if (fault.retryAfter !== undefined) headers['retry-after'] = fault.retryAfter;
      return this.#error(res, fault.status, fault.errors ?? ['injected'], headers);
    }

    if (this.#sealed) return this.#error(res, 503, [TRANSIT_ERR.sealed]);
    if (namespace !== undefined && !this.#namespaces.has(namespace.replace(/\/+$/, ''))) {
      return this.#error(res, 404, [TRANSIT_ERR.namespaceNotFound]);
    }

    const path = url.pathname.replace(/^\/v1\//, '');
    const appRoleMount = this.#appRole?.mount ?? 'approle';
    if (req.method === 'POST' && path === `auth/${appRoleMount}/login`) {
      return this.#login(res, body);
    }
    if (token === undefined || (token !== this.rootToken && !this.#appTokens.has(token))) {
      return this.#error(res, 403, [TRANSIT_ERR.permissionDenied]);
    }
    const mountPrefix = `${this.#mount}/`;
    if (!path.startsWith(mountPrefix)) return this.#error(res, 404, [`no handler for route "${path}"`]);
    const parts = path.slice(mountPrefix.length).split('/');
    try {
      return this.#transit(req.method ?? 'GET', parts, body ?? {}, res);
    } catch (error) {
      if (error instanceof UserError) return this.#error(res, 400, [error.message]);
      throw error;
    }
  }

  #login(res: ServerResponse, body: Record<string, unknown> | undefined): void {
    const ar = this.#appRole;
    if (!ar || body?.['role_id'] !== ar.roleId || body['secret_id'] !== ar.secretId) {
      return this.#error(res, 400, ['invalid role or secret ID']);
    }
    this.appRoleLogins++;
    const token = `s.${randomBytes(18).toString('base64url')}`;
    this.#appTokens.add(token);
    this.#ok(res, null, {
      client_token: token,
      accessor: randomUUID(),
      policies: ['default', 'lf-transit'],
      token_policies: ['default', 'lf-transit'],
      metadata: { role_name: 'lf-api' },
      lease_duration: ar.leaseSeconds ?? 1200,
      renewable: true,
      entity_id: randomUUID(),
      token_type: 'service',
      orphan: true,
      mfa_requirement: null,
      num_uses: 0,
    });
  }

  #transit(method: string, parts: string[], body: Record<string, unknown>, res: ServerResponse) {
    const [op, a, b] = parts;
    if (op === 'keys' && a !== undefined && b === undefined && method === 'POST') {
      return this.#ok(res, this.#keyInfo(this.#createKey(a, body)));
    }
    if (op === 'keys' && a !== undefined && b === undefined && method === 'GET') {
      const key = this.#keys.get(a);
      if (!key) return this.#error(res, 404, []);
      return this.#ok(res, this.#keyInfo(key));
    }
    if (op === 'keys' && a !== undefined && b === 'rotate' && method === 'POST') {
      const key = this.#need(a);
      key.latest++;
      key.versions.set(key.latest, { material: randomBytes(32), created: nowSeconds() });
      return this.#ok(res, this.#keyInfo(key));
    }
    if (op === 'keys' && a !== undefined && b === 'config' && method === 'POST') {
      const key = this.#need(a);
      if (typeof body['min_decryption_version'] === 'number') {
        key.minDecryption = body['min_decryption_version'];
        for (const v of [...key.versions.keys()]) if (v < key.minDecryption) key.versions.delete(v);
      }
      if (typeof body['min_encryption_version'] === 'number') {
        key.minEncryption = body['min_encryption_version'];
      }
      return this.#ok(res, this.#keyInfo(key));
    }
    if (method !== 'POST' || a === undefined) return this.#error(res, 405, ['unsupported operation']);
    const key = this.#need(a);
    const context = decodeOptional(body['context'], 'context');
    if (op === 'encrypt') {
      const plaintext = decodeOptional(body['plaintext'], 'plaintext');
      if (!plaintext) throw new UserError('missing plaintext to encrypt');
      const version = this.#encryptVersion(key, body['key_version']);
      return this.#ok(res, {
        ciphertext: this.#encrypt(key, version, context, plaintext),
        key_version: version,
      });
    }
    if (op === 'decrypt') {
      const plaintext = this.#decrypt(key, body['ciphertext'], context);
      return this.#ok(res, { plaintext: plaintext.toString('base64') });
    }
    if (op === 'rewrap') {
      const plaintext = this.#decrypt(key, body['ciphertext'], context);
      const version = this.#encryptVersion(key, body['key_version']);
      return this.#ok(res, {
        ciphertext: this.#encrypt(key, version, context, plaintext),
        key_version: version,
      });
    }
    return this.#error(res, 404, [`no handler for route "${op ?? ''}"`]);
  }

  #createKey(name: string, body: Record<string, unknown>): FakeKey {
    const existing = this.#keys.get(name);
    if (existing) return existing;
    const key: FakeKey = {
      name,
      type: typeof body['type'] === 'string' ? body['type'] : 'aes256-gcm96',
      derived: body['derived'] === true,
      exportable: body['exportable'] === true,
      allowPlaintextBackup: body['allow_plaintext_backup'] === true,
      convergent: body['convergent_encryption'] === true,
      versions: new Map([[1, { material: randomBytes(32), created: nowSeconds() }]]),
      latest: 1,
      minDecryption: 1,
      minEncryption: 0,
    };
    this.#keys.set(name, key);
    return key;
  }

  /** Test helper: create a key directly (same effect as `POST keys/:name`). */
  createKey(name: string, opts: FakeKeyOptions = {}): void {
    const body: Record<string, unknown> = { derived: opts.derived ?? true };
    if (opts.type !== undefined) body['type'] = opts.type;
    if (opts.exportable !== undefined) body['exportable'] = opts.exportable;
    if (opts.allowPlaintextBackup !== undefined)
      body['allow_plaintext_backup'] = opts.allowPlaintextBackup;
    if (opts.convergent !== undefined) body['convergent_encryption'] = opts.convergent;
    this.#createKey(name, body);
  }

  #need(name: string): FakeKey {
    const key = this.#keys.get(name);
    if (!key) throw new UserError(TRANSIT_ERR.keyNotFound);
    return key;
  }

  #encryptVersion(key: FakeKey, requested: unknown): number {
    const v = typeof requested === 'number' && requested > 0 ? requested : key.latest;
    if (v > key.latest) throw new UserError('requested version for encryption is higher than the latest key version');
    if (key.minEncryption > 0 && v < key.minEncryption) {
      throw new UserError('requested version for encryption is less than the minimum encryption key version');
    }
    return v;
  }

  #encrypt(key: FakeKey, version: number, context: Buffer | undefined, plaintext: Buffer): string {
    if (key.type !== 'aes256-gcm96') throw new UserError(`fake supports aes256-gcm96 only`);
    if (key.derived && !context) throw new UserError(TRANSIT_ERR.missingContext);
    const nonce = randomBytes(NONCE);
    const cipher = createCipheriv('aes-256-gcm', deriveKey(key, version, context), nonce, {
      authTagLength: TAG,
    });
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return `vault:v${String(version)}:${Buffer.concat([nonce, ct, cipher.getAuthTag()]).toString('base64')}`;
  }

  #decrypt(key: FakeKey, ciphertext: unknown, context: Buffer | undefined): Buffer {
    if (typeof ciphertext !== 'string' || ciphertext === '') {
      throw new UserError('missing ciphertext to decrypt');
    }
    if (key.derived && !context) throw new UserError(TRANSIT_ERR.missingContext);
    const m = PREFIX.exec(ciphertext);
    if (!m) throw new UserError('invalid ciphertext: no prefix');
    const version = Number(m[1]);
    if (version < key.minDecryption) throw new UserError(TRANSIT_ERR.tooOld);
    if (version > key.latest || !key.versions.has(version)) {
      throw new UserError('invalid key version');
    }
    const blob = Buffer.from(m[2] ?? '', 'base64');
    if (blob.length < NONCE + TAG) throw new UserError('invalid ciphertext: too short');
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        deriveKey(key, version, context),
        blob.subarray(0, NONCE),
        { authTagLength: TAG },
      );
      decipher.setAuthTag(blob.subarray(blob.length - TAG));
      return Buffer.concat([decipher.update(blob.subarray(NONCE, blob.length - TAG)), decipher.final()]);
    } catch {
      throw new UserError(TRANSIT_ERR.authFailed);
    }
  }

  #keyInfo(key: FakeKey): Record<string, unknown> {
    const keys: Record<string, number> = {};
    for (const [v, { created }] of key.versions) keys[String(v)] = created;
    const info: Record<string, unknown> = {
      allow_plaintext_backup: key.allowPlaintextBackup,
      auto_rotate_period: 0,
      deletion_allowed: false,
      derived: key.derived,
      exportable: key.exportable,
      imported_key: false,
      keys,
      latest_version: key.latest,
      min_available_version: 0,
      min_decryption_version: key.minDecryption,
      min_encryption_version: key.minEncryption,
      name: key.name,
      soft_deleted: false,
      supports_decryption: true,
      supports_derivation: true,
      supports_encryption: true,
      supports_signing: false,
      type: key.type,
    };
    if (key.derived) {
      info['convergent_encryption'] = key.convergent;
      info['kdf'] = 'hkdf_sha256';
    }
    return info;
  }

  #ok(res: ServerResponse, data: unknown, auth: unknown = null): void {
    const payload = JSON.stringify({
      request_id: randomUUID(),
      lease_id: '',
      renewable: false,
      lease_duration: 0,
      data,
      wrap_info: null,
      warnings: null,
      auth,
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(payload);
  }

  #error(res: ServerResponse, status: number, errors: string[], headers: Record<string, string> = {}) {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify({ errors }));
  }
}

class UserError extends Error {}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function decodeOptional(value: unknown, field: string): Buffer | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new UserError(`failed to base64-decode ${field}`);
  }
  return Buffer.from(value, 'base64');
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
