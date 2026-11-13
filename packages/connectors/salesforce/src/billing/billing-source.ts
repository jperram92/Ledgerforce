/**
 * Billing source rules (T-0069, UC-01, RQ-0106): when a mirrored Opportunity / Order is ready to
 * invoice, and how a mirrored line item becomes an invoice line. Pure; money with decimal.js only.
 *
 *  - Won (RQ-0106 finding 2): IsWon when the mirror knows it, otherwise StageName ∈ won stages.
 *  - Activated (finding 3): StatusCode Activated (or A); unknown code → Status = Activated.
 *  - Complete (finding 4): at least one active line, and the active lines' TotalPrice sum equals
 *    the header Amount / TotalAmount — otherwise a line is still in flight and the source waits.
 *  - Lines (finding 5): (quantity, unit price) when quantity × unit price rounds to TotalPrice;
 *    a discounted line invoices its TotalPrice as quantity 1 and keeps the detail in the text.
 */
import { Decimal } from 'decimal.js';

export type BillingEntity = 'Opportunity' | 'Order';
export type LineEntity = 'OpportunityLineItem' | 'OrderItem';

export const LINE_ENTITY: Readonly<Record<BillingEntity, LineEntity>> = Object.freeze({
  Opportunity: 'OpportunityLineItem',
  Order: 'OrderItem',
});
export const TRIGGER_ENTITY: Readonly<Record<BillingSettings['invoiceTrigger'], BillingEntity>> =
  Object.freeze({ opportunity: 'Opportunity', order: 'Order' });
/** Billing format line source per trigger object (design §4.3). */
export const LINE_SOURCE: Readonly<Record<BillingEntity, string>> = Object.freeze({
  Opportunity: 'opportunity_line_items',
  Order: 'order_items',
});

export interface BillingSettings {
  /** §11.2 open decision: which object triggers the invoice (default opportunity). */
  invoiceTrigger: 'opportunity' | 'order';
  /** Stage values that mean won when IsWon is unknown (data; default Closed Won). */
  wonStages: readonly string[];
}

export const DEFAULT_BILLING_SETTINGS: Readonly<BillingSettings> = Object.freeze({
  invoiceTrigger: 'opportunity',
  wonStages: Object.freeze(['Closed Won']),
});

/** Latest known state of an Opportunity / Order (decimal strings, YYYY-MM-DD). */
export interface SourceHeader {
  entityName: BillingEntity;
  recordId: string;
  accountRecordId: string | null;
  stageName: string | null;
  isWon: boolean | null;
  status: string | null;
  statusCode: string | null;
  /** CloseDate (Opportunity) or EffectiveDate (Order). */
  sourceDate: string | null;
  /** Amount (Opportunity) or TotalAmount (Order). */
  amount: string | null;
  archived: boolean;
}

export interface SourceLine {
  recordId: string;
  product2RecordId: string | null;
  quantity: string | null;
  unitPrice: string | null;
  totalPrice: string | null;
  description: string | null;
  /** The LedgerForce product's name, the description fallback. */
  productName: string | null;
  archived: boolean;
}

export type BillingReadiness =
  | { ready: true }
  | {
      ready: false;
      reason:
        | 'NOT_TRIGGER_OBJECT'
        | 'ARCHIVED'
        | 'NOT_WON'
        | 'NOT_ACTIVATED'
        | 'NO_LINES'
        | 'INCOMPLETE_LINES';
    }
  | { ready: false; reason: 'INCOMPLETE_SOURCE'; missing: string[] };

export function isWon(h: SourceHeader, wonStages: readonly string[]): boolean {
  if (h.isWon !== null) return h.isWon;
  return h.stageName !== null && wonStages.includes(h.stageName);
}

export function isActivated(h: SourceHeader): boolean {
  if (h.statusCode !== null) return h.statusCode === 'Activated' || h.statusCode === 'A';
  return h.status === 'Activated';
}

const cents = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

export function billingReadiness(
  h: SourceHeader,
  lines: readonly SourceLine[],
  settings: BillingSettings,
): BillingReadiness {
  if (TRIGGER_ENTITY[settings.invoiceTrigger] !== h.entityName) {
    return { ready: false, reason: 'NOT_TRIGGER_OBJECT' };
  }
  if (h.archived) return { ready: false, reason: 'ARCHIVED' };
  if (h.entityName === 'Opportunity' && !isWon(h, settings.wonStages)) {
    return { ready: false, reason: 'NOT_WON' };
  }
  if (h.entityName === 'Order' && !isActivated(h)) {
    return { ready: false, reason: 'NOT_ACTIVATED' };
  }
  const missing = [
    ...(h.accountRecordId === null ? ['AccountId'] : []),
    ...(h.sourceDate === null ? ['date'] : []),
    ...(h.amount === null ? ['amount'] : []),
  ];
  if (missing.length > 0) return { ready: false, reason: 'INCOMPLETE_SOURCE', missing };
  const active = lines.filter((l) => !l.archived);
  if (active.length === 0) return { ready: false, reason: 'NO_LINES' };
  if (active.some((l) => l.totalPrice === null))
    return { ready: false, reason: 'INCOMPLETE_LINES' };
  const sum = active.reduce((s, l) => s.plus(l.totalPrice ?? '0'), new Decimal(0));
  if (!cents(sum).eq(cents(new Decimal(h.amount ?? '0')))) {
    return { ready: false, reason: 'INCOMPLETE_LINES' };
  }
  return { ready: true };
}

export interface InvoiceLineValues {
  quantity: string;
  unitPrice: string;
  description: string;
}

/** A mirrored line item as invoice line values (exact to the cent of its TotalPrice). */
export function invoiceLineFor(l: SourceLine): InvoiceLineValues {
  const text = l.description ?? l.productName ?? 'Item';
  const total = new Decimal(l.totalPrice ?? '0');
  if (l.quantity !== null && l.unitPrice !== null) {
    const q = new Decimal(l.quantity);
    const up = new Decimal(l.unitPrice);
    if (q.gt(0) && cents(q.times(up)).eq(cents(total))) {
      return { quantity: q.toFixed(), unitPrice: up.toFixed(), description: text };
    }
    return {
      quantity: '1',
      unitPrice: total.toFixed(),
      description: `${text} (${q.toFixed()} × ${up.toFixed(2)}, discounted)`,
    };
  }
  return { quantity: '1', unitPrice: total.toFixed(), description: text };
}
