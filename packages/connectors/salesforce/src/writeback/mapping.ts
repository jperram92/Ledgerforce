/**
 * Write-back mapping as data (design §5.4, §5.5; ADR-0006, ADR-0036; DL-0191). An outbox event
 * that should reach Salesforce carries a `writeBack` snapshot in its payload (contract v1):
 *
 *   { "writeBack": { "version": 1,
 *       "invoices":      [{ id, number, status, issueDate, dueDate, total, amountDue,
 *                          amountCredited, daysOverdue, lastPaymentDate, pdfUrl, paymentUrl,
 *                          accountSfId, opportunitySfId }],
 *       "payments":      [{ id, invoiceId, paymentDate, amount, method, reference, accountSfId }],
 *       "accounts":      [{ sfId, balanceDue, overdueAmount, creditStatus, lastPaymentDate }],
 *       "opportunities": [{ sfId, invoiceStatus, amountInvoiced, amountPaid }] } }
 *
 * Values are *current state*, not deltas, so replaying an event rewrites the same values
 * (idempotent). Money is a decimal string (NUMERIC(19,4) text); it is sent with two decimals and
 * never rounded: a non-zero third or fourth decimal is a contract error. A key that is absent is
 * not written; `null` clears the field. FIELD_MAP below is the single list of LedgerForce-owned
 * Salesforce fields (field ownership as data).
 */
import { SfNumber, SfReference, type SfValue, type WriteBackRecord } from './batch.ts';

/** Outbox topics the write-back handler subscribes to (design §5.4, plus the draft status). */
export const WRITEBACK_TOPICS = [
  'invoice.drafted',
  'invoice.posted',
  'invoice.paid',
  'invoice.overdue',
  'payment.received',
  'credit_note.posted',
  'party.credit_hold_changed',
] as const;

/** LedgerForce document status → the word Salesforce users see (Docs/ui/principles.md P2). */
export const INVOICE_STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  draft: 'Draft',
  awaiting_approval: 'Awaiting approval',
  approved: 'Approved',
  posted: 'Posted',
  part_paid: 'Part paid',
  paid: 'Paid',
  overdue: 'Overdue',
  void: 'Void',
  reversed: 'Reversed',
});

/** Party credit status → Account.LF_Credit_Status__c (UC-04). */
export const CREDIT_STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  current: 'Current',
  overdue: 'Overdue',
  on_hold: 'On hold',
});

export type FieldKind =
  | 'text'
  | 'date'
  | 'money'
  | 'integer'
  | 'url'
  | 'sfid'
  | 'invoiceStatus'
  | 'creditStatus'
  | 'lfRef';

export interface FieldRule {
  /** Key in the payload section. */
  from: string;
  /** Salesforce field API name (`…__r` for an external-ID lookup). */
  to: string;
  kind: FieldKind;
  /** Text length limit from the package metadata. */
  max?: number;
}

export type Section = 'invoices' | 'payments' | 'accounts' | 'opportunities';

export interface SectionMap {
  section: Section;
  sobject: string;
  match: { op: 'upsert'; from: 'id'; field: 'LF_Id__c' } | { op: 'update'; from: 'sfId' };
  fields: readonly FieldRule[];
}

/** The LedgerForce-owned Salesforce fields, in send order (mirrors first; the invoice before its payment). */
export const FIELD_MAP: readonly SectionMap[] = Object.freeze([
  {
    section: 'invoices',
    sobject: 'LF_Invoice__c',
    match: { op: 'upsert', from: 'id', field: 'LF_Id__c' },
    fields: [
      { from: 'number', to: 'Name', kind: 'text', max: 80 },
      { from: 'status', to: 'LF_Status__c', kind: 'invoiceStatus' },
      { from: 'issueDate', to: 'LF_Issue_Date__c', kind: 'date' },
      { from: 'dueDate', to: 'LF_Due_Date__c', kind: 'date' },
      { from: 'total', to: 'LF_Total__c', kind: 'money' },
      { from: 'amountDue', to: 'LF_Amount_Due__c', kind: 'money' },
      { from: 'amountCredited', to: 'LF_Amount_Credited__c', kind: 'money' },
      { from: 'daysOverdue', to: 'LF_Days_Overdue__c', kind: 'integer' },
      { from: 'lastPaymentDate', to: 'LF_Last_Payment_Date__c', kind: 'date' },
      { from: 'pdfUrl', to: 'LF_PDF_Link__c', kind: 'url' },
      { from: 'paymentUrl', to: 'LF_Payment_Link__c', kind: 'url' },
      { from: 'accountSfId', to: 'LF_Account__c', kind: 'sfid' },
      { from: 'opportunitySfId', to: 'LF_Opportunity__c', kind: 'sfid' },
    ],
  },
  {
    section: 'payments',
    sobject: 'LF_Payment__c',
    match: { op: 'upsert', from: 'id', field: 'LF_Id__c' },
    fields: [
      { from: 'invoiceId', to: 'LF_Invoice__r', kind: 'lfRef' },
      { from: 'paymentDate', to: 'LF_Payment_Date__c', kind: 'date' },
      { from: 'amount', to: 'LF_Amount__c', kind: 'money' },
      { from: 'method', to: 'LF_Method__c', kind: 'text', max: 40 },
      { from: 'reference', to: 'LF_Reference__c', kind: 'text', max: 255 },
      { from: 'accountSfId', to: 'LF_Account__c', kind: 'sfid' },
    ],
  },
  {
    section: 'accounts',
    sobject: 'Account',
    match: { op: 'update', from: 'sfId' },
    fields: [
      { from: 'balanceDue', to: 'LF_Balance_Due__c', kind: 'money' },
      { from: 'overdueAmount', to: 'LF_Overdue_Amount__c', kind: 'money' },
      { from: 'creditStatus', to: 'LF_Credit_Status__c', kind: 'creditStatus' },
      { from: 'lastPaymentDate', to: 'LF_Last_Payment_Date__c', kind: 'date' },
    ],
  },
  {
    section: 'opportunities',
    sobject: 'Opportunity',
    match: { op: 'update', from: 'sfId' },
    fields: [
      { from: 'invoiceStatus', to: 'LF_Invoice_Status__c', kind: 'invoiceStatus' },
      { from: 'amountInvoiced', to: 'LF_Amount_Invoiced__c', kind: 'money' },
      { from: 'amountPaid', to: 'LF_Amount_Paid__c', kind: 'money' },
    ],
  },
] satisfies SectionMap[]);

export type SectionRow = Record<string, unknown>;
export interface WriteBackPayloadV1 {
  version: 1;
  sections: Partial<Record<Section, SectionRow[]>>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SFID_RE = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;
const MONEY_RE = /^(-?\d+)(?:\.(\d+))?$/;
const SECTIONS = new Set<string>(FIELD_MAP.map((s) => s.section));

const bad = (msg: string): never => {
  throw new TypeError(`write-back payload: ${msg}`);
};

/** The `writeBack` part of an event payload, or null when the event has none (nothing to send). */
export function parseWriteBackPayload(payload: unknown): WriteBackPayloadV1 | null {
  if (!payload || typeof payload !== 'object' || !('writeBack' in payload)) return null;
  const wb = (payload as { writeBack: unknown }).writeBack;
  if (!wb || typeof wb !== 'object' || Array.isArray(wb)) return bad('writeBack must be an object');
  const { version, ...rest } = wb as Record<string, unknown>;
  if (version !== 1) return bad(`unsupported version ${JSON.stringify(version)}`);
  const sections: WriteBackPayloadV1['sections'] = {};
  for (const [k, v] of Object.entries(rest)) {
    if (!SECTIONS.has(k)) return bad(`unknown section ${k}`);
    if (!Array.isArray(v) || v.some((r) => !r || typeof r !== 'object' || Array.isArray(r))) {
      return bad(`${k} must be an array of objects`);
    }
    sections[k as Section] = v as SectionRow[];
  }
  return { version: 1, sections };
}

/** Exact two-decimal literal; refuses floats and non-zero digits beyond the cent. */
function money(v: unknown, where: string): SfNumber {
  if (typeof v !== 'string') return bad(`${where} must be a decimal string, not ${typeof v}`);
  const m = MONEY_RE.exec(v);
  if (!m) return bad(`${where} is not a decimal: ${JSON.stringify(v)}`);
  const frac = m[2] ?? '';
  if (/[^0]/.test(frac.slice(2))) return bad(`${where} has more than two decimals: ${v}`);
  const int = (m[1] ?? '').replace(/^(-?)0+(?=\d)/, '$1');
  const cents = frac.slice(0, 2).padEnd(2, '0');
  // "-0.00" is zero; "-0.50" keeps its sign.
  return new SfNumber(`${int === '-0' && cents === '00' ? '0' : int}.${cents}`);
}

function date(v: unknown, where: string): string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v))
    return bad(`${where} must be YYYY-MM-DD`);
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v)
    return bad(`${where} is not a date`);
  return v;
}

function label(table: Readonly<Record<string, string>>, v: unknown, where: string): string {
  const l = typeof v === 'string' && Object.hasOwn(table, v) ? table[v] : undefined;
  return l ?? bad(`${where} has unknown status ${JSON.stringify(v)}`);
}

function convert(rule: FieldRule, v: unknown, where: string): SfValue {
  if (v === null && rule.kind !== 'lfRef') return null;
  switch (rule.kind) {
    case 'money':
      return money(v, where);
    case 'date':
      return date(v, where);
    case 'integer':
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > 999_999)
        return bad(`${where} must be a whole number 0–999999`);
      return new SfNumber(String(v));
    case 'sfid':
      if (typeof v !== 'string' || !SFID_RE.test(v)) return bad(`${where} is not a Salesforce id`);
      return v;
    case 'lfRef':
      if (typeof v !== 'string' || !UUID_RE.test(v)) return bad(`${where} is not a LedgerForce id`);
      return new SfReference('LF_Id__c', v.toLowerCase());
    case 'url':
      if (typeof v !== 'string' || !/^https:\/\/\S+$/.test(v) || v.length > 255)
        return bad(`${where} must be an https URL`);
      return v;
    case 'invoiceStatus':
      return label(INVOICE_STATUS_LABELS, v, where);
    case 'creditStatus':
      return label(CREDIT_STATUS_LABELS, v, where);
    case 'text':
      if (typeof v !== 'string' || v.length > (rule.max ?? 255))
        return bad(`${where} must be text of at most ${String(rule.max ?? 255)} characters`);
      return v;
  }
}

/** Map a parsed payload to Salesforce records, in FIELD_MAP order. */
export function mapToRecords(payload: WriteBackPayloadV1 | null): WriteBackRecord[] {
  if (!payload) return [];
  const out: WriteBackRecord[] = [];
  for (const section of FIELD_MAP) {
    const rows = payload.sections[section.section] ?? [];
    rows.forEach((row, i) => {
      const where = `${section.section}[${String(i)}]`;
      const known = new Set<string>([section.match.from, ...section.fields.map((f) => f.from)]);
      for (const k of Object.keys(row)) if (!known.has(k)) bad(`${where} has unknown key ${k}`);
      const rawKey = row[section.match.from];
      const fields: Record<string, SfValue> = {};
      for (const rule of section.fields) {
        if (rule.from in row)
          fields[rule.to] = convert(rule, row[rule.from], `${where}.${rule.from}`);
      }
      if (section.match.op === 'upsert') {
        if (typeof rawKey !== 'string' || !UUID_RE.test(rawKey))
          bad(`${where}.id is not a LedgerForce id`);
        out.push({
          op: 'upsert',
          sobject: section.sobject,
          externalIdField: section.match.field,
          key: String(rawKey).toLowerCase(),
          fields,
        });
      } else {
        if (typeof rawKey !== 'string' || !SFID_RE.test(rawKey))
          bad(`${where}.sfId is not a Salesforce id`);
        out.push({ op: 'update', sobject: section.sobject, key: String(rawKey), fields });
      }
    });
  }
  return out;
}
