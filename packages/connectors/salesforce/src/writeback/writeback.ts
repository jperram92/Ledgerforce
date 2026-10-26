/**
 * Salesforce write-back from the transactional outbox (design §5.4, §5.6; ADR-0008, ADR-0036;
 * RQ-0040). `salesforceWriteBackHandler` is an outbox handler: `deliver` runs it once per event
 * in a tenant transaction together with the inbox row. It maps the event's `writeBack` snapshot,
 * sends it in sObject Collections requests of ≤ 200 records, and throws on any failure, so the
 * transaction (inbox row included) rolls back and pg-boss retries with backoff (1 min → 6 h, then
 * the dead-letter queue). Accounting never waits for this: the posting committed long before.
 *
 * Every effect is idempotent at the remote end (upsert by LF_Id__c, update by Salesforce id with
 * absolute values), so a retry after a partial success or a lost acknowledgement rewrites the
 * same values and creates nothing twice.
 */
import type { Database } from '@ledgerforce/db';
import type { Kms } from '@ledgerforce/shared/crypto';
import type { Transaction } from 'kysely';
import { getAccessToken, invalidateAccessToken, listConnections } from '../connection-store.ts';
import type { HttpPost } from '../token-client.ts';
import { planBatches, type WriteBackRecord } from './batch.ts';
import {
  SalesforceApiError,
  sendCollection,
  type ApiUsageGate,
  type HttpRequest,
  type RecordError,
  type RestSession,
} from './collections.ts';
import { mapToRecords, parseWriteBackPayload, WRITEBACK_TOPICS } from './mapping.ts';

export interface WriteBackReport {
  requests: number;
  records: number;
  created: number;
  updated: number;
}

export interface RecordFailure {
  sobject: string;
  key: string;
  errors: RecordError[];
}

/** Salesforce answered 200 but refused some records; the whole delivery is retried. */
export class WriteBackRecordError extends Error {
  readonly failures: RecordFailure[];
  readonly retryable = true;
  constructor(failures: RecordFailure[]) {
    const first = failures[0];
    super(
      `salesforce refused ${String(failures.length)} record(s)` +
        (first
          ? `; first: ${first.sobject} ${first.key} ${first.errors[0]?.statusCode ?? ''}`
          : ''),
    );
    this.name = 'WriteBackRecordError';
    this.failures = failures;
  }
}

/** Send the records; throws SalesforceApiError (request-level) or WriteBackRecordError. */
export async function writeBack(
  session: RestSession,
  records: readonly WriteBackRecord[],
): Promise<WriteBackReport> {
  const report: WriteBackReport = { requests: 0, records: 0, created: 0, updated: 0 };
  const failures: RecordFailure[] = [];
  for (const request of planBatches(records)) {
    const results = await sendCollection(session, request);
    report.requests += 1;
    results.forEach((r, i) => {
      const rec = request.records[i];
      if (!rec) return;
      report.records += 1;
      if (!r.success) failures.push({ ...rec, errors: r.errors });
      else if (r.created === true) report.created += 1;
      else report.updated += 1;
    });
  }
  if (failures.length > 0) throw new WriteBackRecordError(failures);
  return report;
}

/** The handler name is the inbox key: never rename it (packages/outbox AGENTS.md). */
export const SALESFORCE_WRITEBACK_HANDLER = 'salesforce.writeback';

export interface WriteBackEvent {
  id: string;
  companyId: string | null;
  topic: string;
  payload: Record<string, unknown>;
}

export interface WriteBackHandlerDeps {
  kms: Kms;
  /** Token endpoint client (JWT bearer exchange). */
  tokenHttp: HttpPost;
  /** REST client for the org's instance URL. */
  http: HttpRequest;
  gate?: ApiUsageGate;
  apiVersion?: string;
  now?: () => Date;
  /** Observability hook, called after a successful write-back. */
  onWritten?: (event: WriteBackEvent, report: WriteBackReport) => void;
}

export interface WriteBackHandler {
  name: string;
  topics: readonly string[];
  handle(trx: Transaction<Database>, event: WriteBackEvent): Promise<void>;
}

/** The outbox handler (structurally an `OutboxHandler` of @ledgerforce/outbox). */
export function salesforceWriteBackHandler(deps: WriteBackHandlerDeps): WriteBackHandler {
  return {
    name: SALESFORCE_WRITEBACK_HANDLER,
    topics: WRITEBACK_TOPICS,
    async handle(trx, event) {
      const records = mapToRecords(parseWriteBackPayload(event.payload));
      if (records.length === 0) return;
      if (!event.companyId) throw new TypeError(`write-back event ${event.id} has no company`);
      const connection = (await listConnections(trx, event.companyId)).find(
        (c) => c.status === 'active',
      );
      // A company without Salesforce has nothing to write back (DL-0192).
      if (!connection) return;
      const session = async (): Promise<RestSession> => {
        const t = await getAccessToken(trx, deps.kms, connection.id, {
          http: deps.tokenHttp,
          ...(deps.now ? { now: deps.now() } : {}),
        });
        return {
          http: deps.http,
          instanceUrl: t.instanceUrl,
          accessToken: t.accessToken,
          ...(deps.apiVersion ? { apiVersion: deps.apiVersion } : {}),
          ...(deps.gate ? { gate: deps.gate } : {}),
          ...(deps.now ? { now: deps.now } : {}),
        };
      };
      let report: WriteBackReport;
      try {
        report = await writeBack(await session(), records);
      } catch (e) {
        if (!(e instanceof SalesforceApiError) || e.kind !== 'session_expired') throw e;
        // The cached token expired or was revoked: re-sign once and resend (idempotent).
        await invalidateAccessToken(trx, connection.id);
        report = await writeBack(await session(), records);
      }
      deps.onWritten?.(event, report);
    },
  };
}
