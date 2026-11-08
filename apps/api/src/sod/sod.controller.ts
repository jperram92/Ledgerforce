import { BadRequestException, Body, Controller, Get, Post, Query, Res } from '@nestjs/common';
import { SOD_THRESHOLDS, type SodSettings, type SodThreshold } from '@ledgerforce/shared/sod';
import type { Response } from 'express';
import { sql } from 'kysely';
import { Authz } from '../authz/authz.ts';
import { RequirePermission } from '../authz/permission.decorator.ts';
import { AuditTrail, TenantTx } from '../tenancy/tenant-tx.ts';
import { loadSodSettings } from './sod.service.ts';

const AMOUNT = /^\d{1,15}(\.\d{1,4})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

interface SettingsView {
  small_team_mode: boolean;
  thresholds: Record<SodThreshold, string>;
  report_timezone: string;
  set_at: Date | null;
  /** Design §11.2: the thresholds are placeholders until the product owner decides them. */
  placeholder_defaults: boolean;
}

const view = (s: SodSettings, setAt: Date | null): SettingsView => ({
  small_team_mode: s.smallTeamMode,
  thresholds: { ...s.thresholds },
  report_timezone: s.reportTimezone,
  set_at: setAt,
  placeholder_defaults: setAt === null,
});

const bad = (): BadRequestException => new BadRequestException({ error: 'invalid_sod_settings' });

const fixed4 = (v: string): string => {
  const [i = '0', f = ''] = v.split('.');
  return `${i.replace(/^0+(?=\d)/, '')}.${f.padEnd(4, '0')}`;
};

/** The change requested in the body, applied to the current settings. */
function changed(body: unknown, current: SodSettings): { next: SodSettings; reason: string } {
  if (typeof body !== 'object' || body === null) throw bad();
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) {
    if (!['small_team_mode', 'thresholds', 'report_timezone', 'reason'].includes(k)) throw bad();
  }
  if (typeof b.reason !== 'string' || b.reason.trim() === '' || b.reason.length > 2000) throw bad();
  const thresholds = { ...current.thresholds };
  if (b.thresholds !== undefined) {
    if (typeof b.thresholds !== 'object' || b.thresholds === null) throw bad();
    for (const [k, v] of Object.entries(b.thresholds as Record<string, unknown>)) {
      if (!(SOD_THRESHOLDS as readonly string[]).includes(k)) throw bad();
      if (typeof v !== 'string' || !AMOUNT.test(v)) throw bad();
      thresholds[k as SodThreshold] = fixed4(v);
    }
  }
  if (b.small_team_mode !== undefined && typeof b.small_team_mode !== 'boolean') throw bad();
  if (
    b.report_timezone !== undefined &&
    (typeof b.report_timezone !== 'string' || b.report_timezone.length > 64)
  ) {
    throw bad();
  }
  return {
    next: {
      smallTeamMode: (b.small_team_mode as boolean | undefined) ?? current.smallTeamMode,
      thresholds,
      reportTimezone: (b.report_timezone as string | undefined) ?? current.reportTimezone,
    },
    reason: b.reason.trim(),
  };
}

const same = (a: SodSettings, b: SodSettings): boolean =>
  a.smallTeamMode === b.smallTeamMode &&
  a.reportTimezone === b.reportTimezone &&
  SOD_THRESHOLDS.every((t) => a.thresholds[t] === b.thresholds[t]);

interface ExceptionView {
  id: string;
  rule: string;
  subject_type: string;
  subject_id: string;
  step: string;
  actor_user_id: string;
  kind: string;
  reviewer_user_id: string | null;
  reason: string;
  occurred_at: Date;
  acknowledged: boolean;
}

/**
 * SoD settings and the weekly exception report (design §6.5, ADR-0026). Settings are history:
 * a change inserts a row (Owner only, with a reason; audited by the database). Posting the
 * current values again changes nothing (200). The report lists the small-team exceptions of a
 * Monday-to-Monday week in the tenant's report time zone; the Owner acknowledges a week.
 */
@Controller('sod')
export class SodController {
  constructor(
    private readonly tx: TenantTx,
    private readonly audit: AuditTrail,
    private readonly authz: Authz,
  ) {}

  @Get('settings')
  @RequirePermission('settings.read')
  async settings(): Promise<SettingsView> {
    const { settings, setAt } = await loadSodSettings(this.tx.get());
    return view(settings, setAt);
  }

  @Post('settings')
  @RequirePermission('settings.sod.manage')
  async change(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SettingsView> {
    const trx = this.tx.get();
    const current = await loadSodSettings(trx);
    const { next, reason } = changed(body, current.settings);
    if (current.setAt !== null && same(next, current.settings)) {
      res.status(200);
      return view(current.settings, current.setAt);
    }
    const zone = await sql<{ ok: boolean }>`
      SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = ${next.reportTimezone}) AS ok`.execute(
      trx,
    );
    if (!zone.rows[0]?.ok) throw bad();
    const t = next.thresholds;
    const row = await sql<{ id: string; set_at: Date }>`
      INSERT INTO app.sod_settings (small_team_mode, bill_self_approval_threshold,
             credit_note_self_approval_threshold, journal_approval_threshold,
             batch_two_releasers_threshold, report_timezone, set_by, reason)
      VALUES (${next.smallTeamMode}, ${t.bill_self_approval}, ${t.credit_note_self_approval},
              ${t.journal_approval}, ${t.batch_two_releasers}, ${next.reportTimezone},
              ${this.authz.userId()}, ${reason})
      RETURNING id, set_at`.execute(trx);
    const inserted = row.rows[0];
    this.audit.describe({
      entityType: 'sod_settings',
      ...(inserted ? { entityId: inserted.id } : {}),
      before: view(current.settings, current.setAt),
      after: view(next, inserted?.set_at ?? null),
    });
    res.status(201);
    return view(next, inserted?.set_at ?? null);
  }

  @Get('exceptions/weekly')
  @RequirePermission('audit_log.read')
  async weekly(@Query('week_start') weekStart?: string): Promise<{
    week_start: string;
    timezone: string;
    acknowledged_at: Date | null;
    exceptions: ExceptionView[];
  }> {
    const trx = this.tx.get();
    const week = await this.weekOf(weekStart);
    const tz = await sql<{ tz: string }>`SELECT app.sod_report_timezone() AS tz`.execute(trx);
    const rows = await sql<ExceptionView>`
      SELECT id, rule, subject_type, subject_id, step, actor_user_id, kind, reviewer_user_id,
             reason, occurred_at, acknowledged
        FROM app.sod_exception_report(${week}::date)`.execute(trx);
    const ack = await sql<{ at: Date | null }>`
      SELECT max(acknowledged_at) AS at FROM app.sod_exception_ack WHERE week_start = ${week}::date`.execute(
      trx,
    );
    return {
      week_start: week,
      timezone: tz.rows[0]?.tz ?? '',
      acknowledged_at: ack.rows[0]?.at ?? null,
      exceptions: rows.rows,
    };
  }

  @Post('exceptions/weekly/acknowledge')
  @RequirePermission('settings.sod.manage')
  async acknowledge(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ week_start: string; exceptions: number }> {
    const b = (body ?? {}) as { week_start?: unknown; note?: unknown };
    if (typeof b.week_start !== 'string') {
      throw new BadRequestException({ error: 'invalid_week_start' });
    }
    if (b.note !== undefined && (typeof b.note !== 'string' || b.note.length > 2000)) {
      throw new BadRequestException({ error: 'invalid_note' });
    }
    const week = await this.weekOf(b.week_start);
    const trx = this.tx.get();
    // Naturally idempotent: a week already acknowledged with nothing new since is left as is.
    const open = await sql<{ total: number; open: number; acks: number }>`
      SELECT (SELECT count(*)::int FROM app.sod_exception_report(${week}::date)) AS total,
             (SELECT count(*)::int FROM app.sod_exception_report(${week}::date) WHERE NOT acknowledged) AS open,
             (SELECT count(*)::int FROM app.sod_exception_ack WHERE week_start = ${week}::date) AS acks`.execute(
      trx,
    );
    const state = open.rows[0];
    if (state && state.acks > 0 && state.open === 0) {
      res.status(200);
      return { week_start: week, exceptions: state.total };
    }
    res.status(201);
    const r = await sql<{ id: string }>`
      INSERT INTO app.sod_exception_ack (week_start, acknowledged_by, note)
      VALUES (${week}::date, ${this.authz.userId()}, ${b.note ?? null}) RETURNING id`.execute(trx);
    const n = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM app.sod_exception_report(${week}::date)`.execute(trx);
    this.audit.describe({
      entityType: 'sod_exception_week',
      entityId: week,
      after: { ack_id: r.rows[0]?.id, exceptions: n.rows[0]?.n ?? 0 },
    });
    return { week_start: week, exceptions: n.rows[0]?.n ?? 0 };
  }

  /** The given Monday, or the current week's Monday in the report time zone. */
  private async weekOf(weekStart: string | undefined): Promise<string> {
    const trx = this.tx.get();
    if (weekStart === undefined) {
      const r = await sql<{ d: string }>`
        SELECT to_char(date_trunc('week', now() AT TIME ZONE app.sod_report_timezone()), 'YYYY-MM-DD') AS d`.execute(
        trx,
      );
      return r.rows[0]?.d ?? '';
    }
    if (!DATE.test(weekStart)) throw new BadRequestException({ error: 'invalid_week_start' });
    // A real calendar date (round-trips) that is a Monday; checked here so no SQL error aborts
    // the request transaction.
    const d = new Date(`${weekStart}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== weekStart) {
      throw new BadRequestException({ error: 'invalid_week_start' });
    }
    if (d.getUTCDay() !== 1) throw new BadRequestException({ error: 'invalid_week_start' });
    return weekStart;
  }
}
