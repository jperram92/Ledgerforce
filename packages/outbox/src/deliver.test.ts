/**
 * SS-PLAT-24 (unit part) — the handler registry and the delivery-job contract (T-0030).
 */
import { describe, expect, it } from 'vitest';
import { HandlerRegistry, parseDeliveryJob, type OutboxHandler } from './deliver.ts';
import { OUTBOX_DEAD_LETTER_QUEUE, OUTBOX_QUEUE_OPTIONS } from './queue.ts';

const h = (name: string, topics: string[]): OutboxHandler => ({
  name,
  topics,
  handle: async () => {},
});

describe('SS-PLAT-24 handler registry', () => {
  it('SS-PLAT-24 returns the handlers of a topic in registration order', () => {
    const r = new HandlerRegistry()
      .register(h('salesforce.writeback', ['ledger.entry.posted']))
      .register(h('email.pdf', ['ar.invoice.issued']))
      .register(h('dunning.update', ['ledger.entry.posted', 'ar.invoice.issued']));
    expect(r.forTopic('ledger.entry.posted').map((x) => x.name)).toEqual([
      'salesforce.writeback',
      'dunning.update',
    ]);
    expect(r.forTopic('nobody.listens')).toEqual([]);
  });

  it('SS-PLAT-24 refuses a duplicate handler name (the inbox key)', () => {
    const r = new HandlerRegistry().register(h('a.b', ['x.y']));
    expect(() => r.register(h('a.b', ['z.w']))).toThrow(/already registered/);
  });

  it('SS-PLAT-24 refuses names and topics the database would refuse', () => {
    expect(() => new HandlerRegistry().register(h('Bad Name', ['x.y']))).toThrow(/handler name/);
    expect(() => new HandlerRegistry().register(h('', ['x.y']))).toThrow(/handler name/);
    expect(() => new HandlerRegistry().register(h('a'.repeat(101), ['x.y']))).toThrow(
      /handler name/,
    );
    expect(() => new HandlerRegistry().register(h('ok', ['NoDots']))).toThrow(/topic/);
    expect(() => new HandlerRegistry().register(h('ok', []))).toThrow(/topic/);
  });
});

describe('SS-PLAT-24 delivery job contract', () => {
  const tenantId = '01900000-0000-7000-8000-000000003002';
  const eventId = '01900000-0000-7000-8000-0000000000e1';

  it('SS-PLAT-24 accepts exactly { tenantId, eventId } as UUIDs', () => {
    expect(parseDeliveryJob({ tenantId, eventId })).toEqual({ tenantId, eventId });
  });

  it.each([
    ['null', null],
    ['missing event', { tenantId }],
    ['bad tenant', { tenantId: 'x', eventId }],
    ['bad event', { tenantId, eventId: 42 }],
    ['extra field', { tenantId, eventId, payload: { amount: '1.00' } }],
  ])('SS-PLAT-24 refuses %s', (_label, data) => {
    expect(() => parseDeliveryJob(data)).toThrow(/delivery job/);
  });
});

describe('SS-PLAT-24 retry policy', () => {
  it('SS-PLAT-24 backs off exponentially from 1 minute to at most 6 hours, then dead-letters', () => {
    expect(OUTBOX_QUEUE_OPTIONS.retryBackoff).toBe(true);
    expect(OUTBOX_QUEUE_OPTIONS.retryDelay).toBe(60);
    expect(OUTBOX_QUEUE_OPTIONS.retryDelayMax).toBe(21_600);
    // The cap is reachable: 60 s * 2^9 > 6 h, so the last retries wait the full 6 hours.
    expect(60 * 2 ** (OUTBOX_QUEUE_OPTIONS.retryLimit - 1)).toBeGreaterThan(21_600);
    expect(OUTBOX_QUEUE_OPTIONS.deadLetter).toBe(OUTBOX_DEAD_LETTER_QUEUE);
  });
});
