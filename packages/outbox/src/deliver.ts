/**
 * Consumer side of the transactional outbox (ADR-0008 rule 2, RQ-0033, DL-0152).
 *
 * pg-boss delivers each job at least once. `deliver` makes each handler's effect happen once:
 * per handler, one tenant transaction inserts the inbox row (event, handler) with ON CONFLICT DO
 * NOTHING and runs the handler only if the row is new. The effect and the inbox row commit
 * together; a redelivery finds the row and skips; a failure rolls both back and the job retries.
 * A concurrent second delivery waits on the first's uncommitted inbox row, then skips.
 * Handlers must do their work in `trx`; an effect outside the database (e.g. a Salesforce upsert)
 * must itself be keyed by the event id.
 */
import { withTenant, type Database } from '@ledgerforce/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import { resolveRetriedIssues } from './sync-issues.ts';

export interface DeliveryJob {
  tenantId: string;
  eventId: string;
}

export interface OutboxEvent {
  id: string;
  tenantId: string;
  companyId: string | null;
  topic: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface OutboxHandler {
  /** Stable name; the inbox key. Renaming a handler makes it see old events as new. */
  name: string;
  topics: readonly string[];
  handle(trx: Transaction<Database>, event: OutboxEvent): Promise<void>;
}

export interface DeliveryResult {
  /** Handlers whose effect committed in this delivery. */
  handled: string[];
  /** Handlers that had already processed the event (redelivery). */
  skipped: string[];
}

// Same rules as the CHECK constraints of migration 0024.
const HANDLER_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;
const TOPIC_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class HandlerRegistry {
  readonly #handlers: OutboxHandler[] = [];

  register(handler: OutboxHandler): this {
    if (!HANDLER_RE.test(handler.name) || handler.name.length > 100) {
      throw new TypeError(`outbox: invalid handler name ${JSON.stringify(handler.name)}`);
    }
    if (handler.topics.length === 0 || handler.topics.some((t) => !TOPIC_RE.test(t))) {
      throw new TypeError(`outbox: handler ${handler.name} needs dotted lower-case topics`);
    }
    if (this.#handlers.some((h) => h.name === handler.name)) {
      throw new Error(`outbox: handler ${handler.name} is already registered`);
    }
    this.#handlers.push(handler);
    return this;
  }

  forTopic(topic: string): readonly OutboxHandler[] {
    return this.#handlers.filter((h) => h.topics.includes(topic));
  }
}

/** The job payload is exactly `{ tenantId, eventId }` (ids only; no tenant data in pg-boss). */
export function parseDeliveryJob(data: unknown): DeliveryJob {
  const d = data as Partial<Record<string, unknown>> | null;
  const keys = d && typeof d === 'object' ? Object.keys(d).sort().join(',') : '';
  if (
    keys !== 'eventId,tenantId' ||
    typeof d?.['tenantId'] !== 'string' ||
    typeof d['eventId'] !== 'string' ||
    !UUID_RE.test(d['tenantId']) ||
    !UUID_RE.test(d['eventId'])
  ) {
    throw new TypeError(`outbox: malformed delivery job ${JSON.stringify(data)}`);
  }
  return { tenantId: d['tenantId'], eventId: d['eventId'] };
}

interface EventRow {
  id: string;
  tenant_id: string;
  company_id: string | null;
  topic: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  created_at: Date;
}

async function loadEvent(trx: Transaction<Database>, eventId: string): Promise<OutboxEvent> {
  const { rows } = await sql<EventRow>`
    SELECT id, tenant_id, company_id, topic, aggregate_type, aggregate_id, payload, created_at
      FROM app.outbox_event WHERE id = ${eventId}`.execute(trx);
  const r = rows[0];
  // Under RLS another tenant's event is simply not there.
  if (!r) throw new Error(`outbox: event ${eventId} not found for this tenant`);
  return {
    id: r.id,
    tenantId: r.tenant_id,
    companyId: r.company_id,
    topic: r.topic,
    aggregateType: r.aggregate_type,
    aggregateId: r.aggregate_id,
    payload: r.payload,
    createdAt: r.created_at,
  };
}

export interface DeliverHooks {
  /** Called when a handler's transaction rolled back, before the error is rethrown. */
  onHandlerError?: (handler: string, error: unknown) => void;
}

/**
 * Deliver one event to every handler of its topic, each effect at most once. When every handler
 * has succeeded (now or before), the event's `retried` Sync issues are resolved (T-0071).
 */
export async function deliver(
  db: Kysely<Database>,
  registry: HandlerRegistry,
  job: DeliveryJob,
  hooks: DeliverHooks = {},
): Promise<DeliveryResult> {
  const { tenantId, eventId } = parseDeliveryJob(job);
  const event = await withTenant(db, tenantId, (trx) => loadEvent(trx, eventId));
  const result: DeliveryResult = { handled: [], skipped: [] };
  for (const handler of registry.forTopic(event.topic)) {
    const ran = await withTenant(db, tenantId, async (trx) => {
      const { rows } = await sql<{ handler: string }>`
        INSERT INTO app.outbox_inbox (event_id, handler) VALUES (${eventId}, ${handler.name})
        ON CONFLICT DO NOTHING RETURNING handler`.execute(trx);
      if (rows.length === 0) return false;
      await handler.handle(trx, event);
      return true;
    }).catch((error: unknown) => {
      hooks.onHandlerError?.(handler.name, error);
      throw error;
    });
    (ran ? result.handled : result.skipped).push(handler.name);
  }
  await withTenant(db, tenantId, (trx) => resolveRetriedIssues(trx, eventId));
  return result;
}
