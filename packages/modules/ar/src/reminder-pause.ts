/**
 * Per-party overdue-reminder pause (T-0129, UC-04 "AR Clerk can pause reminders per party
 * (audited)", SS-UC04-07, RQ-0144). The pause is an insert-only history (migration 0063):
 * the latest row per company and party decides whether the daily run skips the party, and every
 * row keeps who, when and why. Permission (ar.dunning.run) and audit.audit_log belong to the API
 * route. No ledger effect.
 */
import type { Database } from '@ledgerforce/db';
import type { Transaction } from 'kysely';

type Trx = Transaction<Database>;

export type ReminderPauseErrorCode =
  'REASON_REQUIRED' | 'INVALID_PARTY' | 'NO_CHANGE' | 'IDEMPOTENCY_CONFLICT';

export class ReminderPauseError extends Error {
  readonly code: ReminderPauseErrorCode;
  constructor(code: ReminderPauseErrorCode, message: string) {
    super(message);
    this.name = 'ReminderPauseError';
    this.code = code;
  }
}

export interface ReminderPause {
  readonly id: string;
  readonly partyId: string;
  readonly paused: boolean;
  readonly reason: string;
  readonly setBy: string;
  readonly setAt: Date;
}

const COLUMNS = ['id', 'party_id', 'paused', 'reason', 'set_by', 'set_at'] as const;
const toPause = (r: {
  id: string;
  party_id: string;
  paused: boolean;
  reason: string;
  set_by: string;
  set_at: Date;
}): ReminderPause => ({
  id: r.id,
  partyId: r.party_id,
  paused: r.paused,
  reason: r.reason,
  setBy: r.set_by,
  setAt: r.set_at,
});

/** The party's pause history, oldest first. */
export async function reminderPauseHistory(
  trx: Trx,
  q: { companyId: string; partyId: string },
): Promise<ReminderPause[]> {
  const rows = await trx
    .selectFrom('app.ar_reminder_pause')
    .select(COLUMNS)
    .where('company_id', '=', q.companyId.toLowerCase())
    .where('party_id', '=', q.partyId.toLowerCase())
    .orderBy('set_at')
    .orderBy('id')
    .execute();
  return rows.map(toPause);
}

/** Parties of the company whose latest pause row is `paused = true`. */
export async function pausedParties(trx: Trx, companyId: string): Promise<Set<string>> {
  const rows = await trx
    .selectFrom('app.ar_reminder_pause')
    .select(['party_id', 'paused'])
    .distinctOn('party_id')
    .where('company_id', '=', companyId.toLowerCase())
    .orderBy('party_id')
    .orderBy('set_at', 'desc')
    .orderBy('id', 'desc')
    .execute();
  return new Set(rows.filter((r) => r.paused).map((r) => r.party_id));
}

/**
 * Pause (`paused: true`) or resume (`paused: false`) reminders for one party. A replay of the
 * same idempotency key returns the stored row (`replayed: true`); the same key with a different
 * request is IDEMPOTENCY_CONFLICT. A request that would not change the state is NO_CHANGE.
 */
export async function setReminderPause(
  trx: Trx,
  c: {
    companyId: string;
    partyId: string;
    paused: boolean;
    reason: string;
    by: string;
    idempotencyKey: string;
  },
): Promise<{ pause: ReminderPause; replayed: boolean }> {
  const companyId = c.companyId.toLowerCase();
  const partyId = c.partyId.toLowerCase();
  const reason = c.reason.trim();

  const prior = await trx
    .selectFrom('app.ar_reminder_pause')
    .select([...COLUMNS, 'company_id'])
    .where('idempotency_key', '=', c.idempotencyKey)
    .executeTakeFirst();
  if (prior) {
    if (
      prior.company_id !== companyId ||
      prior.party_id !== partyId ||
      prior.paused !== c.paused ||
      prior.reason !== reason
    ) {
      throw new ReminderPauseError(
        'IDEMPOTENCY_CONFLICT',
        'this idempotency key was already used for a different request',
      );
    }
    return { pause: toPause(prior), replayed: true };
  }

  if (reason.length === 0) {
    throw new ReminderPauseError('REASON_REQUIRED', 'a reason is required');
  }
  if (reason.length > 500) {
    throw new ReminderPauseError('REASON_REQUIRED', 'the reason is longer than 500 characters');
  }
  const party = await trx
    .selectFrom('app.party')
    .select('id')
    .where('company_id', '=', companyId)
    .where('id', '=', partyId)
    .executeTakeFirst();
  if (!party) throw new ReminderPauseError('INVALID_PARTY', 'party not found in this company');

  // Serialise changes for this party so two concurrent requests cannot both see "not paused".
  await trx.selectFrom('app.party').select('id').where('id', '=', partyId).forUpdate().execute();
  const current = (await pausedParties(trx, companyId)).has(partyId);
  if (current === c.paused) {
    throw new ReminderPauseError(
      'NO_CHANGE',
      c.paused ? 'reminders are already paused for this party' : 'reminders are not paused',
    );
  }

  const row = await trx
    .insertInto('app.ar_reminder_pause')
    .values({
      company_id: companyId,
      party_id: partyId,
      paused: c.paused,
      reason,
      set_by: c.by,
      idempotency_key: c.idempotencyKey,
    })
    .returning(COLUMNS)
    .executeTakeFirstOrThrow();
  return { pause: toPause(row), replayed: false };
}
