import { BadRequestException, SetMetadata } from '@nestjs/common';
import type { Database } from '@ledgerforce/db';
import { isSodStep, subjectTypeOf, type SodStep } from '@ledgerforce/shared/sod';
import type { Request } from 'express';
import { sql, type Transaction } from 'kysely';

export const SOD_STEP = 'lf:sodStep';

/** What a route says about the subject of its step (ADR-0026). Amount: decimal string or null. */
export interface SodSubject {
  id: string;
  amount?: string | null;
  /** Manual journals: the journal touches a control, tax or equity account (§6.5 rule 4). */
  controlTaxOrEquity?: boolean;
}

export type SubjectFrom = (
  req: Request,
  trx: Transaction<Database>,
  step: SodStep,
) => SodSubject | Promise<SodSubject>;

export interface SodDeclaration {
  step: SodStep;
  subjectFrom: SubjectFrom;
}

/**
 * The route performs SoD step `step` (e.g. `bill.approve`) on the subject `subjectFrom` returns
 * (design §6.5, ADR-0026). TenantInterceptor evaluates every SoD rule of that step after the MFA,
 * permission and step-up checks, refuses a conflict with 403 `{error:'sod_violation', rule}`, and
 * records the step in app.sod_action after the handler succeeds. Steps without rules (e.g.
 * `bill.enter`) are declared the same way so that later steps can be checked against them.
 * The route must also declare `@RequirePermission` (eligibility is counted by that permission).
 */
export const SoD = (step: SodStep, subjectFrom: SubjectFrom): MethodDecorator => {
  if (!isSodStep(step)) throw new Error(`SoD: unknown step ${String(step)}`);
  return SetMetadata(SOD_STEP, { step, subjectFrom } satisfies SodDeclaration);
};

export function sodOf(handler: object): SodDeclaration | undefined {
  return Reflect.getMetadata(SOD_STEP, handler) as SodDeclaration | undefined;
}

const MAX_ID = 200;
const AMOUNT = /^\d{1,15}(\.\d{1,4})?$/;

/** 400 `{error:'invalid_sod_subject'}`: the route could not name the subject of its step. */
export class InvalidSodSubject extends BadRequestException {
  constructor() {
    super({ error: 'invalid_sod_subject' });
  }
}

function idOf(v: unknown): string {
  if (typeof v !== 'string' || v.length < 1 || v.length > MAX_ID) throw new InvalidSodSubject();
  return v;
}

function amountOf(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || !AMOUNT.test(v)) throw new InvalidSodSubject();
  return v;
}

/** Subject id and amount from the JSON body (a creating step that carries the amount). */
export function fromBody(idField: string, amountField?: string): SubjectFrom {
  return (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    return {
      id: idOf(body[idField]),
      amount: amountField ? amountOf(body[amountField]) : null,
    };
  };
}

/**
 * Subject id from a route parameter; amount = the latest amount recorded for this subject in the
 * action ledger (e.g. at `bill.enter`). Real routes may read their own table instead.
 */
export function fromParamWithRecordedAmount(param: string): SubjectFrom {
  return async (req, trx, step) => {
    const id = idOf(req.params[param]);
    return { id, amount: null, ...(await recordedAmount(trx, subjectTypeOf(step), id)) };
  };
}

async function recordedAmount(
  trx: Transaction<Database>,
  subjectType: string,
  id: string,
): Promise<{ amount?: string }> {
  const r = await sql<{ amount: string }>`
    SELECT amount::text AS amount FROM app.sod_action
     WHERE subject_type = ${subjectType} AND subject_id = ${id} AND amount IS NOT NULL
     ORDER BY occurred_at DESC, id DESC LIMIT 1`.execute(trx);
  const a = r.rows[0]?.amount;
  return a === undefined ? {} : { amount: a };
}
