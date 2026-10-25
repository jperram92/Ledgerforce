/**
 * Producer side of the transactional outbox (ADR-0008 rule 1, RQ-0033, DL-0152).
 *
 * `enqueue` writes the event row and its pg-boss delivery job through the *caller's* transaction
 * (pg-boss `fromKysely(trx)`), so both commit or roll back with the caller's work — for postings,
 * inside the engine's write savepoint. The job id is the event id (a second send is a no-op) and
 * the job payload carries ids only: pg-boss tables have no RLS.
 */
import type { Database } from '@ledgerforce/db';
import type { PostingOutbox } from '@ledgerforce/ledger';
import { sql, type Transaction } from 'kysely';
import { fromKysely, type PgBoss } from 'pg-boss';
import type { DeliveryJob } from './deliver.ts';
import { OUTBOX_QUEUE } from './queue.ts';

export interface OutboxMessage {
  companyId: string | null;
  /** Dotted lower-case name, e.g. `ledger.entry.posted`. */
  topic: string;
  aggregateType: string;
  aggregateId: string;
  /** Facts consumers need; read back under RLS, never copied into the job. */
  payload: Record<string, unknown>;
}

export const LEDGER_ENTRY_POSTED = 'ledger.entry.posted';

/** Write the event and its delivery job in `trx` (a tenant transaction). Returns the event id. */
export async function enqueue(
  trx: Transaction<Database>,
  boss: PgBoss,
  msg: OutboxMessage,
): Promise<string> {
  const { rows } = await sql<{ id: string; tenant_id: string }>`
    INSERT INTO app.outbox_event (company_id, topic, aggregate_type, aggregate_id, payload)
    VALUES (${msg.companyId}, ${msg.topic}, ${msg.aggregateType}, ${msg.aggregateId},
            ${JSON.stringify(msg.payload)}::jsonb)
    RETURNING id, tenant_id`.execute(trx);
  const event = rows[0];
  if (!event) throw new Error('outbox: event insert returned no row');
  const data: DeliveryJob = { tenantId: event.tenant_id, eventId: event.id };
  const jobId = await boss.send(OUTBOX_QUEUE, data, { id: event.id, db: fromKysely(trx) });
  if (jobId !== event.id) {
    throw new Error(`outbox: pg-boss did not accept the delivery job for event ${event.id}`);
  }
  return event.id;
}

/** The posting engine's outbox hook: one `ledger.entry.posted` event per posted entry. */
export function ledgerOutbox(boss: PgBoss): PostingOutbox {
  return {
    async enqueue(trx, posted) {
      await enqueue(trx, boss, {
        companyId: posted.companyId,
        topic: LEDGER_ENTRY_POSTED,
        aggregateType: 'journal_entry',
        aggregateId: posted.entryId,
        payload: { ...posted },
      });
    },
  };
}
