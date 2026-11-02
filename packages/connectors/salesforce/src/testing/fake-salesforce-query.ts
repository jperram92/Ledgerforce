/**
 * Test-only local stand-in for the Salesforce REST query resources used by the polling fallback
 * (T-0066, RQ-0103). It runs on 127.0.0.1 and answers as the documented API does
 * (fixtures/documented/rest-query-responses.json):
 *
 *  - `GET /services/data/v67.0/queryAll/?q=<SOQL>` includes soft-deleted rows (`IsDeleted`);
 *    `GET …/query/?q=<SOQL>` leaves them out (S3).
 *  - Only the delta shape the poller sends is understood:
 *    `SELECT <fields> FROM <Object> WHERE SystemModstamp >= <YYYY-MM-DDThh:mm:ssZ>
 *     ORDER BY SystemModstamp, Id` — anything else is `400 MALFORMED_QUERY`; an unknown field is
 *    `400 INVALID_FIELD`.
 *  - Pages of `pageSize` records (≤ 2,000); `done: false` with `nextRecordsUrl` under `/query/`
 *    even for queryAll (S3). A page is a snapshot taken when the query ran.
 *  - `GET …/sobjects/<Object>/describe` lists the object's fields.
 *  - `401` for an unknown bearer token; `Sforce-Limit-Info: api-usage=u/m` on every answer.
 *
 * SystemModstamp is kept to whole seconds, as Salesforce returns it (RQ-0103 finding 6).
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { HttpGet } from '../polling/query-client.ts';

interface Documented {
  apiVersion: string;
  maxBatchSize: number;
  errors: Record<string, { status: number; body: unknown }>;
}
export const DOCUMENTED_QUERY = JSON.parse(
  readFileSync(
    new URL('../../fixtures/documented/rest-query-responses.json', import.meta.url),
    'utf8',
  ),
) as Documented;

export type FakeRow = Record<string, string | boolean | null>;

export interface FakeSalesforceQuery {
  http: HttpGet;
  instanceUrl: string;
  requests: { path: string; status: number }[];
  /** Create an object with its queryable fields (Id, SystemModstamp, IsDeleted are implied). */
  define(object: string, fields: readonly string[]): void;
  /** Create or update a record as of `at` (also undeletes it). */
  upsert(object: string, id: string, values: FakeRow, at: Date): void;
  /** Soft-delete a record as of `at` (Recycle Bin). */
  remove(object: string, id: string, at: Date): void;
  row(object: string, id: string): FakeRow | undefined;
  outage: { status: number; body?: unknown } | null;
  apiUsage: { used: number; max: number };
  close(): Promise<void>;
}

const stamp = (at: Date) =>
  `${new Date(Math.floor(at.getTime() / 1000) * 1000).toISOString().slice(0, 19)}.000+0000`;
const DELTA_RE =
  /^SELECT (.+) FROM ([A-Za-z0-9_]+) WHERE SystemModstamp >= (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) ORDER BY SystemModstamp, Id$/;

export async function startFakeSalesforceQuery(opts: {
  instanceUrl: string;
  acceptToken: (token: string) => boolean;
  pageSize?: number;
}): Promise<FakeSalesforceQuery> {
  const pageSize = Math.min(opts.pageSize ?? DOCUMENTED_QUERY.maxBatchSize, 2000);
  const v = `/services/data/v${DOCUMENTED_QUERY.apiVersion}`;
  const objects = new Map<string, { fields: Set<string>; rows: Map<string, FakeRow> }>();
  const locators = new Map<string, { rows: FakeRow[]; rowCount: number }>();
  let serial = 0;
  const table = (object: string) => {
    const t = objects.get(object);
    if (!t) throw new Error(`fake query: ${object} is not defined`);
    return t;
  };
  const state: FakeSalesforceQuery = {
    http: () => Promise.reject(new Error('not started')),
    instanceUrl: opts.instanceUrl,
    requests: [],
    define(object, fields) {
      objects.set(object, {
        fields: new Set(['Id', 'SystemModstamp', 'IsDeleted', ...fields]),
        rows: new Map(),
      });
    },
    upsert(object, id, values, at) {
      const t = table(object);
      for (const f of Object.keys(values))
        if (!t.fields.has(f)) throw new Error(`fake query: ${object}.${f} is not defined`);
      t.rows.set(id, {
        ...(t.rows.get(id) ?? {}),
        ...values,
        Id: id,
        IsDeleted: false,
        SystemModstamp: stamp(at),
      });
    },
    remove(object, id, at) {
      const t = table(object);
      const r = t.rows.get(id);
      if (!r) throw new Error(`fake query: ${object} ${id} does not exist`);
      t.rows.set(id, { ...r, IsDeleted: true, SystemModstamp: stamp(at) });
    },
    row: (object, id) => objects.get(object)?.rows.get(id),
    outage: null,
    apiUsage: { used: 0, max: 100_000 },
    close: () => Promise.resolve(),
  };

  const failure = (key: string, message?: string) => {
    const doc = DOCUMENTED_QUERY.errors[key];
    if (!doc) throw new Error(`fake query: no documented error ${key}`);
    const body =
      message && Array.isArray(doc.body) ? [{ ...(doc.body[0] as object), message }] : doc.body;
    return { status: doc.status, body };
  };

  const page = (object: string, rows: FakeRow[], rowCount: number) => {
    const records = rows.slice(0, pageSize).map((r) => ({
      attributes: { type: object, url: `${v}/sobjects/${object}/${String(r.Id)}` },
      ...r,
    }));
    const rest = rows.slice(pageSize);
    if (rest.length === 0) return { totalSize: rowCount, done: true, records };
    const locator = `01gTEST${String(++serial).padStart(11, '0')}-${String(rowCount - rest.length)}`;
    locators.set(locator, { rows: rest.map((r) => ({ ...r, __object: object })), rowCount });
    return { totalSize: rowCount, done: false, nextRecordsUrl: `${v}/query/${locator}`, records };
  };

  const evaluate = (path: string, auth: string): { status: number; body: unknown } => {
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!opts.acceptToken(token)) return failure('sessionExpired');
    const url = new URL(path, 'http://fake');
    const describe = new RegExp(`^${v}/sobjects/([A-Za-z0-9_]+)/describe/?$`).exec(url.pathname);
    if (describe?.[1]) {
      const t = objects.get(describe[1]);
      if (!t) return { status: 404, body: [{ errorCode: 'NOT_FOUND', message: 'not found' }] };
      return {
        status: 200,
        body: { name: describe[1], fields: [...t.fields].map((name) => ({ name })) },
      };
    }
    const more = new RegExp(`^${v}/query/([A-Za-z0-9-]+)$`).exec(url.pathname);
    if (more?.[1]) {
      const l = locators.get(more[1]);
      if (!l) return failure('invalidQueryLocator');
      locators.delete(more[1]);
      const object = String(l.rows[0]?.__object);
      return {
        status: 200,
        body: page(
          object,
          l.rows.map(({ __object: _o, ...r }) => r),
          l.rowCount,
        ),
      };
    }
    const all = url.pathname === `${v}/queryAll/` || url.pathname === `${v}/queryAll`;
    const live = url.pathname === `${v}/query/` || url.pathname === `${v}/query`;
    if (!all && !live) return failure('malformedQuery', `unsupported ${url.pathname}`);
    const m = DELTA_RE.exec(url.searchParams.get('q') ?? '');
    if (!m?.[1] || !m[2] || !m[3]) return failure('malformedQuery');
    const t = objects.get(m[2]);
    if (!t) return failure('invalidField', `sObject type '${m[2]}' is not supported`);
    const fields = m[1].split(',').map((f) => f.trim());
    const unknown = fields.find((f) => !t.fields.has(f));
    if (unknown) return failure('invalidField', `No such column '${unknown}' on entity '${m[2]}'`);
    const since = Date.parse(m[3]);
    const rows = [...t.rows.values()]
      .filter(
        (r) =>
          (all || r.IsDeleted !== true) &&
          Date.parse(String(r.SystemModstamp).replace('+0000', 'Z')) >= since,
      )
      .sort(
        (a, b) =>
          String(a.SystemModstamp).localeCompare(String(b.SystemModstamp)) ||
          String(a.Id).localeCompare(String(b.Id)),
      )
      .map((r) => Object.fromEntries(fields.map((f) => [f, r[f] ?? null])));
    return { status: 200, body: page(m[2], rows, rows.length) };
  };

  const server = createServer((req, res) => {
    const path = req.url ?? '';
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    let answer: { status: number; body: unknown };
    if (state.outage) {
      answer = { status: state.outage.status, body: state.outage.body ?? null };
    } else {
      answer =
        req.method === 'GET'
          ? evaluate(path, String(req.headers.authorization ?? ''))
          : failure('malformedQuery', `unsupported ${req.method ?? ''}`);
      state.apiUsage.used += 1;
      headers['sforce-limit-info'] =
        `api-usage=${String(state.apiUsage.used)}/${String(state.apiUsage.max)}`;
    }
    state.requests.push({ path, status: answer.status });
    res.writeHead(answer.status, headers);
    res.end(answer.body === null ? '' : JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  state.http = async (url, init) => {
    if (!url.startsWith(`${opts.instanceUrl}/services/data/`))
      throw new Error(`fake query: unexpected URL ${url}`);
    const res = await fetch(
      `http://127.0.0.1:${String(port)}${url.slice(opts.instanceUrl.length)}`,
      { method: init.method, headers: init.headers },
    );
    return {
      status: res.status,
      header: (n: string) => res.headers.get(n),
      text: () => res.text(),
    };
  };
  state.close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((e) => (e ? reject(e) : resolve()));
      server.closeAllConnections();
    });
  return state;
}
