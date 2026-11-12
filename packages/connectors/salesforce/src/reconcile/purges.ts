/**
 * Recycle-Bin purge detection — part of the nightly reconciliation (T-0070, SS-PLAT-26, design
 * §5.3, RQ-0110 findings 1–4, migration 0053).
 *
 * The inbound replay reads queryAll, which shows a delete only while the record is in the Recycle
 * Bin. A record deleted and purged (bin emptied, hard delete, 15-day expiry) while the connector
 * was away never appears there. Per mapped object:
 *  1. sObject Get Deleted from `deletes_checked_until` (≤ 15 days back): every listed record that
 *     LedgerForce still holds as live is archived, stamped with its `deletedDate`;
 *  2. if the delete log has a gap — `earliestDateAvailable` after the window start, or no usable
 *     previous check — every id that still exists is read (queryAll, `SystemModstamp >= 1970`);
 *     a record live in LedgerForce whose id is not there was purged and is archived, stamped with
 *     `latestDateCovered` (Salesforce's clock);
 *  3. `deletes_checked_until` advances to `latestDateCovered` (never backward).
 * "Live in LedgerForce" comes from the processed-change log (last applied change not a DELETE),
 * so every mapped object is handled alike and no LedgerForce-owned data is read. Each detected
 * purge enters the T-0065 mapping as a snapshot DELETE (`polledChange`), so a re-run is a logged
 * duplicate and a later Salesforce change (e.g. an undelete) still wins by timestamp.
 */
import { withTenant } from '@ledgerforce/db';
import { sql } from 'kysely';
import { applyInboundChange } from '../inbound/apply.ts';
import { INBOUND_FIELD_MAP } from '../inbound/inbound-map.ts';
import { deltaSoql, parseModstamp, polledChange, soqlDateTime } from '../polling/delta.ts';
import { getSyncObject, type PollContext } from '../polling/poller.ts';
import { dataPath, queryAllPages, restGet, type QuerySession } from '../polling/query-client.ts';
import { SalesforceApiError } from '../writeback/collections.ts';

const MINUTE = 60_000;
const DAY = 86_400_000;
/** Get Deleted answers for at most 15 days back (RQ-0110 S1); keep a margin for clock skew. */
export const GET_DELETED_MAX_BACK_MS = 15 * DAY - 10 * MINUTE;

export interface DeletedRecords {
  deleted: { id: string; deletedDate: Date }[];
  earliestDateAvailable: Date | null;
  latestDateCovered: Date;
}

/** sObject Get Deleted (`/sobjects/<Object>/deleted/?start=&end=`); seconds are ignored. */
export async function getDeleted(
  session: QuerySession,
  entity: string,
  start: Date,
  end: Date,
): Promise<DeletedRecords> {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(entity))
    throw new RangeError(`not an object: ${entity}`);
  const qs = `start=${encodeURIComponent(soqlDateTime(start))}&end=${encodeURIComponent(soqlDateTime(end))}`;
  const body = (await restGet(
    session,
    `${dataPath(session)}/sobjects/${entity}/deleted/?${qs}`,
  )) as {
    deletedRecords?: unknown;
    earliestDateAvailable?: unknown;
    latestDateCovered?: unknown;
  } | null;
  if (!body || !Array.isArray(body.deletedRecords) || typeof body.latestDateCovered !== 'string') {
    throw new SalesforceApiError('malformed_response', 200, null, 'not a get-deleted result');
  }
  return {
    deleted: (body.deletedRecords as { id?: unknown; deletedDate?: unknown }[]).map((r) => {
      if (typeof r.id !== 'string') {
        throw new SalesforceApiError('malformed_response', 200, null, 'deleted record without id');
      }
      return { id: r.id, deletedDate: parseModstamp(r.deletedDate) };
    }),
    earliestDateAvailable:
      typeof body.earliestDateAvailable === 'string'
        ? parseModstamp(body.earliestDateAvailable)
        : null,
    latestDateCovered: parseModstamp(body.latestDateCovered),
  };
}

export interface PurgeReport {
  entity: string;
  /** The delete log had a gap, so every existing id was compared. */
  fullCompare: boolean;
  /** Records Get Deleted listed for the window. */
  listed: number;
  /** Records archived in LedgerForce because Salesforce deleted them. */
  archived: number;
  issues: number;
  checkedUntil: Date;
}

const floorMinute = (ms: number) => Math.floor(ms / MINUTE) * MINUTE;

/** Record ids LedgerForce holds as live for an object (last applied change is not a DELETE). */
async function liveRecordIds(ctx: PollContext, entity: string): Promise<Set<string>> {
  const { rows } = await withTenant(ctx.db, ctx.tenantId, (trx) =>
    sql<{ record_id: string; change_type: string }>`
      SELECT DISTINCT ON (record_id) record_id, change_type
        FROM app.salesforce_inbound_change
       WHERE company_id = ${ctx.companyId} AND entity_name = ${entity}
         AND outcome IN ('applied', 'archived')
       ORDER BY record_id, commit_timestamp DESC, processed_at DESC`.execute(trx),
  );
  return new Set(rows.filter((r) => r.change_type !== 'DELETE').map((r) => r.record_id));
}

export async function detectPurgesFor(ctx: PollContext, entity: string): Promise<PurgeReport> {
  const now = (ctx.now ?? (() => new Date()))().getTime();
  const cfg = await withTenant(ctx.db, ctx.tenantId, async (trx) => {
    await sql`INSERT INTO app.salesforce_sync_object (company_id, entity_name)
              VALUES (${ctx.companyId}, ${entity}) ON CONFLICT DO NOTHING`.execute(trx);
    return getSyncObject(trx, ctx.companyId, entity);
  });
  const oldest = now - GET_DELETED_MAX_BACK_MS;
  const previous = cfg?.deletesCheckedUntil?.getTime() ?? null;
  let fullCompare = previous === null || previous < oldest;
  const end = floorMinute(now);
  let start = floorMinute(fullCompare ? oldest + MINUTE : (previous as number));
  if (start >= end) start = end - MINUTE;
  const log = await getDeleted(ctx.session, entity, new Date(start), new Date(end));
  if (log.earliestDateAvailable && log.earliestDateAvailable.getTime() > start) fullCompare = true;

  const live = await liveRecordIds(ctx, entity);
  const purged = new Map<string, Date>();
  for (const d of log.deleted) if (live.has(d.id)) purged.set(d.id, d.deletedDate);
  if (fullCompare) {
    const exists = new Set<string>();
    for await (const page of queryAllPages(ctx.session, deltaSoql(entity, [], new Date(0)))) {
      for (const row of page) if (typeof row['Id'] === 'string') exists.add(row['Id']);
    }
    for (const id of live) {
      if (!exists.has(id) && !purged.has(id)) purged.set(id, log.latestDateCovered);
    }
  }

  const report: PurgeReport = {
    entity,
    fullCompare,
    listed: log.deleted.length,
    archived: 0,
    issues: 0,
    checkedUntil: log.latestDateCovered,
  };
  await withTenant(ctx.db, ctx.tenantId, async (trx) => {
    for (const [id, when] of purged) {
      const change = polledChange('reconcile:purge', entity, {
        Id: id,
        SystemModstamp: when.toISOString(),
        IsDeleted: true,
      });
      const r = await applyInboundChange(
        trx,
        { companyId: ctx.companyId, reportIssue: ctx.reportIssue },
        change,
      );
      if (r.outcome === 'archived') report.archived += 1;
      else if (r.outcome === 'issue') report.issues += 1;
    }
    await sql`UPDATE app.salesforce_sync_object
                 SET deletes_checked_until = greatest(coalesce(deletes_checked_until, ${log.latestDateCovered}),
                                                      ${log.latestDateCovered})
               WHERE company_id = ${ctx.companyId} AND entity_name = ${entity}`.execute(trx);
  });
  return report;
}

/** Purge detection for every mapped object (or `entities`); one object's failure does not stop the others. */
export async function detectPurges(
  ctx: PollContext & { entities?: readonly string[] },
): Promise<{ reports: PurgeReport[]; failed: { entity: string; error: Error }[] }> {
  const reports: PurgeReport[] = [];
  const failed: { entity: string; error: Error }[] = [];
  for (const entity of ctx.entities ?? INBOUND_FIELD_MAP.map((m) => m.entity)) {
    try {
      reports.push(await detectPurgesFor(ctx, entity));
    } catch (e) {
      failed.push({ entity, error: e as Error });
    }
  }
  return { reports, failed };
}
