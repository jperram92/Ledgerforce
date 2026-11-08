import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Database } from '@ledgerforce/db';
import { permissionsOf, type Permission } from '@ledgerforce/shared/rbac';
import {
  DEFAULT_SOD_SETTINGS,
  evaluateSod,
  subjectTypeOf,
  type SodDecision,
  type SodExceptionRequest,
  type SodRuleId,
  type SodSettings,
  type SodStep,
} from '@ledgerforce/shared/sod';
import { sql, type Transaction } from 'kysely';
import type { SodSubject } from './sod.decorator.ts';

/**
 * Segregation of duties at request time (ADR-0026): reads the subject's history, the tenant's
 * settings and who else is eligible, all under RLS in the request transaction, and records the
 * step (and any small-team exception) once the handler has succeeded. Used by TenantInterceptor.
 */

type Trx = Transaction<Database>;

/** 403 `{error:'sod_violation', rule, small_team_exception_required}`; audited by the interceptor. */
export class SodViolation extends ForbiddenException {
  constructor(
    readonly rule: SodRuleId,
    readonly step: SodStep,
    readonly subjectId: string,
    readonly smallTeamExceptionRequired: boolean,
  ) {
    super({
      error: 'sod_violation',
      rule,
      small_team_exception_required: smallTeamExceptionRequired,
    });
  }
}

/** 400 `{error:'invalid_sod_exception'}`: malformed `sod_exception`, or an unknown reviewer. */
export class InvalidSodException extends BadRequestException {
  constructor() {
    super({ error: 'invalid_sod_exception' });
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `sod_exception` of the JSON body: `{reason, external_reviewer_id?}`; absent → null. */
export function exceptionRequestOf(body: unknown): SodExceptionRequest | null {
  const raw = (body as { sod_exception?: unknown } | null | undefined)?.sod_exception;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object') throw new InvalidSodException();
  const { reason, external_reviewer_id: reviewer } = raw as Record<string, unknown>;
  if (typeof reason !== 'string' || reason.length > 2000) throw new InvalidSodException();
  if (reviewer !== undefined && reviewer !== null) {
    if (typeof reviewer !== 'string' || !UUID.test(reviewer)) throw new InvalidSodException();
    return { reason, reviewerId: reviewer.toLowerCase() };
  }
  return { reason, reviewerId: null };
}

interface SettingsRow {
  small_team_mode: boolean;
  bill: string;
  credit_note: string;
  journal: string;
  batch: string;
  report_timezone: string;
  set_at: Date;
}

/** The tenant's current SoD settings (latest row), or the placeholder defaults. */
export async function loadSodSettings(
  trx: Trx,
): Promise<{ settings: SodSettings; setAt: Date | null }> {
  const r = await sql<SettingsRow>`
    SELECT small_team_mode, bill_self_approval_threshold::text AS bill,
           credit_note_self_approval_threshold::text AS credit_note,
           journal_approval_threshold::text AS journal,
           batch_two_releasers_threshold::text AS batch, report_timezone, set_at
      FROM app.sod_settings ORDER BY set_at DESC, id DESC LIMIT 1`.execute(trx);
  const row = r.rows[0];
  if (!row) return { settings: DEFAULT_SOD_SETTINGS, setAt: null };
  return {
    settings: {
      smallTeamMode: row.small_team_mode,
      thresholds: {
        bill_self_approval: row.bill,
        credit_note_self_approval: row.credit_note,
        journal_approval: row.journal,
        batch_two_releasers: row.batch,
      },
      reportTimezone: row.report_timezone,
    },
    setAt: row.set_at,
  };
}

/** Other active users of the tenant who hold `permission` through an active role grant. */
async function otherEligible(trx: Trx, actorId: string, permission: Permission): Promise<number> {
  const rows = await trx
    .selectFrom('app.user_role as r')
    .innerJoin('app.app_user as u', (j) =>
      j.onRef('u.tenant_id', '=', 'r.tenant_id').onRef('u.id', '=', 'r.user_id'),
    )
    .select(['r.user_id', 'r.role'])
    .where('r.revoked_at', 'is', null)
    .where('u.status', '=', 'active')
    .where('r.user_id', '<>', actorId)
    .execute();
  const byUser = new Map<string, string[]>();
  for (const { user_id, role } of rows) byUser.set(user_id, [...(byUser.get(user_id) ?? []), role]);
  let n = 0;
  for (const roles of byUser.values()) if (permissionsOf(roles).has(permission)) n += 1;
  return n;
}

async function reviewerIsActiveUser(trx: Trx, reviewerId: string): Promise<boolean> {
  const u = await trx
    .selectFrom('app.app_user')
    .select('id')
    .where('id', '=', reviewerId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  return u !== undefined;
}

export interface SodCheck {
  step: SodStep;
  actorId: string;
  subject: SodSubject;
  decision: Exclude<SodDecision, { outcome: 'deny' }>;
  exception: SodExceptionRequest | null;
}

/**
 * Evaluates the step for the actor; throws SodViolation on a conflict. Serialised per subject by
 * a transaction advisory lock, so two concurrent requests cannot both pass on stale history.
 */
export async function checkSod(
  trx: Trx,
  opts: {
    step: SodStep;
    actorId: string;
    permission: Permission;
    subject: SodSubject;
    body: unknown;
  },
): Promise<SodCheck> {
  const { step, actorId, permission, subject } = opts;
  const subjectType = subjectTypeOf(step);
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(
              'lf.sod:' || current_setting('app.tenant_id') || ${`:${subjectType}:${subject.id}`}, 0))`.execute(
    trx,
  );
  const exception = exceptionRequestOf(opts.body);
  if (exception?.reviewerId && !(await reviewerIsActiveUser(trx, exception.reviewerId))) {
    throw new InvalidSodException();
  }
  const history = await sql<{ step: string; actorId: string }>`
    SELECT step, actor_user_id AS "actorId" FROM app.sod_action
     WHERE subject_type = ${subjectType} AND subject_id = ${subject.id}
     ORDER BY occurred_at, id`.execute(trx);
  const { settings } = await loadSodSettings(trx);
  const decision = evaluateSod({
    step,
    actorId,
    subject: {
      amount: subject.amount ?? null,
      ...(subject.controlTaxOrEquity === undefined
        ? {}
        : { controlTaxOrEquity: subject.controlTaxOrEquity }),
    },
    history: history.rows,
    settings,
    otherEligible: await otherEligible(trx, actorId, permission),
    exception,
  });
  if (decision.outcome === 'deny') {
    throw new SodViolation(decision.rule, step, subject.id, decision.smallTeamExceptionRequired);
  }
  return { step, actorId, subject, decision, exception };
}

/** After the handler succeeded: the exception rows (if any), then the step itself. */
export async function recordSod(trx: Trx, c: SodCheck, requestId: string | null): Promise<void> {
  const subjectType = subjectTypeOf(c.step);
  if (c.decision.outcome === 'allow_with_exception' && c.exception) {
    for (const rule of c.decision.rules) {
      await sql`
        INSERT INTO app.sod_exception (rule, subject_type, subject_id, step, actor_user_id, kind,
                                       reviewer_user_id, reason, request_id)
        VALUES (${rule}, ${subjectType}, ${c.subject.id}, ${c.step}, ${c.actorId},
                ${c.decision.kind}, ${c.exception.reviewerId ?? null}, ${c.exception.reason.trim()},
                ${requestId})`.execute(trx);
    }
  }
  await sql`
    INSERT INTO app.sod_action (subject_type, subject_id, step, actor_user_id, amount, request_id)
    VALUES (${subjectType}, ${c.subject.id}, ${c.step}, ${c.actorId}, ${c.subject.amount ?? null},
            ${requestId})`.execute(trx);
}
