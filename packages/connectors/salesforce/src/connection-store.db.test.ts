/**
 * SS-PLAT-51 — the self-host Salesforce connection keeps its private key and access token
 * envelope-encrypted at rest (design §6.1 integration token theft, §6.6; ADR-0018; migration
 * 0017) and no read path returns either. Tokens come from the local fake token endpoint, which
 * verifies the signature with the certificate's public key (RQ-0024); no Salesforce org is used.
 */
import { createDb, withTenant, type Database } from '@ledgerforce/db';
import { createTestDatabase, type TestDatabase } from '@ledgerforce/db/testing';
import { DecryptionError, LocalKeyringKms } from '@ledgerforce/shared/crypto';
import { randomBytes } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SalesforceConfigError } from './jwt.ts';
import {
  createJwtConnection,
  getAccessToken,
  getConnection,
  invalidateAccessToken,
  listConnections,
  SalesforceConnectionNotFound,
} from './connection-store.ts';
import { SalesforceAuthError } from './token-client.ts';
import { startFakeTokenEndpoint, type FakeTokenEndpoint } from './testing/fake-token-endpoint.ts';
import { generateTestKeyPair, selfSignedCertificate } from './testing/keys.ts';

const T = '01900000-0000-7000-8000-00000000063a';
const DAY = 86_400_000;
const AUD = 'https://test.salesforce.com';
const KEY = '3MVG9TEST.consumer.key';
const USER = 'integration@harbour.example';
let tdb: TestDatabase;
let db: Kysely<Database>;
let su: Kysely<Database>;
let companyId: string;
let otherCompanyId: string;
let fake: FakeTokenEndpoint;
const kms = LocalKeyringKms.fromJson(
  JSON.stringify({ active: 'k1', keys: { k1: randomBytes(32).toString('base64') } }),
);
const keys = generateTestKeyPair();
const now = new Date();
/** The fake endpoint's clock, moved with the caller's `now` when a test travels in time. */
let clock = now;
const cert = selfSignedCertificate(
  keys,
  new Date(now.getTime() - DAY),
  new Date(now.getTime() + 20 * DAY + 12 * 3_600_000),
);
const pemBody = keys.privateKeyPem.split('\n').filter((l) => l && !l.startsWith('-----'));
const inTenant = <R>(fn: (trx: Transaction<Database>) => Promise<R>) => withTenant(db, T, fn);
const input = {
  loginUrl: AUD,
  username: USER,
  consumerKey: KEY,
  privateKeyPem: keys.privateKeyPem,
  certificatePem: cert,
} as const;

/** Every column of the stored row, as text and hex, must not contain `needle`. */
async function expectNotAtRest(id: string, needles: string[]) {
  const raw = await su
    .selectFrom('app.salesforce_connection')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  for (const [column, value] of Object.entries(raw)) {
    const text = Buffer.isBuffer(value)
      ? value.toString('latin1') + value.toString('hex') + value.toString('base64')
      : String(value);
    for (const n of needles) expect(text, column).not.toContain(n);
  }
  const dump = await sql<{ t: string }>`
    SELECT x::text AS t FROM app.salesforce_connection x WHERE id = ${id}`.execute(su);
  for (const n of needles) expect(dump.rows[0]?.t).not.toContain(n);
  return raw;
}

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: true });
  db = createDb(tdb.url('lf_app'), 3);
  su = createDb(tdb.url('superuser'), 1);
  ({ companyId, otherCompanyId } = await inTenant(async (trx) => {
    await trx.insertInto('app.tenant').values({ id: T, name: 'Harbour & Co Pty Ltd' }).execute();
    const [a, b] = await trx
      .insertInto('app.company')
      .values([
        { name: 'Harbour & Co Pty Ltd', base_currency: 'AUD' },
        { name: 'Harbour Trading Pty Ltd', base_currency: 'AUD' },
      ])
      .returning('id')
      .execute();
    return { companyId: a?.id ?? '', otherCompanyId: b?.id ?? '' };
  }));
  fake = await startFakeTokenEndpoint({
    certificatePem: cert,
    consumerKey: KEY,
    audience: AUD,
    users: { [USER]: { preauthorized: true }, 'new@harbour.example': { preauthorized: false } },
    now: () => clock,
  });
});

afterAll(async () => {
  await fake.close();
  await su.destroy();
  await db.destroy();
  await tdb.close();
});

describe('SS-PLAT-51: Salesforce connection secrets encrypted at rest, never returned', () => {
  let id: string;

  it('stores the private key as ciphertext: no column contains the PEM', async () => {
    id = await inTenant((trx) => createJwtConnection(trx, kms, companyId, input));
    const raw = await expectNotAtRest(id, [...pemBody, 'PRIVATE KEY']);
    expect(raw).toMatchObject({
      login_url: AUD,
      username: USER,
      consumer_key: KEY,
      status: 'active',
      private_key_kek_id: 'k1',
      private_key_enc_version: 1,
      access_token_ct: null,
    });
    expect(raw.cert_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('exchanges a signed assertion for a token, caches it encrypted, and reuses it', async () => {
    const before = fake.requests.length;
    const first = await inTenant((trx) => getAccessToken(trx, kms, id, { http: fake.http, now }));
    expect(fake.requests.length).toBe(before + 1);
    expect(first).toEqual({
      accessToken: fake.issued.at(-1),
      instanceUrl: 'https://harbour-dev-ed.develop.my.salesforce.com',
    });
    await expectNotAtRest(id, [first.accessToken, first.accessToken.split('!')[1] ?? 'x']);
    const again = await inTenant((trx) => getAccessToken(trx, kms, id, { http: fake.http, now }));
    expect(again).toEqual(first);
    expect(fake.requests.length).toBe(before + 1);
  });

  it('re-signs after the cache window and after a 401 invalidation', async () => {
    const before = fake.requests.length;
    const later = new Date(now.getTime() + 16 * 60_000);
    clock = later;
    const renewed = await inTenant((trx) =>
      getAccessToken(trx, kms, id, { http: fake.http, now: later }),
    );
    expect(fake.requests.length).toBe(before + 1);
    expect(renewed.accessToken).toBe(fake.issued.at(-1));
    await inTenant((trx) => invalidateAccessToken(trx, id));
    const raw = await su
      .selectFrom('app.salesforce_connection')
      .select(['access_token_ct', 'access_token_obtained_at'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(raw).toEqual({ access_token_ct: null, access_token_obtained_at: null });
    const fresh = await inTenant((trx) =>
      getAccessToken(trx, kms, id, { http: fake.http, now: later }),
    );
    expect(fake.requests.length).toBe(before + 2);
    expect(fresh.accessToken).not.toBe(renewed.accessToken);
    clock = now;
  });

  it('concurrent callers share one exchange (row lock, single flight)', async () => {
    await inTenant((trx) => invalidateAccessToken(trx, id));
    const before = fake.requests.length;
    const [a, b] = await Promise.all([
      inTenant((trx) => getAccessToken(trx, kms, id, { http: fake.http, now })),
      inTenant((trx) => getAccessToken(trx, kms, id, { http: fake.http, now })),
    ]);
    expect(fake.requests.length).toBe(before + 1);
    expect(a).toEqual(b);
  });

  it('read paths return the connection and certificate status, never a secret', async () => {
    const view = await inTenant((trx) => getConnection(trx, id, now));
    expect(view).toMatchObject({
      id,
      companyId,
      authFlow: 'jwt_bearer',
      loginUrl: AUD,
      username: USER,
      consumerKey: KEY,
      instanceUrl: 'https://harbour-dev-ed.develop.my.salesforce.com',
      status: 'active',
      accessToken: 'cached',
      certificate: { status: 'expiring_soon', daysLeft: 20 },
    });
    expect(view.certificate?.sha256Fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const list = await inTenant((trx) => listConnections(trx, companyId, now));
    expect(list.map((c) => c.id)).toEqual([id]);
    const token = await inTenant((trx) => getAccessToken(trx, kms, id, { http: fake.http, now }));
    for (const json of [JSON.stringify(view), JSON.stringify(list)]) {
      for (const line of pemBody) expect(json).not.toContain(line);
      expect(json).not.toContain(token.accessToken);
      expect(json).not.toMatch(/_ct|dek|kek|iv"|tag"|privateKey"|"ciphertext/i);
    }
  });

  it('a ciphertext copied onto another connection cannot be decrypted there', async () => {
    const otherKeys = generateTestKeyPair();
    const victim = await inTenant((trx) =>
      createJwtConnection(trx, kms, otherCompanyId, {
        ...input,
        privateKeyPem: otherKeys.privateKeyPem,
        certificatePem: selfSignedCertificate(
          otherKeys,
          new Date(now.getTime() - DAY),
          new Date(now.getTime() + 300 * DAY),
        ),
      }),
    );
    await sql`
      UPDATE app.salesforce_connection v
         SET private_key_ct = s.private_key_ct, private_key_iv = s.private_key_iv,
             private_key_tag = s.private_key_tag, private_key_dek_wrapped = s.private_key_dek_wrapped,
             private_key_kek_id = s.private_key_kek_id
        FROM app.salesforce_connection s
       WHERE v.id = ${victim} AND s.id = ${id}`.execute(su);
    await expect(
      inTenant((trx) => getAccessToken(trx, kms, victim, { http: fake.http, now })),
    ).rejects.toBeInstanceOf(DecryptionError);
    // The cached access token, copied the same way, does not open either.
    await sql`
      UPDATE app.salesforce_connection v
         SET access_token_ct = s.access_token_ct, access_token_iv = s.access_token_iv,
             access_token_tag = s.access_token_tag, access_token_dek_wrapped = s.access_token_dek_wrapped,
             access_token_kek_id = s.access_token_kek_id, access_token_enc_version = s.access_token_enc_version,
             access_token_obtained_at = s.access_token_obtained_at, instance_url = s.instance_url
        FROM app.salesforce_connection s
       WHERE v.id = ${victim} AND s.id = ${id}`.execute(su);
    await expect(
      inTenant((trx) => getAccessToken(trx, kms, victim, { http: fake.http, now })),
    ).rejects.toBeInstanceOf(DecryptionError);
    // The source row is unaffected.
    const ok = await inTenant((trx) => getAccessToken(trx, kms, id, { http: fake.http, now }));
    expect(ok.accessToken.length).toBeGreaterThan(10);
  });

  it('token-endpoint failures surface as mapped codes and store no token', async () => {
    const other = generateTestKeyPair();
    const pending = await inTenant((trx) =>
      createJwtConnection(trx, kms, otherCompanyId, {
        ...input,
        username: 'new@harbour.example',
        privateKeyPem: other.privateKeyPem,
        certificatePem: selfSignedCertificate(
          other,
          new Date(now.getTime() - DAY),
          new Date(now.getTime() + 90 * DAY),
        ),
      }),
    );
    const error = await inTenant((trx) =>
      getAccessToken(trx, kms, pending, { http: fake.http, now }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SalesforceAuthError);
    // The fake only knows the first certificate, so a different key is an invalid assertion.
    expect((error as SalesforceAuthError).code).toBe('invalid_assertion');
    const raw = await su
      .selectFrom('app.salesforce_connection')
      .select(['access_token_ct'])
      .where('id', '=', pending)
      .executeTakeFirstOrThrow();
    expect(raw.access_token_ct).toBeNull();
  });

  it('a new connection for the company supersedes the old one (rotation); superseded rows give no token', async () => {
    const before = await inTenant((trx) => listConnections(trx, otherCompanyId, now));
    expect(before.filter((c) => c.status === 'active')).toHaveLength(1);
    const after = await inTenant((trx) => listConnections(trx, otherCompanyId, now));
    expect(after.length).toBeGreaterThanOrEqual(2);
    const superseded = after.find((c) => c.status === 'superseded');
    expect(superseded).toBeDefined();
    await expect(
      inTenant((trx) => getAccessToken(trx, kms, superseded?.id ?? '', { http: fake.http, now })),
    ).rejects.toBeInstanceOf(SalesforceConnectionNotFound);
    await expect(
      su
        .updateTable('app.salesforce_connection')
        .set({ status: 'active' })
        .where('company_id', '=', otherCompanyId)
        .execute(),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('refuses a key that does not match the certificate, before anything is stored', async () => {
    await expect(
      inTenant((trx) =>
        createJwtConnection(trx, kms, companyId, {
          ...input,
          privateKeyPem: generateTestKeyPair().privateKeyPem,
        }),
      ),
    ).rejects.toBeInstanceOf(SalesforceConfigError);
    const list = await inTenant((trx) => listConnections(trx, companyId, now));
    expect(list.map((c) => c.id)).toEqual([id]);
  });

  it('lf_app cannot rewrite the key, identity or certificate columns, nor delete', async () => {
    for (const set of [
      sql`private_key_ct = '\\x00'::bytea`,
      sql`username = 'other@harbour.example'`,
      sql`login_url = 'https://login.salesforce.com'`,
      sql`cert_not_after = now() + interval '10 years'`,
      sql`consumer_key = 'x'`,
    ]) {
      await expect(
        inTenant((trx) =>
          sql`UPDATE app.salesforce_connection SET ${set} WHERE id = ${id}`.execute(trx),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    }
    await expect(
      inTenant((trx) => sql`DELETE FROM app.salesforce_connection WHERE id = ${id}`.execute(trx)),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('the database refuses any other login URL and half-written secrets', async () => {
    const copy = (overrides: ReturnType<typeof sql>) =>
      inTenant((trx) =>
        sql`INSERT INTO app.salesforce_connection
              (id, company_id, login_url, username, consumer_key, private_key_ct, private_key_iv,
               private_key_tag, private_key_dek_wrapped, private_key_kek_id, private_key_enc_version,
               cert_not_after, cert_sha256, status, access_token_ct)
            SELECT app.uuid_generate_v7(), company_id, ${overrides}, username, consumer_key,
                   private_key_ct, private_key_iv, private_key_tag, private_key_dek_wrapped,
                   private_key_kek_id, private_key_enc_version, cert_not_after, cert_sha256,
                   'disabled', NULL
              FROM app.salesforce_connection WHERE id = ${id}`.execute(trx),
      );
    await expect(copy(sql`'https://evil.example'`)).rejects.toMatchObject({ code: '23514' });
    await expect(copy(sql`'https://harbour.my.salesforce.com'`)).rejects.toMatchObject({
      code: '23514',
    });
    await copy(sql`'https://login.salesforce.com'`); // positive control
    await inTenant((trx) => invalidateAccessToken(trx, id));
    await expect(
      inTenant((trx) =>
        sql`UPDATE app.salesforce_connection SET access_token_ct = '\\x01'::bytea WHERE id = ${id}`.execute(
          trx,
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
