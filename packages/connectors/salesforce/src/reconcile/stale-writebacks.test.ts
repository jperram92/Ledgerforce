/**
 * Which write-backs are stale (T-0070, RQ-0110 findings 5–6). Per Salesforce record and
 * LedgerForce-owned field, Salesforce should hold the value of the newest write-back event naming
 * the field; it does only if that event was delivered and no older event naming the field was
 * delivered after it. The re-push is per record with the merged newest values — never an old
 * event replayed over a newer one.
 */
import { describe, expect, it } from 'vitest';
import { SfNumber } from '../writeback/batch.ts';
import { planRepush, type WriteBackEventRow } from './stale-writebacks.ts';

const INV = '01900000-0000-7000-8000-000000070001';
const OPP = '006TEST00000001AAA';
const at = (n: number) => new Date(Date.UTC(2026, 9, 26, 0, 0, n));
const ev = (
  n: number,
  writeBack: Record<string, unknown>,
  deliveredAt: Date | null,
): WriteBackEventRow => ({
  id: `01900000-0000-7000-8000-0000000710${String(n).padStart(2, '0')}`,
  createdAt: at(n),
  payload: { writeBack: { version: 1, ...writeBack } },
  deliveredAt,
});
const invoice = (fields: Record<string, unknown>) => ({ invoices: [{ id: INV, ...fields }] });
const fieldsOf = (plan: ReturnType<typeof planRepush>, sobject: string) =>
  Object.fromEntries(
    Object.entries(plan.records.find((r) => r.sobject === sobject)?.fields ?? {}).map(([k, v]) => [
      k,
      v instanceof SfNumber ? v.literal : v,
    ]),
  );

describe('planRepush (stale write-backs, RQ-0110)', () => {
  it('an undelivered newest event is re-pushed per record with the merged newest values', () => {
    const plan = planRepush([
      ev(
        1,
        invoice({ number: 'INV-1', status: 'posted', total: '1375.0000', amountDue: '1375.0000' }),
        at(2),
      ),
      ev(3, invoice({ status: 'paid', amountDue: '0.0000' }), null),
    ]);
    expect(plan.records).toHaveLength(1);
    expect(fieldsOf(plan, 'LF_Invoice__c')).toEqual({
      Name: 'INV-1',
      LF_Status__c: 'Paid',
      LF_Total__c: '1375.00',
      LF_Amount_Due__c: '0.00',
    });
    expect(plan.cover).toEqual([{ eventId: ev(3, {}, null).id, keys: [plan.keys[0]] }]);
  });

  it('an old undelivered event behind a newer delivered one is not replayed, only marked', () => {
    const plan = planRepush([
      ev(1, invoice({ status: 'posted' }), null),
      ev(2, invoice({ status: 'paid' }), at(3)),
    ]);
    expect(plan.records).toEqual([]);
    expect(plan.cover).toEqual([{ eventId: ev(1, {}, null).id, keys: [] }]);
  });

  it('an older event delivered after a newer one (a backed-off retry) makes the field stale', () => {
    const plan = planRepush([
      ev(1, invoice({ status: 'overdue', daysOverdue: 3 }), at(9)),
      ev(2, invoice({ status: 'paid', daysOverdue: 0 }), at(5)),
    ]);
    expect(fieldsOf(plan, 'LF_Invoice__c')).toEqual({
      LF_Status__c: 'Paid',
      LF_Days_Overdue__c: '0',
    });
    expect(plan.cover).toEqual([]); // both delivered: nothing to mark
  });

  it('an event settled by an earlier reconciliation is not a late writer', () => {
    const plan = planRepush(
      [ev(1, invoice({ status: 'draft' }), null), ev(2, invoice({ status: 'posted' }), at(3))].map(
        (e, i) => (i === 0 ? { ...e, deliveredAt: at(9), reconciled: true } : e),
      ),
    );
    expect(plan.records).toEqual([]);
    expect(plan.cover).toEqual([]);
  });

  it('only fields an event names are its own; null is a value (clears), absent is not', () => {
    const plan = planRepush([
      ev(
        1,
        { opportunities: [{ sfId: OPP, invoiceStatus: 'posted', amountPaid: '10.0000' }] },
        at(2),
      ),
      ev(3, { opportunities: [{ sfId: OPP, amountPaid: null }] }, null),
    ]);
    expect(plan.records.map((r) => [r.op, r.sobject, r.key])).toEqual([
      ['update', 'Opportunity', OPP],
    ]);
    expect(fieldsOf(plan, 'Opportunity')).toEqual({
      LF_Invoice_Status__c: 'Posted',
      LF_Amount_Paid__c: null,
    });
  });

  it('events are ordered by creation, then id, whatever the input order; current records are left alone', () => {
    const plan = planRepush([
      ev(4, invoice({ status: 'paid' }), null),
      ev(2, { opportunities: [{ sfId: OPP, invoiceStatus: 'posted' }] }, at(3)),
      ev(1, invoice({ status: 'posted' }), at(2)),
    ]);
    expect(plan.records.map((r) => r.sobject)).toEqual(['LF_Invoice__c']);
    expect(fieldsOf(plan, 'LF_Invoice__c')).toEqual({ LF_Status__c: 'Paid' });
  });

  it('an event whose payload breaks the contract is reported and never covered', () => {
    const broken: WriteBackEventRow = {
      ...ev(5, {}, null),
      payload: { writeBack: { version: 1, invoices: [{ id: INV, total: 13.75 }] } },
    };
    const plan = planRepush([broken]);
    expect(plan.records).toEqual([]);
    expect(plan.cover).toEqual([]);
    expect(plan.unmappable).toEqual([
      { eventId: broken.id, error: expect.stringMatching(/must be a decimal string/) },
    ]);
  });
});
