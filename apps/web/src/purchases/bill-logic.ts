/**
 * Plain-word logic of the bills screens (T-0086): the state word (P2), the bill's name, who acts
 * next (P13) and the entry form's checks. Amounts stay strings: they are only checked against a
 * pattern and stripped of thousands separators, never converted to a number.
 */
import type { BillBody, BillRow } from './client.ts';

type Named = Pick<
  BillRow,
  'bill_no' | 'status' | 'awaiting_approval' | 'supplier_name' | 'supplier_ref'
>;

export function billStatus(b: Pick<BillRow, 'status' | 'awaiting_approval'>): {
  key: 'draft' | 'awaiting' | 'posted' | 'void';
  word: string;
} {
  if (b.status === 'posted') return { key: 'posted', word: 'Posted' };
  if (b.status === 'void') return { key: 'void', word: 'Void' };
  return b.awaiting_approval
    ? { key: 'awaiting', word: 'Waiting for approval' }
    : { key: 'draft', word: 'Draft' };
}

export const billName = (b: Named): string =>
  b.bill_no
    ? `${b.bill_no}, ${b.supplier_name}`
    : `Draft bill ${b.supplier_ref} from ${b.supplier_name}`;

export function nextTurn(b: Pick<BillRow, 'status' | 'awaiting_approval'>): string {
  if (b.status === 'posted') return 'Nobody: posted';
  if (b.status === 'void') return 'Nobody: void';
  return b.awaiting_approval ? 'An Approver' : 'AP Clerk: send for approval';
}

export interface BillFormLine {
  description: string;
  accountId: string;
  taxCode: string;
  amount: string;
}

export interface BillForm {
  partyId: string;
  supplierRef: string;
  billDate: string;
  dueDate: string;
  lines: BillFormLine[];
}

export const emptyLine = (): BillFormLine => ({
  description: '',
  accountId: '',
  taxCode: '',
  amount: '',
});

const AMOUNT = /^\d{1,15}(\.\d{1,2})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const realDate = (d: string) =>
  DATE.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
const validDate = (d: string) => {
  try {
    return realDate(d);
  } catch {
    return false;
  }
};

export function formToBody(
  companyId: string,
  f: BillForm,
): { ok: true; body: BillBody } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  if (!f.partyId) problems.push('Choose the supplier.');
  if (!f.supplierRef.trim()) problems.push("Write the supplier's invoice number.");
  if (!f.billDate) problems.push('Give the bill date.');
  else if (!validDate(f.billDate)) problems.push('The bill date is not a real date.');
  if (f.dueDate && !validDate(f.dueDate)) problems.push('The due date is not a real date.');
  const lines = f.lines.map((l, i) => {
    const n = `Line ${String(i + 1)}`;
    if (!l.description.trim()) problems.push(`${n}: write what it is for.`);
    if (!l.accountId) problems.push(`${n}: choose an account.`);
    if (!l.taxCode) problems.push(`${n}: choose a tax code.`);
    const amount = l.amount.trim().replace(/,/g, '');
    if (amount === '') problems.push(`${n}: give the amount before GST.`);
    else if (/^\d+\.\d{3,}$/.test(amount))
      problems.push(`${n}: the amount needs at most two decimals.`);
    else if (!AMOUNT.test(amount))
      problems.push(`${n}: the amount is a number like 1250.00, without a minus sign or $.`);
    return {
      description: l.description.trim(),
      account_id: l.accountId,
      tax_code: l.taxCode,
      amount,
    };
  });
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    body: {
      company_id: companyId,
      party_id: f.partyId,
      supplier_ref: f.supplierRef.trim(),
      bill_date: f.billDate,
      ...(f.dueDate ? { due_date: f.dueDate } : {}),
      lines,
    },
  };
}
