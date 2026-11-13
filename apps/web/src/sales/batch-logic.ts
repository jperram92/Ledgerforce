/**
 * Batch billing screen logic (T-0084, UC-02): titles, the default period, period checks, each
 * invoice's result in a word (P2) and the exception list. Dates only; no money arithmetic here:
 * every amount is the API's decimal string.
 */
import { ROLE_TEMPLATES, type RoleId } from '@ledgerforce/shared/rbac';
import type { BatchItem } from './client.ts';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Roles a person can hold in LedgerForce (not the Salesforce-side or service roles). */
const PEOPLE_ROLES: readonly RoleId[] = [
  'owner',
  'finance_admin',
  'accountant',
  'ar_clerk',
  'ap_clerk',
  'approver',
  'payroll_officer',
  'auditor',
];

/** "Owner, Finance Admin and Approver": who holds a permission, from the role templates. */
export function rolesWith(permission: string, joiner: 'and' | 'or' = 'and'): string {
  const names = PEOPLE_ROLES.filter((r) =>
    (ROLE_TEMPLATES[r].permissions as readonly string[]).includes(permission),
  ).map((r) => ROLE_TEMPLATES[r].name);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} ${joiner} ${names[names.length - 1] ?? ''}`;
}

const daysIn = (year: number, month: number): number =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

const pad = (n: number) => String(n).padStart(2, '0');

function realDay(d: string): { y: number; m: number; d: number } | null {
  if (!DATE.test(d)) return null;
  // A calendar date, not money: let the UTC calendar reject 2026-02-30 and 2026-13-01.
  const t = new Date(`${d}T00:00:00Z`);
  if (Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== d) return null;
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** The calendar month a day (YYYY-MM-DD) falls in. */
export function monthOf(day: string): { from: string; to: string } {
  const r = realDay(day);
  if (!r) return { from: '', to: '' };
  const ym = `${String(r.y)}-${pad(r.m)}`;
  return { from: `${ym}-01`, to: `${ym}-${pad(daysIn(r.y, r.m))}` };
}

/** "November 2026 batch" for a whole calendar month; otherwise the dates. */
export function batchTitle(from: string, to: string): string {
  const month = monthOf(from);
  const f = realDay(from);
  if (f && month.from === from && month.to === to) {
    return `${MONTHS[f.m - 1] ?? ''} ${String(f.y)} batch`;
  }
  return `Batch for ${from} to ${to}`;
}

export interface PeriodForm {
  from: string;
  to: string;
  /** Invoice date; empty means the last day of the period. */
  issue: string;
}

export function checkPeriod(p: PeriodForm): string[] {
  const problems: string[] = [];
  if (!realDay(p.from)) problems.push('Choose the first day of the period.');
  if (!realDay(p.to)) problems.push('Choose the last day of the period.');
  if (problems.length === 0 && p.to < p.from) {
    problems.push('The period ends before it starts. Check the dates.');
  }
  if (p.issue !== '' && !realDay(p.issue)) problems.push('The invoice date is not a real day.');
  return problems;
}

export type ItemStatus = 'ready' | 'attention' | 'posted' | 'failed';

export function itemResult(i: BatchItem): { word: string; status: ItemStatus } {
  if (i.status === 'posted') {
    return { word: i.invoice_no ? `Posted ${i.invoice_no}` : 'Posted', status: 'posted' };
  }
  if (i.status === 'failed') return { word: 'Failed', status: 'failed' };
  return i.warnings.length > 0
    ? { word: 'Needs attention', status: 'attention' }
    : { word: 'Ready', status: 'ready' };
}

/** A message from the API as a sentence: capital first letter, full stop at the end. */
const sentence = (s: string): string => {
  const t = s.trim();
  if (t === '') return t;
  const c = `${t.charAt(0).toUpperCase()}${t.slice(1)}`;
  return /[.!?]$/.test(c) ? c : `${c}.`;
};

export interface BatchException {
  item: BatchItem;
  issue: string;
  next: string;
}

const WILL_FAIL =
  'Fix it before the batch runs. If it is still like this then, this invoice fails and the other invoices still post.';
const FAILED =
  'Not invoiced and no number used. Its billing lines stay pending, so the next batch picks them up once it is fixed.';

/**
 * The exception list (UC-02 A1): invoices with warnings that have not run yet, and invoices the
 * job could not post, with the reason and what happens next (P6).
 */
export function exceptionsOf(items: readonly BatchItem[]): BatchException[] {
  const out: BatchException[] = [];
  for (const i of items) {
    if (i.status === 'failed') {
      out.push({
        item: i,
        issue: sentence(i.failure_message ?? 'The invoice failed'),
        next: FAILED,
      });
    } else if (i.status === 'preview' && i.warnings.length > 0) {
      const issue = i.warnings
        .map((w) => (w.line > 0 ? `Line ${String(w.line)}: ${w.message}` : w.message))
        .map(sentence)
        .join(' ');
      out.push({ item: i, issue, next: WILL_FAIL });
    }
  }
  return out;
}
