/**
 * Replay-id cursor, event inbox and resync requests (migration 0026, design §5.3, §5.6, RQ-0036).
 * Every function runs in the caller's tenant transaction, so the subscriber commits a batch's
 * effects, its idempotency keys and the new replay id together.
 */
import type { Database } from '@ledgerforce/db';
import { sql, type Transaction } from 'kysely';

type Trx = Transaction<Database>;

export interface ReplayCursor {
  companyId: string;
  channel: string;
  /** Opaque replay id of the last committed event or keepalive; null = subscribe from LATEST. */
  replayId: Buffer | null;
  eventsCommitted: number;
  committedAt: Date | null;
}

/** Another subscriber moved the cursor since this one read it: the batch must roll back. */
export class ReplayCursorConflict extends Error {
  constructor(channel: string) {
    super(`pubsub: replay cursor of ${channel} moved under this subscriber`);
    this.name = 'ReplayCursorConflict';
  }
}

export async function getReplayCursor(
  trx: Trx,
  companyId: string,
  channel: string,
): Promise<ReplayCursor | null> {
  const { rows } = await sql<{
    replay_id: Buffer | null;
    events_committed: string;
    committed_at: Date | null;
  }>`SELECT replay_id, events_committed, committed_at FROM app.salesforce_replay_cursor
      WHERE company_id = ${companyId} AND channel = ${channel}`.execute(trx);
  const r = rows[0];
  if (!r) return null;
  return {
    companyId,
    channel,
    replayId: r.replay_id,
    eventsCommitted: Number(r.events_committed),
    committedAt: r.committed_at,
  };
}

/**
 * Compare-and-set the cursor from `expected` to `next` (creating it when `expected` is null),
 * locking the row for the rest of the transaction. Throws ReplayCursorConflict if it moved.
 */
export async function advanceReplayCursor(
  trx: Trx,
  companyId: string,
  channel: string,
  move: { expected: Buffer | null; next: Buffer; events: number },
): Promise<void> {
  const { rows } =
    move.expected === null
      ? await sql<{ ok: number }>`
          INSERT INTO app.salesforce_replay_cursor
                 (company_id, channel, replay_id, events_committed, committed_at)
          VALUES (${companyId}, ${channel}, ${move.next}, ${move.events}, now())
          ON CONFLICT (tenant_id, company_id, channel) DO UPDATE
             SET replay_id = EXCLUDED.replay_id,
                 events_committed = app.salesforce_replay_cursor.events_committed + EXCLUDED.events_committed,
                 committed_at = EXCLUDED.committed_at
           WHERE app.salesforce_replay_cursor.replay_id IS NULL
          RETURNING 1 AS ok`.execute(trx)
      : await sql<{ ok: number }>`
          UPDATE app.salesforce_replay_cursor
             SET replay_id = ${move.next},
                 events_committed = events_committed + ${move.events},
                 committed_at = now()
           WHERE company_id = ${companyId} AND channel = ${channel}
             AND replay_id = ${move.expected}
          RETURNING 1 AS ok`.execute(trx);
  if (rows.length !== 1) throw new ReplayCursorConflict(channel);
}

/** Insert the keys; return those that were new (a seen key is a duplicate delivery). */
export async function claimIdempotencyKeys(
  trx: Trx,
  companyId: string,
  channel: string,
  keys: readonly string[],
  replayId: Buffer,
): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const { rows } = await sql<{ idempotency_key: string }>`
    INSERT INTO app.salesforce_event_inbox (company_id, channel, idempotency_key, replay_id)
    SELECT ${companyId}, ${channel}, k, ${replayId} FROM unnest(${[...keys]}::text[]) AS k
    ON CONFLICT DO NOTHING
    RETURNING idempotency_key`.execute(trx);
  return new Set(rows.map((r) => r.idempotency_key));
}

export type ResyncReason = 'gap_event' | 'overflow' | 'replay_id_invalid';

export interface ResyncRequest {
  id: string;
  channel: string;
  reason: ResyncReason;
  entityName: string | null;
  recordIds: string[];
  changeType: string | null;
  commitTimestamp: Date | null;
  replayId: Buffer | null;
  since: Date | null;
  errorCode: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
}

export async function recordResyncRequest(
  trx: Trx,
  companyId: string,
  channel: string,
  r: Pick<ResyncRequest, 'reason'> & Partial<Omit<ResyncRequest, 'id' | 'channel' | 'reason'>>,
): Promise<void> {
  await sql`
    INSERT INTO app.salesforce_resync_request
           (company_id, channel, reason, entity_name, record_ids, change_type, commit_timestamp,
            replay_id, since, error_code)
    VALUES (${companyId}, ${channel}, ${r.reason}, ${r.entityName ?? null},
            ${r.recordIds ?? []}::text[], ${r.changeType ?? null}, ${r.commitTimestamp ?? null},
            ${r.replayId ?? null}, ${r.since ?? null}, ${r.errorCode ?? null})`.execute(trx);
}

/**
 * The stored replay id was rejected (expired or invalid): forget it, so the next run subscribes
 * from LATEST, and ask the reconcile job for everything changed since the last commit.
 */
export async function resetReplayCursor(
  trx: Trx,
  companyId: string,
  channel: string,
  r: { expected: Buffer; errorCode: string | null },
): Promise<void> {
  const { rows } = await sql<{ committed_at: Date | null; created_at: Date }>`
    UPDATE app.salesforce_replay_cursor SET replay_id = NULL
     WHERE company_id = ${companyId} AND channel = ${channel} AND replay_id = ${r.expected}
    RETURNING committed_at, created_at`.execute(trx);
  const row = rows[0];
  if (!row) throw new ReplayCursorConflict(channel);
  await recordResyncRequest(trx, companyId, channel, {
    reason: 'replay_id_invalid',
    replayId: r.expected,
    since: row.committed_at ?? row.created_at,
    errorCode: r.errorCode,
  });
}

export async function listResyncRequests(
  trx: Trx,
  companyId: string,
  channel: string,
): Promise<ResyncRequest[]> {
  const { rows } = await sql<{
    id: string;
    channel: string;
    reason: ResyncReason;
    entity_name: string | null;
    record_ids: string[];
    change_type: string | null;
    commit_timestamp: Date | null;
    replay_id: Buffer | null;
    since: Date | null;
    error_code: string | null;
    created_at: Date;
    resolved_at: Date | null;
  }>`SELECT id, channel, reason, entity_name, record_ids, change_type, commit_timestamp,
            replay_id, since, error_code, created_at, resolved_at
       FROM app.salesforce_resync_request
      WHERE company_id = ${companyId} AND channel = ${channel}
      ORDER BY id`.execute(trx);
  return rows.map((r) => ({
    id: r.id,
    channel: r.channel,
    reason: r.reason,
    entityName: r.entity_name,
    recordIds: r.record_ids,
    changeType: r.change_type,
    commitTimestamp: r.commit_timestamp,
    replayId: r.replay_id,
    since: r.since,
    errorCode: r.error_code,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  }));
}
