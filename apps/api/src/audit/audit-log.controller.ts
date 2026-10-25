import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { sql } from 'kysely';
import { Authz } from '../authz/authz.ts';
import { RequirePermission } from '../authz/permission.decorator.ts';
import { TenantTx } from '../tenancy/tenant-tx.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[1-9]\d{0,17}$/;
const LIMIT = /^\d{1,3}$/;
export const DEFAULT_AUDIT_PAGE = 50;
export const MAX_AUDIT_PAGE = 100;

export interface AuditEntry {
  id: string;
  occurred_at: Date;
  actor_type: string;
  actor_user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  user_agent: string | null;
  request_id: string | null;
  api_token_id: string | null;
}

export interface AuditFilter {
  actor: string | null;
  action: string | null;
  entityType: string | null;
  entityId: string | null;
  from: string | null;
  to: string | null;
  before: string | null;
  limit: number;
}

const invalid = (): BadRequestException => new BadRequestException({ error: 'invalid_filter' });

/** A real calendar date `YYYY-MM-DD` (round-trips through Date), else null. */
function dateOf(v: string): string | null {
  if (!DATE.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : null;
}

/** The query string as a filter; anything malformed is 400 `invalid_filter` (checked before SQL). */
export function auditFilterOf(q: Record<string, unknown>): AuditFilter {
  const str = (k: string, max: number): string | null => {
    const v = q[k];
    if (v === undefined) return null;
    if (typeof v !== 'string' || v.length > max) throw invalid();
    const t = v.trim();
    return t === '' ? null : t;
  };
  const actor = str('actor', 36);
  if (actor !== null && !UUID.test(actor)) throw invalid();
  const fromRaw = str('from', 10);
  const toRaw = str('to', 10);
  const from = fromRaw === null ? null : dateOf(fromRaw);
  const to = toRaw === null ? null : dateOf(toRaw);
  if ((fromRaw !== null && from === null) || (toRaw !== null && to === null)) throw invalid();
  if (from !== null && to !== null && from > to) throw invalid();
  const before = str('before', 18);
  if (before !== null && !ID.test(before)) throw invalid();
  const limitRaw = str('limit', 3);
  const limit = limitRaw === null ? DEFAULT_AUDIT_PAGE : Number(limitRaw);
  if (limitRaw !== null && (!LIMIT.test(limitRaw) || limit < 1 || limit > MAX_AUDIT_PAGE)) {
    throw invalid();
  }
  return {
    actor: actor === null ? null : actor.toLowerCase(),
    action: str('action', 200),
    entityType: str('entity_type', 100),
    entityId: str('entity_id', 200),
    from,
    to,
    before,
    limit,
  };
}

/**
 * The audit log viewer's read route (design §6.4, §6.8; T-0093, ADR-0034). Read-only: there is no
 * write method. Reads only through `audit.read_log` (migration 0029), which re-checks the actor's
 * audit-reading role and the tenant; lf_app has no SELECT on the table. Dates are calendar days in
 * the tenant's report time zone (as the weekly SoD report); `to` includes its whole day. Newest
 * first; `next_before` is the cursor for older entries, null when there are none.
 */
@Controller('audit-log')
export class AuditLogController {
  constructor(
    private readonly tx: TenantTx,
    private readonly authz: Authz,
  ) {}

  @Get()
  @RequirePermission('audit_log.read')
  async list(
    @Query() query: Record<string, unknown>,
  ): Promise<{ entries: AuditEntry[]; next_before: string | null }> {
    const f = auditFilterOf(query);
    const read = async (before: string | null, limit: number) =>
      (
        await sql<AuditEntry>`
          SELECT * FROM audit.read_log(${this.authz.userId()}::uuid, ${f.actor}::uuid,
            ${f.action}::text, ${f.entityType}::text, ${f.entityId}::text,
            (${f.from}::date)::timestamp AT TIME ZONE app.sod_report_timezone(),
            ((${f.to}::date) + 1)::timestamp AT TIME ZONE app.sod_report_timezone(),
            ${before}::bigint, ${limit}::integer)`.execute(this.tx.get())
      ).rows;
    const entries = await read(f.before, f.limit);
    const last = entries.at(-1);
    // An exact "more" signal: probe for one older row instead of guessing from a full page.
    const more =
      entries.length === f.limit && last !== undefined && (await read(last.id, 1)).length > 0;
    return { entries, next_before: more && last ? last.id : null };
  }
}
