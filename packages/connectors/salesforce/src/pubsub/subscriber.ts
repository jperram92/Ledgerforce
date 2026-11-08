/**
 * CDC subscriber over the Pub/Sub API (design §5.3, §5.6; RQ-0036; SS-PLAT-27, SS-PLAT-74).
 *
 * One Subscribe stream per (company, channel). It starts after the stored replay id (CUSTOM), or
 * at LATEST when there is none, and asks for at most `batchSize` (≤ 100) events. For each
 * response with events, ONE tenant transaction:
 *   1. moves the cursor from the replay id this run last committed to the batch's last replay id
 *      (compare-and-set, row lock: a second subscriber on the same channel fails, not doubles);
 *   2. per event, inserts its idempotency keys and skips the records already seen;
 *   3. applies changes through `handler`, and records gap and overflow events as resync requests.
 * Only after the commit does it request as many events as it consumed (flow control). A crash at
 * any point rolls the batch back whole, so a restart resumes from the committed replay id with no
 * lost and no repeated effect. A keepalive with nothing in flight stores `latest_replay_id`, which
 * keeps a quiet channel inside the 72 h retention. If Salesforce rejects the stored replay id, the
 * cursor is cleared and a resync request "since the last commit" is left for the reconcile job.
 *
 * The handler must do all its work in `trx` (connectors produce commands; postings only through
 * packages/ledger). Retries with back-off and token refresh belong to the caller (supervisor).
 */
import { withTenant, type Database } from '@ledgerforce/db';
import type { ServiceError } from '@grpc/grpc-js';
import type { Kysely, Transaction } from 'kysely';
import {
  changeKind,
  decodeConsumerEvent,
  idempotencyKeys,
  parseEventSchema,
  type DecodedEvent,
  type EventSchema,
} from './avro.ts';
import { pubSubMetadata, type PubSubAuth, type PubSubClient } from './client.ts';
import { classifyPubSubError, PubSubError, type PubSubErrorInfo } from './errors.ts';
import { MAX_NUM_REQUESTED, type FetchRequestMessage, type FetchResponseMessage } from './proto.ts';
import {
  advanceReplayCursor,
  claimIdempotencyKeys,
  getReplayCursor,
  recordResyncRequest,
  resetReplayCursor,
} from './replay-store.ts';

/** Apply one change event. `recordIds` are the event's records not applied before. */
export type CdcHandler = (
  trx: Transaction<Database>,
  event: DecodedEvent,
  recordIds: readonly string[],
) => Promise<void>;

export interface SubscriberOptions {
  db: Kysely<Database>;
  tenantId: string;
  companyId: string;
  /** e.g. '/data/AccountChangeEvent' or '/data/ChangeEvents'. */
  channel: string;
  client: PubSubClient;
  auth: () => Promise<PubSubAuth>;
  handler: CdcHandler;
  /** Events requested at a time; capped at 100 (RQ-0036 S5). Default 100. */
  batchSize?: number;
  signal?: AbortSignal;
  /** Called after each committed batch or keepalive cursor move. */
  onCommitted?: (c: { replayId: Buffer; events: number; applied: number }) => void;
}

export interface SubscriptionOutcome {
  /** aborted: signal; ended: server closed the stream; replay_reset: stored id rejected. */
  status: 'aborted' | 'ended' | 'replay_reset';
  batches: number;
  events: number;
  error?: PubSubErrorInfo;
}

const isServiceError = (e: unknown): e is ServiceError =>
  e instanceof Error && typeof (e as Partial<ServiceError>).code === 'number';

export async function runSubscription(o: SubscriberOptions): Promise<SubscriptionOutcome> {
  const batchSize = Math.min(
    Math.max(1, Math.trunc(o.batchSize ?? MAX_NUM_REQUESTED)),
    MAX_NUM_REQUESTED,
  );
  const inTenant = <R>(fn: (trx: Transaction<Database>) => Promise<R>) =>
    withTenant(o.db, o.tenantId, fn);
  const start = await inTenant((trx) => getReplayCursor(trx, o.companyId, o.channel));
  /** The replay id this run last committed; the compare-and-set's expected value. */
  let committed: Buffer | null = start?.replayId ?? null;
  const metadata = pubSubMetadata(await o.auth());
  const schemas = new Map<string, EventSchema>();
  const schemaFor = async (id: string) => {
    let s = schemas.get(id);
    if (!s) {
      s = parseEventSchema((await o.client.getSchema(id, metadata)).schemaJson);
      schemas.set(id, s);
    }
    return s;
  };

  const call = o.client.subscribe(metadata);
  const cancel = () => {
    call.cancel();
  };
  o.signal?.addEventListener('abort', cancel, { once: true });
  const first: FetchRequestMessage = committed
    ? { topicName: o.channel, replayPreset: 'CUSTOM', replayId: committed, numRequested: batchSize }
    : { topicName: o.channel, replayPreset: 'LATEST', numRequested: batchSize };
  call.write(first);

  let batches = 0;
  let events = 0;
  try {
    for await (const chunk of call) {
      const res = chunk as FetchResponseMessage;
      if (res.events.length === 0) {
        const latest = res.latestReplayId;
        if (latest.length > 0 && !committed?.equals(latest)) {
          const expected = committed;
          await inTenant((trx) =>
            advanceReplayCursor(trx, o.companyId, o.channel, { expected, next: latest, events: 0 }),
          );
          committed = Buffer.from(latest);
          batches += 1;
          o.onCommitted?.({ replayId: committed, events: 0, applied: 0 });
        }
        continue;
      }
      const decoded: DecodedEvent[] = [];
      for (const ev of res.events) {
        decoded.push(decodeConsumerEvent(await schemaFor(ev.event?.schemaId ?? ''), ev));
      }
      const last = (decoded.at(-1) as DecodedEvent).replayId;
      const expected = committed;
      const applied = await inTenant(async (trx) => {
        await advanceReplayCursor(trx, o.companyId, o.channel, {
          expected,
          next: last,
          events: decoded.length,
        });
        let n = 0;
        for (const e of decoded) n += await applyEvent(trx, o, e);
        return n;
      });
      committed = last;
      batches += 1;
      events += decoded.length;
      o.onCommitted?.({ replayId: last, events: decoded.length, applied });
      call.write({ numRequested: decoded.length });
    }
    return { status: o.signal?.aborted ? 'aborted' : 'ended', batches, events };
  } catch (err) {
    if (o.signal?.aborted) return { status: 'aborted', batches, events };
    if (!isServiceError(err)) throw err;
    const info = classifyPubSubError(err);
    if (info.kind === 'replay_id_invalid' && committed) {
      const expected = committed;
      await inTenant((trx) =>
        resetReplayCursor(trx, o.companyId, o.channel, { expected, errorCode: info.errorCode }),
      );
      return { status: 'replay_reset', batches, events, error: info };
    }
    throw new PubSubError(info);
  } finally {
    o.signal?.removeEventListener('abort', cancel);
    call.cancel();
  }
}

/** Dedupe one event and apply it; returns 1 if the handler ran. Runs in the batch transaction. */
async function applyEvent(
  trx: Transaction<Database>,
  o: SubscriberOptions,
  e: DecodedEvent,
): Promise<number> {
  const keys = idempotencyKeys(e);
  const fresh = await claimIdempotencyKeys(trx, o.companyId, o.channel, keys, e.replayId);
  if (fresh.size === 0) return 0;
  const h = e.header;
  const kind = changeKind(e);
  const recordIds = h ? h.recordIds.filter((_, i) => fresh.has(keys[i] as string)) : [];
  if (h && (kind === 'gap' || kind === 'overflow')) {
    await recordResyncRequest(trx, o.companyId, o.channel, {
      reason: kind === 'gap' ? 'gap_event' : 'overflow',
      entityName: h.entityName,
      recordIds: kind === 'gap' ? recordIds : [],
      changeType: h.changeType,
      commitTimestamp: new Date(Number(h.commitTimestamp)),
      replayId: e.replayId,
    });
    return 0;
  }
  await o.handler(trx, e, recordIds);
  return 1;
}
