/**
 * Test-only local stand-in for the Salesforce REST sObject Collections resources (RQ-0040). It
 * runs on 127.0.0.1 and answers as the documented API does (fixtures/documented/
 * sobject-collections-responses.json):
 *
 *  - `PATCH /services/data/v67.0/composite/sobjects/{Type}/{ExternalIdField}` upserts ≤ 200
 *    records of one type, matched on the external ID; `PATCH …/composite/sobjects` updates ≤ 200
 *    existing records by `id`, mixed types in ≤ 10 chunks.
 *  - `200` with ordered per-record results (`success`, `errors`, `created`), even when records
 *    fail; `allOrNone: true` rolls the whole request back.
 *  - `401` for an unknown bearer token; `Sforce-Limit-Info: api-usage=u/m` on every answer.
 *  - Fields are checked against the SFDX package metadata (salesforce/force-app): an unknown
 *    field is `400 INVALID_FIELD`; money and numbers must be JSON numbers within the field's
 *    scale (stricter than Salesforce, on purpose: the connector must never send a float or a
 *    string for money); dates must be `YYYY-MM-DD`.
 *
 * `outage` makes the next answers a raw status (e.g. 503) without touching the store. Numbers are
 * stored as their JSON source text, so a test can see `1375.00` exactly as it was sent.
 * `http` is the injectable client: it accepts only the configured instance URL.
 */
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { HttpRequest } from '../writeback/collections.ts';
import { packageFields, type FieldMeta } from './sobject-metadata.ts';

interface Documented {
  apiVersion: string;
  maxRecords: number;
  maxUpdateChunks: number;
  recordErrors: Record<string, { success: false; errors: RecordError[] }>;
  httpErrors: Record<string, { status: number; body: unknown }>;
}
interface RecordError {
  statusCode: string;
  message: string;
  fields: string[];
}
export const DOCUMENTED_COLLECTIONS = JSON.parse(
  readFileSync(
    new URL('../../fixtures/documented/sobject-collections-responses.json', import.meta.url),
    'utf8',
  ),
) as Documented;

export type StoredRecord = Record<string, string | null>;

export interface RecordedRequest {
  method: string;
  path: string;
  rawBody: string;
  status: number;
}

export interface FakeSalesforceRest {
  http: HttpRequest;
  instanceUrl: string;
  requests: RecordedRequest[];
  /** type → key (Salesforce id for standard objects, LF_Id__c for mirrors) → fields. */
  store: Map<string, Map<string, StoredRecord>>;
  /** Make a Salesforce-owned record exist (Account, Opportunity) with a Salesforce id. */
  seed(type: string, id: string, fields?: StoredRecord): void;
  /** Answer every request with this status instead of evaluating it (null = normal). */
  outage: { status: number; body?: unknown; retryAfter?: string } | null;
  /** Daily API usage reported in Sforce-Limit-Info; each answered request adds one. */
  apiUsage: { used: number; max: number };
  close(): Promise<void>;
}

const ID_RE = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NUMBER_RE = /^-?\d+(\.(\d+))?$/;
const SOURCE = Symbol('source');

const read = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });

/** Parse keeping every number's source text (Node 22 reviver `context.source`). */
function parseKeepingNumbers(text: string): unknown {
  const reviver = (_k: string, v: unknown, ctx?: { source?: string }) =>
    typeof v === 'number' ? { [SOURCE]: ctx?.source ?? String(v) } : v;
  return JSON.parse(text, reviver as (k: string, v: unknown) => unknown);
}
const numberSource = (v: unknown): string | null =>
  typeof v === 'object' && v !== null && SOURCE in v
    ? String((v as Record<symbol, string>)[SOURCE])
    : null;

const fail = (key: string, message?: string): { success: false; errors: RecordError[] } => {
  const doc = DOCUMENTED_COLLECTIONS.recordErrors[key];
  if (!doc) throw new Error(`fake: no documented record error ${key}`);
  return message ? { success: false, errors: [{ ...doc.errors[0], message } as RecordError] } : doc;
};

class HttpFailure extends Error {
  readonly key: string;
  constructor(key: string, message?: string) {
    super(message ?? key);
    this.key = key;
  }
}

export async function startFakeSalesforceRest(opts: {
  instanceUrl: string;
  acceptToken: (token: string) => boolean;
}): Promise<FakeSalesforceRest> {
  const fieldsOf = packageFields();
  const base = `/services/data/v${DOCUMENTED_COLLECTIONS.apiVersion}/composite/sobjects`;
  let serial = 0;
  const state: FakeSalesforceRest = {
    http: () => Promise.reject(new Error('not started')),
    instanceUrl: opts.instanceUrl,
    requests: [],
    store: new Map(),
    seed(type, id, fields = {}) {
      const t = state.store.get(type) ?? new Map<string, StoredRecord>();
      state.store.set(type, t);
      t.set(id, { Id: id, ...fields });
    },
    outage: null,
    apiUsage: { used: 0, max: 100_000 },
    close: () => Promise.resolve(),
  };

  /** Validate and convert one field value; throws HttpFailure for request-level faults. */
  const convert = (type: string, field: string, value: unknown): string | null => {
    const meta: FieldMeta | undefined = fieldsOf.get(type)?.get(field);
    if (!meta) throw new HttpFailure('invalidField', `No such column '${field}' on ${type}`);
    if (value === null) return null;
    const num = numberSource(value);
    switch (meta.type) {
      case 'Currency':
      case 'Number': {
        const m = num === null ? null : NUMBER_RE.exec(num);
        if (!m || num === null) throw new HttpFailure('invalidField', `${field} needs a number`);
        if ((m[2]?.length ?? 0) > (meta.scale ?? 0))
          throw new HttpFailure('invalidField', `${field} has more than ${String(meta.scale)} dp`);
        return num;
      }
      case 'Date':
        if (typeof value !== 'string' || !DATE_RE.test(value))
          throw new HttpFailure('invalidField', `${field} needs YYYY-MM-DD`);
        return value;
      case 'Lookup':
        if (typeof value !== 'string' || !ID_RE.test(value))
          throw new HttpFailure('invalidField', `${field} needs a Salesforce id`);
        return value;
      default:
        if (typeof value !== 'string') throw new HttpFailure('invalidField', `${field} needs text`);
        if (meta.length !== null && value.length > meta.length)
          throw new HttpFailure('invalidField', `${field} longer than ${String(meta.length)}`);
        return value;
    }
  };

  type Result = Record<string, unknown>;

  const upsert = (type: string, extField: string, body: Record<string, unknown>): Result[] => {
    if (fieldsOf.get(type)?.get(extField)?.externalId !== true)
      throw new HttpFailure('invalidField', `${extField} is not an external id on ${type}`);
    const records = body.records as Record<string, unknown>[];
    const counts = new Map<string, number>();
    for (const r of records) {
      const k = String(r[extField]);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const table = state.store.get(type) ?? new Map<string, StoredRecord>();
    const pending: [string, StoredRecord, boolean][] = [];
    const results: Result[] = records.map((r) => {
      const attrs = r.attributes as { type?: string } | undefined;
      if (attrs?.type !== type) return fail('malformedId', `attributes.type must be ${type}`);
      if ('Id' in r || 'id' in r) return fail('malformedId', 'Id must not be set on upsert');
      const key = r[extField];
      if (typeof key !== 'string' || key.length === 0) return fail('malformedId');
      if ((counts.get(key) ?? 0) > 1) return fail('duplicateValue');
      const fields: StoredRecord = {};
      for (const [f, v] of Object.entries(r)) {
        if (f === 'attributes') continue;
        if (f.endsWith('__r')) {
          // A lookup set through the parent's external id: { "LF_Invoice__r": { "LF_Id__c": … } }.
          const lookup = f.replace(/__r$/, '__c');
          const meta = fieldsOf.get(type)?.get(lookup);
          const ref = v as Record<string, unknown> | null;
          const [[pf, pv] = []] = Object.entries(ref ?? {});
          if (!meta?.referenceTo || !pf || typeof pv !== 'string')
            throw new HttpFailure('invalidField', `bad relationship ${f}`);
          const parent = state.store.get(meta.referenceTo)?.get(pv);
          if (!parent || fieldsOf.get(meta.referenceTo)?.get(pf)?.externalId !== true)
            return fail('notFound', `Foreign key external ID: ${pv} not found for ${pf}`);
          fields[lookup] = parent.Id ?? null;
          continue;
        }
        fields[f] = convert(type, f, v);
      }
      const existing = table.get(key);
      const id = existing?.Id ?? `a01TEST${String(++serial).padStart(11, '0')}`;
      pending.push([key, { ...(existing ?? {}), ...fields, Id: id }, !existing]);
      return { id, success: true, errors: [], created: !existing };
    });
    return commit(body, results, () => {
      state.store.set(type, table);
      for (const [k, rec] of pending) table.set(k, rec);
    });
  };

  const update = (body: Record<string, unknown>): Result[] => {
    const records = body.records as Record<string, unknown>[];
    let chunks = 0;
    let last = '';
    for (const r of records) {
      const t = String((r.attributes as { type?: string } | undefined)?.type);
      if (t !== last) chunks += 1;
      last = t;
    }
    if (chunks > DOCUMENTED_COLLECTIONS.maxUpdateChunks)
      throw new HttpFailure('invalidField', 'more than 10 chunks');
    const ids = records.map((r) => String(r.id));
    const pending: [string, string, StoredRecord][] = [];
    const results: Result[] = records.map((r) => {
      const type = String((r.attributes as { type?: string } | undefined)?.type);
      const id = r.id;
      if (typeof id !== 'string' || !ID_RE.test(id)) return fail('malformedId');
      if (ids.filter((x) => x === id).length > 1) return fail('duplicateValue');
      const existing = state.store.get(type)?.get(id);
      if (!existing) return fail('notFound');
      const fields: StoredRecord = {};
      for (const [f, v] of Object.entries(r)) {
        if (f === 'attributes' || f === 'id') continue;
        fields[f] = convert(type, f, v);
      }
      pending.push([type, id, { ...existing, ...fields }]);
      return { id, success: true, errors: [] };
    });
    return commit(body, results, () => {
      for (const [t, id, rec] of pending) state.store.get(t)?.set(id, rec);
    });
  };

  const commit = (body: Record<string, unknown>, results: Result[], apply: () => void) => {
    if (body.allOrNone === true && results.some((r) => r.success !== true)) {
      return results.map((r) => (r.success === true ? fail('rolledBack') : r));
    }
    apply();
    return results;
  };

  const evaluate = (
    method: string,
    path: string,
    auth: string,
    raw: string,
  ): { status: number; body: unknown } => {
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    try {
      if (!opts.acceptToken(token)) throw new HttpFailure('sessionExpired');
      if (method !== 'PATCH' || !path.startsWith(base))
        throw new HttpFailure('invalidField', `unsupported ${method} ${path}`);
      const body = parseKeepingNumbers(raw) as Record<string, unknown>;
      if (!Array.isArray(body.records)) throw new HttpFailure('invalidField', 'records missing');
      if (body.records.length > DOCUMENTED_COLLECTIONS.maxRecords)
        throw new HttpFailure('tooManyRecords');
      const rest = path.slice(base.length).replace(/^\/|\/$/g, '');
      if (rest === '') return { status: 200, body: update(body) };
      const [type, extField, extra] = rest.split('/');
      if (!type || !extField || extra !== undefined)
        throw new HttpFailure('invalidField', `bad path ${path}`);
      return { status: 200, body: upsert(type, extField, body) };
    } catch (e) {
      if (!(e instanceof HttpFailure)) throw e;
      const doc = DOCUMENTED_COLLECTIONS.httpErrors[e.key];
      if (!doc) throw new Error(`fake: no documented http error ${e.key}`, { cause: e });
      const body =
        e.message !== e.key && Array.isArray(doc.body)
          ? [{ ...(doc.body[0] as object), message: e.message }]
          : doc.body;
      return { status: doc.status, body };
    }
  };

  const server = createServer((req, res) => {
    void read(req).then((raw) => {
      const path = req.url ?? '';
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      let answer: { status: number; body: unknown };
      if (state.outage) {
        answer = { status: state.outage.status, body: state.outage.body ?? null };
        if (state.outage.retryAfter) headers['retry-after'] = state.outage.retryAfter;
      } else {
        answer = evaluate(req.method ?? '', path, String(req.headers.authorization ?? ''), raw);
        state.apiUsage.used += 1;
        headers['sforce-limit-info'] =
          `api-usage=${String(state.apiUsage.used)}/${String(state.apiUsage.max)}`;
      }
      state.requests.push({ method: req.method ?? '', path, rawBody: raw, status: answer.status });
      res.writeHead(answer.status, headers);
      res.end(answer.body === null ? '' : JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  state.http = async (url, init) => {
    if (!url.startsWith(`${opts.instanceUrl}/services/data/`))
      throw new Error(`fake REST: unexpected URL ${url}`);
    const res = await fetch(
      `http://127.0.0.1:${String(port)}${url.slice(opts.instanceUrl.length)}`,
      {
        method: init.method,
        headers: init.headers,
        body: init.body,
      },
    );
    return {
      status: res.status,
      header: (name: string) => res.headers.get(name),
      text: () => res.text(),
    };
  };
  state.close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((e) => {
        if (e) reject(e);
        else resolve();
      });
      server.closeAllConnections();
    });
  return state;
}
