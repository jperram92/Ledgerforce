/**
 * Salesforce REST query client for the polling fallback (T-0066, design §5.3, RQ-0103).
 *
 * `queryAllPages` runs one SOQL through `queryAll` (so soft-deleted rows come back with
 * `IsDeleted = true`) and yields each page of ≤ 2,000 records, following `nextRecordsUrl` (which
 * points under `/query/` even for a queryAll — RQ-0103 S3). Every page is one API call; the shared
 * ApiUsageGate is checked before each call and fed from `Sforce-Limit-Info` after it (design §5.6
 * rule 3). Non-2xx answers become the write-back's classified, secret-free SalesforceApiError.
 */
import {
  classifyHttpError,
  parseRetryAfter,
  SALESFORCE_REST_API_VERSION,
  SalesforceApiError,
  type RestSession,
} from '../writeback/collections.ts';

export type HttpGet = (
  url: string,
  init: { method: 'GET'; headers: Record<string, string> },
) => Promise<{ status: number; header(name: string): string | null; text(): Promise<string> }>;

/** Production client: global fetch, no redirects (a redirect would forward the bearer token). */
export const fetchHttpGet: HttpGet = async (url, init) => {
  const res = await fetch(url, { ...init, redirect: 'error' });
  return { status: res.status, header: (n) => res.headers.get(n), text: () => res.text() };
};

export type QuerySession = Omit<RestSession, 'http'> & { http: HttpGet };

/** A record as the query resource returns it (`attributes` removed). */
export type SfRecord = Record<string, unknown>;

/** One authenticated, throttled GET of a REST resource; classified errors, parsed JSON. */
export async function restGet(session: QuerySession, path: string): Promise<unknown> {
  session.gate?.assertWithinBudget(session.instanceUrl, session.budgetShare);
  let res: Awaited<ReturnType<HttpGet>>;
  let text: string;
  try {
    res = await session.http(`${session.instanceUrl}${path}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${session.accessToken}`, accept: 'application/json' },
    });
    text = await res.text();
  } catch {
    throw new SalesforceApiError('unavailable', null, null, 'Salesforce could not be reached');
  }
  session.gate?.observe(session.instanceUrl, res.header('sforce-limit-info'));
  if (res.status < 200 || res.status >= 300) {
    const now = session.now?.() ?? new Date();
    throw classifyHttpError(res.status, text, parseRetryAfter(res.header('retry-after'), now));
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SalesforceApiError('malformed_response', res.status, null, 'body is not JSON');
  }
}

/** `/services/data/vXX.X` of the session. */
export const dataPath = (s: QuerySession) =>
  `/services/data/v${s.apiVersion ?? SALESFORCE_REST_API_VERSION}`;

/** Pages of a queryAll, in the query's order. */
export async function* queryAllPages(
  session: QuerySession,
  soql: string,
): AsyncGenerator<SfRecord[]> {
  let path: string | null = `${dataPath(session)}/queryAll/?q=${encodeURIComponent(soql)}`;
  while (path !== null) {
    const body = (await restGet(session, path)) as {
      done?: unknown;
      nextRecordsUrl?: unknown;
      records?: unknown;
    } | null;
    if (!body || !Array.isArray(body.records) || typeof body.done !== 'boolean') {
      throw new SalesforceApiError('malformed_response', 200, null, 'not a query result');
    }
    yield (body.records as Record<string, unknown>[]).map(({ attributes: _a, ...r }) => r);
    if (body.done) path = null;
    else if (
      typeof body.nextRecordsUrl === 'string' &&
      body.nextRecordsUrl.startsWith('/services/data/')
    )
      path = body.nextRecordsUrl;
    else
      throw new SalesforceApiError(
        'malformed_response',
        200,
        null,
        'done: false without nextRecordsUrl',
      );
  }
}

/** Field names of an object the session can query (sObject Describe; one API call). */
export async function describeFields(session: QuerySession, entity: string): Promise<Set<string>> {
  const body = (await restGet(session, `${dataPath(session)}/sobjects/${entity}/describe`)) as {
    fields?: unknown;
  } | null;
  if (!body || !Array.isArray(body.fields)) {
    throw new SalesforceApiError('malformed_response', 200, null, 'not a describe result');
  }
  return new Set(
    (body.fields as { name?: unknown }[]).flatMap((f) =>
      typeof f.name === 'string' ? [f.name] : [],
    ),
  );
}
