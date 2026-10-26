/**
 * Delivery failures and the Sync issues inbox (design §5.6 rule 2, T-0071, RQ-0044, migration
 * 0030).
 *
 *  - Every failed delivery attempt is logged (`recordDeliveryFailure`, app.outbox_delivery_failure)
 *    with a secret-free summary. The pg-boss job output is only `{ handler, failureId }`: pg-boss
 *    tables have no RLS, so the message stays in the tenant's own table.
 *  - A dead-lettered delivery (retries exhausted, or a permanent error) becomes one Sync issue per
 *    (event, handler) (`recordSyncIssue`). A redelivered dead letter changes nothing; a new one
 *    re-opens the issue with the new error and the summed attempts.
 *  - One-click retry (`retrySyncIssue`) sends a new delivery job for the event in the caller's
 *    transaction and marks the issue `retried`; `deliver` resolves the event's retried issues once
 *    every handler has succeeded. `ignoreSyncIssue` parks an issue.
 * The status model is enforced again by the database (migration 0030 trigger).
 */
import type { Database } from '@ledgerforce/db';
import { sql, type Transaction } from 'kysely';
import { fromKysely, type PgBoss } from 'pg-boss';
import type { DeliveryJob } from './deliver.ts';
import { OUTBOX_QUEUE } from './queue.ts';

export type SyncIssueStatus = 'open' | 'retried' | 'resolved' | 'ignored';

/** A secret-free summary of a delivery error. */
export interface DeliveryFailure {
  errorName: string;
  errorKind: string | null;
  errorCode: string | null;
  httpStatus: number | null;
  retryable: boolean;
  message: string;
}

/** The pg-boss job output of a failed attempt (ids only). */
export interface FailureOutput {
  handler: string;
  failureId: string;
}

/** Used when a dead letter carries no output of ours (a worker died holding the job). */
export const UNKNOWN_HANDLER = 'outbox.deliver';

const MAX_MESSAGE = 1000;
const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,99}$/;
const KIND_RE = /^[a-z][a-z0-9_]{0,63}$/;
const HANDLER_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A permanent error says so: `retryable === false` (e.g. SalesforceApiError `rejected`). Anything
 * else — outages, throttling, unknown errors — is retried with backoff.
 */
export function isPermanentFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { retryable?: unknown }).retryable === false
  );
}

/** Summarise any thrown value; connector errors contribute kind, code and HTTP status. */
export function describeFailure(error: unknown): DeliveryFailure {
  const e = (typeof error === 'object' && error !== null ? error : {}) as Record<string, unknown>;
  const name = typeof e.name === 'string' && NAME_RE.test(e.name) ? e.name : 'Error';
  const kind = typeof e.kind === 'string' && KIND_RE.test(e.kind) ? e.kind : null;
  const code =
    typeof e.errorCode === 'string' && e.errorCode.length > 0 ? e.errorCode.slice(0, 200) : null;
  const status =
    typeof e.status === 'number' && Number.isInteger(e.status) && e.status >= 100 && e.status <= 599
      ? e.status
      : null;
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : String(error);
  return {
    errorName: name,
    errorKind: kind,
    errorCode: code,
    httpStatus: status,
    retryable: !isPermanentFailure(error),
    message: message.slice(0, MAX_MESSAGE),
  };
}

/** Read our `{ handler, failureId }` back from a dead letter's source output; null if foreign. */
export function parseFailureOutput(output: unknown): FailureOutput | null {
  const o = (typeof output === 'object' && output !== null ? output : {}) as Record<
    string,
    unknown
  >;
  if (typeof o.handler !== 'string' || !HANDLER_RE.test(o.handler) || o.handler.length > 100) {
    return null;
  }
  if (typeof o.failureId !== 'string' || !UUID_RE.test(o.failureId)) return null;
  return { handler: o.handler, failureId: o.failureId };
}

/** The connector of a handler: its first name segment (`salesforce.writeback` → `salesforce`). */
export const connectorOf = (handler: string): string => handler.split('.')[0] ?? handler;

/** Log one failed attempt (own tenant transaction, after the attempt rolled back). */
export async function recordDeliveryFailure(
  trx: Transaction<Database>,
  input: { eventId: string; handler: string; attempt: number; failure: DeliveryFailure },
): Promise<string> {
  const f = input.failure;
  const { rows } = await sql<{ id: string }>`
    INSERT INTO app.outbox_delivery_failure
      (event_id, handler, attempt, error_name, error_kind, error_code, http_status, retryable,
       error_message)
    VALUES (${input.eventId}, ${input.handler}, ${input.attempt}, ${f.errorName}, ${f.errorKind},
            ${f.errorCode}, ${f.httpStatus}, ${f.retryable}, ${f.message})
    RETURNING id`.execute(trx);
  const id = rows[0]?.id;
  if (!id) throw new Error('outbox: failure insert returned no row');
  return id;
}

export interface SyncIssue {
  id: string;
  companyId: string | null;
  eventId: string;
  handler: string;
  connector: string;
  status: SyncIssueStatus;
  attempts: number;
  errorName: string;
  errorKind: string | null;
  errorCode: string | null;
  httpStatus: number | null;
  retryable: boolean;
  errorMessage: string;
  retryJobId: string | null;
  note: string | null;
  statusChangedBy: string | null;
  statusChangedAt: Date;
  firstFailedAt: Date;
  lastFailedAt: Date;
  /** The payload reference: the outbox event's topic and aggregate. */
  topic: string;
  aggregateType: string;
  aggregateId: string;
}

export interface SyncIssueDetail extends SyncIssue {
  /** The event payload, read under RLS from app.outbox_event. */
  payload: Record<string, unknown>;
}

interface IssueRow {
  id: string;
  company_id: string | null;
  event_id: string;
  handler: string;
  connector: string;
  status: SyncIssueStatus;
  attempts: number;
  error_name: string;
  error_kind: string | null;
  error_code: string | null;
  http_status: number | null;
  retryable: boolean;
  error_message: string;
  retry_job_id: string | null;
  note: string | null;
  status_changed_by: string | null;
  status_changed_at: Date;
  first_failed_at: Date;
  last_failed_at: Date;
  topic: string;
  aggregate_type: string;
  aggregate_id: string;
  payload?: Record<string, unknown>;
}

const toIssue = (r: IssueRow): SyncIssue => ({
  id: r.id,
  companyId: r.company_id,
  eventId: r.event_id,
  handler: r.handler,
  connector: r.connector,
  status: r.status,
  attempts: r.attempts,
  errorName: r.error_name,
  errorKind: r.error_kind,
  errorCode: r.error_code,
  httpStatus: r.http_status,
  retryable: r.retryable,
  errorMessage: r.error_message,
  retryJobId: r.retry_job_id,
  note: r.note,
  statusChangedBy: r.status_changed_by,
  statusChangedAt: r.status_changed_at,
  firstFailedAt: r.first_failed_at,
  lastFailedAt: r.last_failed_at,
  topic: r.topic,
  aggregateType: r.aggregate_type,
  aggregateId: r.aggregate_id,
});

const ISSUE_COLUMNS = sql`
  i.id, i.company_id, i.event_id, i.handler, i.connector, i.status, i.attempts, i.error_name,
  i.error_kind, i.error_code, i.http_status, i.retryable, i.error_message, i.retry_job_id, i.note,
  i.status_changed_by, i.status_changed_at, i.first_failed_at, i.last_failed_at, e.topic,
  e.aggregate_type, e.aggregate_id`;

async function issueById(
  trx: Transaction<Database>,
  id: string,
  lock = false,
): Promise<IssueRow | undefined> {
  if (!UUID_RE.test(id)) return undefined;
  const { rows } = await sql<IssueRow>`
    SELECT ${ISSUE_COLUMNS}, e.payload
      FROM app.sync_issue i JOIN app.outbox_event e ON e.id = i.event_id
     WHERE i.id = ${id} ${lock ? sql`FOR UPDATE OF i` : sql``}`.execute(trx);
  return rows[0];
}

/** One issue with its payload, or null (another tenant's issue is simply not there). */
export async function getSyncIssue(
  trx: Transaction<Database>,
  id: string,
): Promise<SyncIssueDetail | null> {
  const r = await issueById(trx, id);
  return r ? { ...toIssue(r), payload: r.payload ?? {} } : null;
}

export interface ListSyncIssuesOptions {
  status?: SyncIssueStatus;
  /** Keyset: issues failed before this one (its id), newest first. */
  after?: string;
  limit?: number;
}

/** Newest failure first; at most `limit` (default 50, max 200). */
export async function listSyncIssues(
  trx: Transaction<Database>,
  opts: ListSyncIssuesOptions = {},
): Promise<SyncIssue[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const after = opts.after && UUID_RE.test(opts.after) ? opts.after : null;
  const { rows } = await sql<IssueRow>`
    SELECT ${ISSUE_COLUMNS}
      FROM app.sync_issue i JOIN app.outbox_event e ON e.id = i.event_id
     WHERE (${opts.status ?? null}::text IS NULL OR i.status = ${opts.status ?? null})
       AND (${after}::uuid IS NULL OR (i.last_failed_at, i.id) <
            (SELECT a.last_failed_at, a.id FROM app.sync_issue a WHERE a.id = ${after}::uuid))
     ORDER BY i.last_failed_at DESC, i.id DESC
     LIMIT ${limit}`.execute(trx);
  return rows.map(toIssue);
}

export interface DeadLetter {
  eventId: string;
  /** Delivery attempts the dead-lettered job made (its retryCount + 1). */
  attempts: number;
  deadLetterJobId: string;
  /** The dead letter's source output (ours: `{ handler, failureId }`). */
  output: unknown;
}

/** Turn a dead letter into an open Sync issue (idempotent per dead-letter job). */
export async function recordSyncIssue(
  trx: Transaction<Database>,
  dl: DeadLetter,
): Promise<SyncIssue> {
  const ours = parseFailureOutput(dl.output);
  let handler = ours?.handler ?? UNKNOWN_HANDLER;
  let failure: (DeliveryFailure & { id: string | null }) | null = null;
  if (ours) {
    const { rows } = await sql<{
      id: string;
      handler: string;
      error_name: string;
      error_kind: string | null;
      error_code: string | null;
      http_status: number | null;
      retryable: boolean;
      error_message: string;
    }>`SELECT id, handler, error_name, error_kind, error_code, http_status, retryable, error_message
         FROM app.outbox_delivery_failure WHERE id = ${ours.failureId} AND event_id = ${dl.eventId}`.execute(
      trx,
    );
    const r = rows[0];
    if (r) {
      handler = r.handler;
      failure = {
        id: r.id,
        errorName: r.error_name,
        errorKind: r.error_kind,
        errorCode: r.error_code,
        httpStatus: r.http_status,
        retryable: r.retryable,
        message: r.error_message,
      };
    }
  }
  failure ??= {
    id: null,
    errorName: 'DeliveryAbandoned',
    errorKind: 'abandoned',
    errorCode: null,
    httpStatus: null,
    retryable: true,
    message: 'the delivery was dead-lettered without a recorded error (worker stopped or expired)',
  };
  const attempts = Math.max(1, dl.attempts);
  const { rows: existing } = await sql<{ id: string; dead_letter_job_id: string }>`
    SELECT id, dead_letter_job_id FROM app.sync_issue
     WHERE event_id = ${dl.eventId} AND handler = ${handler} FOR UPDATE`.execute(trx);
  const prev = existing[0];
  let id: string;
  if (!prev) {
    const { rows } = await sql<{ id: string }>`
      INSERT INTO app.sync_issue
        (company_id, event_id, handler, connector, attempts, last_failure_id, error_name,
         error_kind, error_code, http_status, retryable, error_message, dead_letter_job_id)
      SELECT e.company_id, e.id, ${handler}, ${connectorOf(handler)}, ${attempts}, ${failure.id},
             ${failure.errorName}, ${failure.errorKind}, ${failure.errorCode}, ${failure.httpStatus},
             ${failure.retryable}, ${failure.message}, ${dl.deadLetterJobId}
        FROM app.outbox_event e WHERE e.id = ${dl.eventId}
      RETURNING id`.execute(trx);
    const row = rows[0];
    if (!row) throw new Error(`outbox: event ${dl.eventId} not found for this tenant`);
    id = row.id;
  } else {
    id = prev.id;
    if (prev.dead_letter_job_id !== dl.deadLetterJobId) {
      await sql`
        UPDATE app.sync_issue
           SET status = 'open', attempts = attempts + ${attempts},
               last_failure_id = ${failure.id}, error_name = ${failure.errorName},
               error_kind = ${failure.errorKind}, error_code = ${failure.errorCode},
               http_status = ${failure.httpStatus}, retryable = ${failure.retryable},
               error_message = ${failure.message}, dead_letter_job_id = ${dl.deadLetterJobId},
               last_failed_at = clock_timestamp()
         WHERE id = ${id}`.execute(trx);
    }
  }
  const r = await issueById(trx, id);
  if (!r) throw new Error('outbox: sync issue not readable');
  return toIssue(r);
}

/** Sends a delivery job for an event in the caller's transaction; returns the job id. */
export type DeliveryRequeue = (trx: Transaction<Database>, job: DeliveryJob) => Promise<string>;

/** A requeue through a runtime (lf_app) pg-boss instance: new job, full retry policy. */
export function bossRequeue(boss: PgBoss): DeliveryRequeue {
  return async (trx, job) => {
    const id = await boss.send(OUTBOX_QUEUE, job, { db: fromKysely(trx) });
    if (!id) throw new Error(`outbox: pg-boss did not accept the retry of event ${job.eventId}`);
    return id;
  };
}

export type SyncIssueRefusal = 'NOT_FOUND' | 'NOT_RETRYABLE' | 'NOT_IGNORABLE';

export class SyncIssueRefused extends Error {
  readonly reason: SyncIssueRefusal;
  constructor(reason: SyncIssueRefusal, id: string) {
    super(`sync issue ${id}: ${reason}`);
    this.name = 'SyncIssueRefused';
    this.reason = reason;
  }
}

/**
 * One-click retry: re-queue the event and mark the issue `retried`, in `trx`. Open and ignored
 * issues can be retried; a retried one returns as it is (a double click sends nothing new).
 */
export async function retrySyncIssue(
  trx: Transaction<Database>,
  requeue: DeliveryRequeue,
  id: string,
  actorUserId: string,
): Promise<SyncIssue> {
  const r = await issueById(trx, id, true);
  if (!r) throw new SyncIssueRefused('NOT_FOUND', id);
  if (r.status === 'retried') return toIssue(r);
  if (r.status !== 'open' && r.status !== 'ignored')
    throw new SyncIssueRefused('NOT_RETRYABLE', id);
  const { rows } = await sql<{ tenant_id: string }>`
    SELECT tenant_id FROM app.outbox_event WHERE id = ${r.event_id}`.execute(trx);
  const tenantId = rows[0]?.tenant_id;
  if (!tenantId) throw new SyncIssueRefused('NOT_FOUND', id);
  const jobId = await requeue(trx, { tenantId, eventId: r.event_id });
  await sql`
    UPDATE app.sync_issue
       SET status = 'retried', retry_job_id = ${jobId}, status_changed_by = ${actorUserId}
     WHERE id = ${id}`.execute(trx);
  const after = await issueById(trx, id);
  if (!after) throw new SyncIssueRefused('NOT_FOUND', id);
  return toIssue(after);
}

/** Park an open issue; an ignored one returns as it is. */
export async function ignoreSyncIssue(
  trx: Transaction<Database>,
  id: string,
  actorUserId: string,
  note: string | null = null,
): Promise<SyncIssue> {
  const r = await issueById(trx, id, true);
  if (!r) throw new SyncIssueRefused('NOT_FOUND', id);
  if (r.status === 'ignored') return toIssue(r);
  if (r.status !== 'open') throw new SyncIssueRefused('NOT_IGNORABLE', id);
  await sql`
    UPDATE app.sync_issue
       SET status = 'ignored', note = ${note === null ? null : note.slice(0, 500)},
           status_changed_by = ${actorUserId}
     WHERE id = ${id}`.execute(trx);
  const after = await issueById(trx, id);
  if (!after) throw new SyncIssueRefused('NOT_FOUND', id);
  return toIssue(after);
}

/** After a fully successful delivery: the event's retried issues are resolved. */
export async function resolveRetriedIssues(
  trx: Transaction<Database>,
  eventId: string,
): Promise<number> {
  const r = await sql`
    UPDATE app.sync_issue SET status = 'resolved'
     WHERE event_id = ${eventId} AND status = 'retried'`.execute(trx);
  return Number(r.numAffectedRows ?? 0n);
}
