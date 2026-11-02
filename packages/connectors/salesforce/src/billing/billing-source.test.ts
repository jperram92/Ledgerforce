/**
 * Billing source rules (T-0069, UC-01, RQ-0106): when a mirrored Opportunity / Order is ready to
 * invoice, and how its lines become invoice lines. Pure; the database flow is closed-won.db.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  billingReadiness,
  invoiceLineFor,
  isActivated,
  isWon,
  type BillingSettings,
  type SourceHeader,
  type SourceLine,
} from './billing-source.ts';

const settings: BillingSettings = { invoiceTrigger: 'opportunity', wonStages: ['Closed Won'] };

const opp = (o: Partial<SourceHeader> = {}): SourceHeader => ({
  entityName: 'Opportunity',
  recordId: '006000000000001AAA',
  accountRecordId: '001000000000001AAA',
  stageName: 'Closed Won',
  isWon: null,
  status: null,
  statusCode: null,
  sourceDate: '2026-11-05',
  amount: '1250',
  archived: false,
  ...o,
});

const line = (o: Partial<SourceLine> = {}): SourceLine => ({
  recordId: '00k000000000001AAA',
  product2RecordId: '01t000000000001AAA',
  quantity: '1',
  unitPrice: '1000',
  totalPrice: '1000',
  description: null,
  productName: 'Professional services',
  archived: false,
  ...o,
});

const lines = [
  line(),
  line({ recordId: '00k000000000002AAA', unitPrice: '250', totalPrice: '250' }),
];

describe('Closed Won / Order activated detection (RQ-0106 findings 2–3)', () => {
  it('IsWon wins when known; otherwise the stage is matched against the won stages (data)', () => {
    expect(isWon(opp({ isWon: true, stageName: 'Signed' }), ['Closed Won'])).toBe(true);
    expect(isWon(opp({ isWon: false, stageName: 'Closed Won' }), ['Closed Won'])).toBe(false);
    expect(isWon(opp({ isWon: null, stageName: 'Closed Won' }), ['Closed Won'])).toBe(true);
    expect(isWon(opp({ isWon: null, stageName: 'Signed' }), ['Closed Won', 'Signed'])).toBe(true);
    expect(isWon(opp({ isWon: null, stageName: 'Negotiation' }), ['Closed Won'])).toBe(false);
  });

  it('an Order is activated by StatusCode (Activated or A), else by Status when the code is unknown', () => {
    const order = (o: Partial<SourceHeader>) => opp({ entityName: 'Order', stageName: null, ...o });
    expect(isActivated(order({ statusCode: 'Activated' }))).toBe(true);
    expect(isActivated(order({ statusCode: 'A' }))).toBe(true);
    expect(isActivated(order({ statusCode: 'Draft', status: 'Activated' }))).toBe(false);
    expect(isActivated(order({ statusCode: null, status: 'Activated' }))).toBe(true);
    expect(isActivated(order({ statusCode: null, status: 'Ready for Review' }))).toBe(false);
  });
});

describe('Billing readiness (RQ-0106 finding 4, card open question §11.2)', () => {
  it('a won Opportunity whose lines add up to its Amount is ready', () => {
    expect(billingReadiness(opp(), lines, settings)).toEqual({ ready: true });
  });

  it('waits while the mirrored lines do not yet add up to the Amount (a line still in flight)', () => {
    expect(billingReadiness(opp(), [line()], settings)).toEqual({
      ready: false,
      reason: 'INCOMPLETE_LINES',
    });
    expect(billingReadiness(opp(), [], settings)).toEqual({ ready: false, reason: 'NO_LINES' });
    // An archived (deleted) line no longer counts.
    expect(
      billingReadiness(opp({ amount: '1000' }), [lines[0] as SourceLine, { ...(lines[1] as SourceLine), archived: true }], settings),
    ).toEqual({ ready: true });
  });

  it('not won, archived or the other trigger object → not ready, with the reason', () => {
    expect(billingReadiness(opp({ stageName: 'Prospecting' }), lines, settings)).toEqual({
      ready: false,
      reason: 'NOT_WON',
    });
    expect(billingReadiness(opp({ archived: true }), lines, settings)).toEqual({
      ready: false,
      reason: 'ARCHIVED',
    });
    expect(
      billingReadiness(opp(), lines, { ...settings, invoiceTrigger: 'order' }),
    ).toEqual({ ready: false, reason: 'NOT_TRIGGER_OBJECT' });
    const order = opp({ entityName: 'Order', stageName: null, statusCode: 'Draft' });
    expect(billingReadiness(order, lines, { ...settings, invoiceTrigger: 'order' })).toEqual({
      ready: false,
      reason: 'NOT_ACTIVATED',
    });
    expect(
      billingReadiness({ ...order, statusCode: 'Activated' }, lines, {
        ...settings,
        invoiceTrigger: 'order',
      }),
    ).toEqual({ ready: true });
  });

  it('a won source lacking the Account, the date or the amount is incomplete (needs a reconcile)', () => {
    expect(
      billingReadiness(opp({ accountRecordId: null, sourceDate: null }), lines, settings),
    ).toEqual({ ready: false, reason: 'INCOMPLETE_SOURCE', missing: ['AccountId', 'date'] });
    expect(billingReadiness(opp({ amount: null }), lines, settings)).toEqual({
      ready: false,
      reason: 'INCOMPLETE_SOURCE',
      missing: ['amount'],
    });
  });
});

describe('Line mapping (RQ-0106 finding 5)', () => {
  it('quantity × unit price that equals TotalPrice keeps quantity and unit price', () => {
    expect(invoiceLineFor(line({ quantity: '3', unitPrice: '83.335', totalPrice: '250.01' }))).toEqual({
      quantity: '3',
      unitPrice: '83.335',
      description: 'Professional services',
    });
  });

  it('a discounted line invoices its TotalPrice as quantity 1, keeping quantity and list price in the description', () => {
    expect(
      invoiceLineFor(
        line({ quantity: '2', unitPrice: '500', totalPrice: '900', description: 'Workshop' }),
      ),
    ).toEqual({
      quantity: '1',
      unitPrice: '900',
      description: 'Workshop (2 × 500.00, discounted)',
    });
  });

  it('Avro doubles converted at the boundary keep exact cents (no float arithmetic)', () => {
    expect(invoiceLineFor(line({ quantity: '3', unitPrice: '0.1', totalPrice: '0.3' }))).toEqual({
      quantity: '3',
      unitPrice: '0.1',
      description: 'Professional services',
    });
  });
});
