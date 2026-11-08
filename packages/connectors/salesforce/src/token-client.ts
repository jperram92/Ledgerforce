/**
 * Token exchange for the JWT bearer flow (RQ-0024 F2–F4, DL-0105). The HTTP client is injected
 * (production: fetch; tests: a local fake endpoint). Errors map to stable codes and never carry
 * the assertion or a token.
 */
import { assertLoginUrl } from './jwt.ts';

export type HttpPost = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string },
) => Promise<{ status: number; text(): Promise<string> }>;

/** Production client: global fetch. */
export const fetchHttpPost: HttpPost = async (url, init) => {
  const res = await fetch(url, { ...init, redirect: 'error' });
  return { status: res.status, text: () => res.text() };
};

export const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

export const tokenEndpoint = (audience: string): string => {
  assertLoginUrl(audience);
  return `${audience}/services/oauth2/token`;
};

export type SalesforceAuthErrorCode =
  | 'not_preauthorized'
  | 'invalid_audience'
  | 'invalid_assertion'
  | 'invalid_user'
  | 'ip_restricted'
  | 'invalid_grant'
  | 'invalid_client'
  | 'unsupported_grant_type'
  | 'token_endpoint_unavailable'
  | 'malformed_response';

const HINTS: Record<SalesforceAuthErrorCode, string> = {
  not_preauthorized:
    'the External Client App is not pre-authorised for the integration user (admin-approved users + permission set)',
  invalid_audience: 'the login URL does not match the org (production vs sandbox)',
  invalid_assertion:
    'the assertion was refused: key does not match the uploaded certificate, certificate expired, or clock skew',
  invalid_user: 'the integration user is unknown, inactive or frozen',
  ip_restricted: 'the IP policy or login hours refuse this server',
  invalid_grant: 'Salesforce refused the grant',
  invalid_client: 'the consumer key is not known to the org',
  unsupported_grant_type:
    'the app does not accept the JWT bearer grant (OAuth settings / digital signature missing)',
  token_endpoint_unavailable: 'the Salesforce token endpoint could not be reached',
  malformed_response: 'the token endpoint answered without a usable access token',
};

export class SalesforceAuthError extends Error {
  readonly code: SalesforceAuthErrorCode;
  readonly retryable: boolean;
  readonly status: number | null;
  /** Salesforce's error_description, truncated; never contains secrets. */
  readonly description: string | null;

  constructor(code: SalesforceAuthErrorCode, status: number | null, description: string | null) {
    super(`salesforce auth failed (${code}): ${HINTS[code]}`);
    this.name = 'SalesforceAuthError';
    this.code = code;
    this.retryable = code === 'token_endpoint_unavailable';
    this.status = status;
    this.description = description;
  }
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Map a non-2xx token-endpoint response to a stable code (RQ-0024 F4). */
export function mapTokenError(status: number, bodyText: string): SalesforceAuthError {
  const body = parseJson(bodyText);
  if (status >= 500 || !body || typeof body.error !== 'string') {
    return new SalesforceAuthError('token_endpoint_unavailable', status, null);
  }
  const error = body.error.toLowerCase();
  const raw = typeof body.error_description === 'string' ? body.error_description : '';
  const desc = raw.toLowerCase();
  const description = raw ? raw.slice(0, 200) : null;
  let code: SalesforceAuthErrorCode;
  if (error === 'invalid_grant') {
    if (desc.includes('approved')) code = 'not_preauthorized';
    else if (desc.includes('audience')) code = 'invalid_audience';
    else if (desc.includes('assertion')) code = 'invalid_assertion';
    else if (desc.includes('ip restricted') || desc.includes('login hours')) code = 'ip_restricted';
    else if (desc.includes('user')) code = 'invalid_user';
    else code = 'invalid_grant';
  } else if (error === 'invalid_client_id' || error === 'invalid_client') {
    code = 'invalid_client';
  } else if (error === 'unsupported_grant_type') {
    code = 'unsupported_grant_type';
  } else {
    code = 'invalid_grant';
  }
  return new SalesforceAuthError(code, status, description);
}

export interface TokenGrant {
  accessToken: string;
  instanceUrl: string;
  issuedAt: Date | null;
  scope: string | null;
}

export async function exchangeJwtAssertion(
  http: HttpPost,
  audience: string,
  assertion: string,
): Promise<TokenGrant> {
  const url = tokenEndpoint(audience);
  let status: number;
  let text: string;
  try {
    const res = await http(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: JWT_BEARER_GRANT, assertion }).toString(),
    });
    status = res.status;
    text = await res.text();
  } catch {
    throw new SalesforceAuthError('token_endpoint_unavailable', null, null);
  }
  if (status < 200 || status >= 300) throw mapTokenError(status, text);
  const body = parseJson(text);
  const accessToken = body?.access_token;
  const instanceUrl = body?.instance_url;
  if (
    typeof accessToken !== 'string' ||
    accessToken.length === 0 ||
    typeof instanceUrl !== 'string' ||
    !/^https:\/\/[A-Za-z0-9.-]+(:[0-9]+)?\/?$/.test(instanceUrl)
  ) {
    throw new SalesforceAuthError('malformed_response', status, null);
  }
  const issued = Number(body?.issued_at);
  return {
    accessToken,
    instanceUrl: instanceUrl.replace(/\/$/, ''),
    issuedAt: Number.isFinite(issued) && issued > 0 ? new Date(issued) : null,
    scope: typeof body?.scope === 'string' ? body.scope : null,
  };
}
