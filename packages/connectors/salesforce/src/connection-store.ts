/**
 * Self-host Salesforce connection store (design §5.2, §6.1, §6.6; ADR-0007; ADR-0018; migration
 * 0017; DL-0106, DL-0107). The RSA private key and the cached access token are sealed with
 * envelope encryption, AAD-bound to tenant, company, row and field, so a ciphertext copied to
 * another row fails to open. Read paths select only non-secret columns; getAccessToken() is the
 * single call that decrypts, under a row lock so concurrent callers share one exchange.
 */
import type { Database } from '@ledgerforce/db';
import { openField, sealField, type Kms, type SealedField } from '@ledgerforce/shared/crypto';
import { sql, type Transaction } from 'kysely';
import {
  certificateExpiryStatus,
  inspectCredentials,
  type CertificateStatus,
} from './certificate.ts';
import {
  assertLoginUrl,
  buildJwtAssertion,
  SalesforceConfigError,
  type SalesforceLoginUrl,
} from './jwt.ts';
import { exchangeJwtAssertion, type HttpPost } from './token-client.ts';

/** Re-sign after this long even without a 401: Salesforce's shortest session timeout (DL-0106). */
export const DEFAULT_TOKEN_MAX_AGE_SECONDS = 15 * 60;

export class SalesforceConnectionNotFound extends Error {
  constructor() {
    super('no active Salesforce connection with that id');
    this.name = 'SalesforceConnectionNotFound';
  }
}

export interface JwtConnectionInput {
  loginUrl: SalesforceLoginUrl;
  username: string;
  consumerKey: string;
  privateKeyPem: string;
  /** The certificate uploaded to the External Client App (public). */
  certificatePem: string;
  createdBy?: string;
  now?: Date;
}

export interface SalesforceConnectionView {
  id: string;
  companyId: string;
  authFlow: 'jwt_bearer' | 'authorization_code_pkce';
  loginUrl: string;
  username: string;
  consumerKey: string;
  instanceUrl: string | null;
  status: 'active' | 'superseded' | 'disabled';
  /** Whether a token is cached; the token itself is never returned here. */
  accessToken: 'cached' | 'none';
  accessTokenObtainedAt: Date | null;
  certificate: (CertificateStatus & { sha256Fingerprint: string }) | null;
  createdAt: Date;
}

type Field = 'private_key' | 'access_token';
const aadFor = (tenantId: string, companyId: string, id: string, field: Field) =>
  `lf-field-v1|${tenantId}|${companyId}|app.salesforce_connection|${id}|${field}`;

/** Save a JWT bearer connection; an existing active one for the company becomes superseded. */
export async function createJwtConnection(
  trx: Transaction<Database>,
  kms: Kms,
  companyId: string,
  input: JwtConnectionInput,
): Promise<string> {
  assertLoginUrl(input.loginUrl);
  const username = input.username.trim();
  const consumerKey = input.consumerKey.trim();
  if (!/^[^\s@]+@[^\s@]+$/.test(username) || username.length > 80) {
    throw new SalesforceConfigError('integration username must look like user@domain');
  }
  if (!/^\S{1,255}$/.test(consumerKey)) throw new SalesforceConfigError('consumer key is invalid');
  const cert = inspectCredentials(
    input.privateKeyPem,
    input.certificatePem,
    input.now ?? new Date(),
  );
  const ids = await sql<{ id: string; tenant_id: string }>`
    SELECT app.uuid_generate_v7() AS id, current_setting('app.tenant_id', true) AS tenant_id`.execute(
    trx,
  );
  const row = ids.rows[0];
  if (!row?.tenant_id) throw new Error('createJwtConnection must run inside a tenant transaction');
  const sealed = await sealField(
    kms,
    input.privateKeyPem,
    aadFor(row.tenant_id, companyId, row.id, 'private_key'),
  );
  await trx
    .updateTable('app.salesforce_connection')
    .set({ status: 'superseded' })
    .where('company_id', '=', companyId)
    .where('status', '=', 'active')
    .execute();
  await trx
    .insertInto('app.salesforce_connection')
    .values({
      id: row.id,
      company_id: companyId,
      auth_flow: 'jwt_bearer',
      login_url: input.loginUrl,
      username,
      consumer_key: consumerKey,
      private_key_ct: sealed.ciphertext,
      private_key_iv: sealed.iv,
      private_key_tag: sealed.tag,
      private_key_dek_wrapped: sealed.wrappedDek,
      private_key_kek_id: sealed.keyId,
      private_key_enc_version: sealed.version,
      cert_not_after: cert.notAfter,
      cert_sha256: cert.sha256Fingerprint,
      created_by: input.createdBy ?? null,
    })
    .execute();
  return row.id;
}

const VIEW_COLUMNS = [
  'id',
  'company_id',
  'auth_flow',
  'login_url',
  'username',
  'consumer_key',
  'instance_url',
  'status',
  'access_token_obtained_at',
  'cert_not_after',
  'cert_sha256',
  'created_at',
] as const;

type ViewRow = {
  id: string;
  company_id: string;
  auth_flow: 'jwt_bearer' | 'authorization_code_pkce';
  login_url: string;
  username: string;
  consumer_key: string;
  instance_url: string | null;
  status: 'active' | 'superseded' | 'disabled';
  access_token_obtained_at: Date | null;
  cert_not_after: Date | null;
  cert_sha256: string | null;
  created_at: Date;
};

function toView(r: ViewRow, now: Date): SalesforceConnectionView {
  return {
    id: r.id,
    companyId: r.company_id,
    authFlow: r.auth_flow,
    loginUrl: r.login_url,
    username: r.username,
    consumerKey: r.consumer_key,
    instanceUrl: r.instance_url,
    status: r.status,
    accessToken: r.access_token_obtained_at ? 'cached' : 'none',
    accessTokenObtainedAt: r.access_token_obtained_at,
    certificate:
      r.cert_not_after && r.cert_sha256
        ? { ...certificateExpiryStatus(r.cert_not_after, now), sha256Fingerprint: r.cert_sha256 }
        : null,
    createdAt: r.created_at,
  };
}

/** One connection without secrets, with its certificate expiry status. */
export async function getConnection(
  trx: Transaction<Database>,
  id: string,
  now: Date = new Date(),
): Promise<SalesforceConnectionView> {
  const r = await trx
    .selectFrom('app.salesforce_connection')
    .select(VIEW_COLUMNS)
    .where('id', '=', id)
    .executeTakeFirst();
  if (!r) throw new SalesforceConnectionNotFound();
  return toView(r, now);
}

/** All connections of a company (newest first), without secrets. */
export async function listConnections(
  trx: Transaction<Database>,
  companyId: string,
  now: Date = new Date(),
): Promise<SalesforceConnectionView[]> {
  const rows = await trx
    .selectFrom('app.salesforce_connection')
    .select(VIEW_COLUMNS)
    .where('company_id', '=', companyId)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .execute();
  return rows.map((r) => toView(r, now));
}

export interface TokenOptions {
  http: HttpPost;
  now?: Date;
  maxAgeSeconds?: number;
}

export interface AccessToken {
  accessToken: string;
  instanceUrl: string;
}

const sealedOf = (
  ct: Buffer | null,
  iv: Buffer | null,
  tag: Buffer | null,
  wrapped: Buffer | null,
  keyId: string | null,
  version: number | null,
): SealedField | null =>
  ct && iv && tag && wrapped && keyId && version !== null
    ? { ciphertext: ct, iv, tag, wrappedDek: wrapped, keyId, version }
    : null;

/**
 * The cached access token of an active connection, or a new one from a freshly signed
 * assertion when none is cached or it is older than maxAgeSeconds. Locks the row (FOR UPDATE)
 * so concurrent callers wait for one exchange. Throws SalesforceAuthError on refusal.
 */
export async function getAccessToken(
  trx: Transaction<Database>,
  kms: Kms,
  connectionId: string,
  opts: TokenOptions,
): Promise<AccessToken> {
  const now = opts.now ?? new Date();
  const maxAgeMs = (opts.maxAgeSeconds ?? DEFAULT_TOKEN_MAX_AGE_SECONDS) * 1000;
  const r = await trx
    .selectFrom('app.salesforce_connection')
    .selectAll()
    .where('id', '=', connectionId)
    .where('status', '=', 'active')
    .forUpdate()
    .executeTakeFirst();
  if (!r) throw new SalesforceConnectionNotFound();

  const cached = sealedOf(
    r.access_token_ct,
    r.access_token_iv,
    r.access_token_tag,
    r.access_token_dek_wrapped,
    r.access_token_kek_id,
    r.access_token_enc_version,
  );
  const obtained = r.access_token_obtained_at?.getTime();
  if (
    cached &&
    r.instance_url &&
    obtained !== undefined &&
    now.getTime() - obtained < maxAgeMs &&
    obtained <= now.getTime()
  ) {
    const accessToken = await openField(
      kms,
      cached,
      aadFor(r.tenant_id, r.company_id, r.id, 'access_token'),
    );
    return { accessToken, instanceUrl: r.instance_url };
  }

  const key = sealedOf(
    r.private_key_ct,
    r.private_key_iv,
    r.private_key_tag,
    r.private_key_dek_wrapped,
    r.private_key_kek_id,
    r.private_key_enc_version,
  );
  if (r.auth_flow !== 'jwt_bearer' || !key)
    throw new SalesforceConfigError('connection has no JWT bearer key');
  assertLoginUrl(r.login_url);
  const privateKeyPem = await openField(
    kms,
    key,
    aadFor(r.tenant_id, r.company_id, r.id, 'private_key'),
  );
  const assertion = buildJwtAssertion({
    consumerKey: r.consumer_key,
    username: r.username,
    audience: r.login_url,
    privateKeyPem,
    now,
  });
  const grant = await exchangeJwtAssertion(opts.http, r.login_url, assertion);
  const sealed = await sealField(
    kms,
    grant.accessToken,
    aadFor(r.tenant_id, r.company_id, r.id, 'access_token'),
  );
  await trx
    .updateTable('app.salesforce_connection')
    .set({
      instance_url: grant.instanceUrl,
      access_token_ct: sealed.ciphertext,
      access_token_iv: sealed.iv,
      access_token_tag: sealed.tag,
      access_token_dek_wrapped: sealed.wrappedDek,
      access_token_kek_id: sealed.keyId,
      access_token_enc_version: sealed.version,
      access_token_obtained_at: now,
    })
    .where('id', '=', r.id)
    .execute();
  return { accessToken: grant.accessToken, instanceUrl: grant.instanceUrl };
}

/** Forget the cached token (call after Salesforce answers 401); the next call re-signs. */
export async function invalidateAccessToken(
  trx: Transaction<Database>,
  connectionId: string,
): Promise<void> {
  await trx
    .updateTable('app.salesforce_connection')
    .set({
      access_token_ct: null,
      access_token_iv: null,
      access_token_tag: null,
      access_token_dek_wrapped: null,
      access_token_kek_id: null,
      access_token_enc_version: null,
      access_token_obtained_at: null,
    })
    .where('id', '=', connectionId)
    .execute();
}
