/**
 * Harbour & Co Pty Ltd — the fictional demo business of the Timeline reference screens
 * (Docs/ui/research/directions/c-timeline/home.html, invoice.html), as typed component data.
 * Amounts are decimal strings (never JS numbers). Weekday names are not stored: components compute
 * them from the dates (the prototype's hand-written "Mon 27 Oct" was wrong; 27 Oct 2026 is a Tuesday).
 */
import type { CashPoint, TimelineLane } from '../components/types.ts';
import type { JournalLine } from '../components/JournalTable.tsx';
import type { SpineEvent } from '../components/Spine.tsx';
import type { OpenItem } from '../components/TurnQueue.tsx';

export const HARBOUR_TODAY = '2026-10-24';
export const HARBOUR_LAST_STATEMENT = '2026-10-23';

export const harbourCash: CashPoint[] = [
  ['2026-10-01', '158904.20'],
  ['2026-10-03', '171420.00'],
  ['2026-10-06', '165180.50'],
  ['2026-10-09', '176930.10'],
  ['2026-10-13', '184605.75'],
  ['2026-10-16', '146391.15'],
  ['2026-10-20', '168240.80'],
  ['2026-10-21', '160410.80'],
  ['2026-10-23', '184320.55'],
  ['2026-10-27', '196500.55'],
  ['2026-10-28', '161481.45'],
  ['2026-10-30', '123266.85'],
  ['2026-10-31', '144826.85'],
  ['2026-11-03', '136576.85'],
  ['2026-11-05', '154876.85'],
];

/** Lane order is a P14 contract: new lanes are added below, never re-ordered. */
export const harbourLanes: TimelineLane[] = [
  {
    id: 'customers',
    name: 'Customers pay you',
    sub: '31 open invoices',
    items: [
      { id: 'c-overdue', date: '2026-10-01', end: '2026-10-23', label: 'Overdue', amount: '33482.50', state: 'overdue', sub: '8 invoices; Jordan is following up' },
      { id: 'c-1023', date: '2026-10-23', label: 'Received', amount: '23909.75', state: 'actual', sub: 'customer payments' },
      { id: 'c-1027', date: '2026-10-27', label: 'Due', amount: '12180.00', state: 'expected', sub: '3 invoices' },
      { id: 'c-1031', date: '2026-10-31', label: 'Due', amount: '21560.00', state: 'expected', sub: '5 invoices' },
      { id: 'c-1105', date: '2026-11-05', label: 'Due', amount: '18300.00', state: 'expected', sub: '4 invoices, incl. Saltbush' },
    ],
  },
  {
    id: 'pay',
    name: 'You pay',
    sub: 'bills, wages, rent',
    items: [
      { id: 'p-1016', date: '2026-10-16', label: 'Pay run', amount: '-38214.60', state: 'actual', sub: 'paid' },
      { id: 'p-1028', date: '2026-10-28', label: 'Suppliers', amount: '-22415.00', state: 'expected', sub: '11 bills, run PB-0087' },
      { id: 'p-1030', date: '2026-10-30', label: 'Pay run', amount: '-38214.60', state: 'expected', sub: 'net wages' },
      { id: 'p-1103', date: '2026-11-03', label: 'Rent', amount: '-8250.00', state: 'expected', sub: 'monthly' },
    ],
  },
  {
    id: 'tax',
    name: 'Tax',
    sub: 'ATO',
    items: [
      { id: 't-bas', date: '2026-10-28', label: 'BAS: GST', amount: '-12604.10', state: 'expected', sub: 'Jul to Sep; reserve is 163.75 short' },
    ],
  },
  {
    id: 'decisions',
    name: 'Decisions',
    sub: 'placed on the day they block',
    items: [
      { id: 'd-cn', date: '2026-10-24', label: 'Credit note', amount: '660.00', state: 'expected', now: true, sub: 'Wattle & Stone, asked Thu' },
      { id: 'd-pb', date: '2026-10-27', label: 'Release suppliers', amount: '22415.00', state: 'expected', now: true, sub: 'by 5 pm, or the run misses Wed' },
      { id: 'd-mj', date: '2026-10-31', label: 'Wages journal', amount: '14880.00', state: 'expected', now: true, sub: 'then a bill, 3,190.00' },
      { id: 'd-tch', date: '2026-11-03', label: 'Bill TCH-88213', amount: '3190.00', state: 'expected', sub: 'joins the next run' },
    ],
  },
  {
    id: 'books',
    name: 'Books',
    sub: 'close and locks',
    items: [
      { id: 'b-sales', date: '2026-10-03', label: 'Sales locked', state: 'actual', sub: 'Priya' },
      { id: 'b-soft', date: '2026-10-09', label: 'September soft-closed', state: 'actual', sub: '6 of 7 steps' },
      { id: 'b-lock', date: '2026-10-28', label: 'Lock September', state: 'expected', sub: 'after the BAS is lodged' },
    ],
  },
  {
    id: 'salesforce',
    name: 'Salesforce',
    sub: 'updates written',
    items: [
      { id: 's-today', date: '2026-10-24', label: '3 need a person', state: 'expected', now: true, sub: '1,284 written today, 2 retrying' },
    ],
  },
];

export const harbourDecisions: OpenItem[] = [
  { id: 'cn-000118', what: 'Credit note CN-000118, Wattle & Stone Architects', why: "Jordan's partial refund for a cancelled training day. Refunds wait for you.", amount: '660.00', turn: { kind: 'you' }, due: { date: '2026-10-24', note: 'asked Thu 22' } },
  { id: 'pb-0087', what: 'Release supplier run PB-0087, second of two', why: 'Lena made it, Mei released it first. If it waits, 11 suppliers are paid a day late.', amount: '22415.00', turn: { kind: 'you' }, due: { date: '2026-10-27', note: 'by 5 pm' } },
  { id: 'mj-0412', what: 'Journal MJ-0412, October wages owed', why: "Priya's accrual. October's profit is understated until it posts.", amount: '14880.00', turn: { kind: 'person', name: 'Mei' }, due: { date: '2026-10-31', note: 'month end' } },
  { id: 'tch-88213', what: 'Bill TCH-88213, Tasman Cloud Hosting', why: 'Entered by Lena. Approve by then to join the next supplier run.', amount: '3190.00', turn: { kind: 'you' }, due: { date: '2026-11-03', note: 'next run' } },
  { id: 'sf-3', what: 'Salesforce: 3 updates need a person', why: '1,284 updates went through today; 2 more are retrying on their own.', turn: { kind: 'person', name: 'Priya' }, due: { date: '2026-10-24' } },
  { id: 'inv-001061', what: 'INV-001061, Saltbush Health', why: 'Sent and opened. Nothing needs you until the due date passes.', amount: '10087.00', turn: { kind: 'customer', name: 'Saltbush Health' }, due: { date: '2026-11-05', note: 'due' } },
];

export const harbourJournal: { journal: string; lines: JournalLine[] } = {
  journal: 'JNL-004231',
  lines: [
    { code: '1200', account: 'Trade debtors', gloss: 'Saltbush owes you', debit: '10087.00' },
    { code: '4110', account: 'Professional services', gloss: 'earned', credit: '6840.00' },
    { code: '4120', account: 'Support subscriptions', gloss: 'earned', credit: '1450.00' },
    { code: '4130', account: 'Training', gloss: 'earned', credit: '880.00' },
    { code: '2310', account: 'GST collected', gloss: 'held for the ATO, BAS 1A, due 28 Feb', credit: '917.00' },
  ],
};

export const harbourSpine: SpineEvent[] = [
  { id: 'won', date: '2026-10-06', time: '8:47 am', title: 'Won in Salesforce', body: 'Opportunity Health Cloud Sprint 4 moved to Closed Won. A draft was made from its three products.', state: 'past' },
  { id: 'posted', date: '2026-10-06', time: '10:14 am', title: 'Approved and posted by Jordan Lee', body: 'Under the 15,000.00 limit for AR clerks, so no second person was needed.', state: 'past' },
  { id: 'emailed', date: '2026-10-06', time: '10:15 am', title: 'Emailed with a payment link', body: 'To Ruth Adeyemi (Billing To), copy to accounts@saltbush.example.', state: 'past' },
  { id: 'sf-fail', date: '2026-10-06', time: '10:15 am', title: 'Salesforce update', flag: 'Failed', body: 'The opportunity was locked by an approval process (UNABLE_TO_LOCK_ROW). Queued to retry; accounting did not wait.', state: 'warn' },
  { id: 'sf-ok', date: '2026-10-06', time: '10:16 am', title: 'Salesforce updated', body: 'Second try. Status, amount due and account balance written.', state: 'past' },
  { id: 'opened', date: '2026-10-08', time: '2:31 pm', title: 'Opened by Ruth Adeyemi', body: 'Viewed the invoice through the payment link.', state: 'past' },
  { id: 'now', date: '2026-10-24', title: 'Waiting for Saltbush to pay', body: 'Nothing needs you until the due date passes.', state: 'now' },
  { id: 'due', date: '2026-11-05', time: 'due', title: 'Due date', body: 'If unpaid, it shows as overdue in Salesforce the next morning.', state: 'future' },
  { id: 'reminder', date: '2026-11-12', time: 'if unpaid', title: 'Reminder 1, then your turn', body: 'Emailed to Ruth Adeyemi. A follow-up task lands with Jordan.', state: 'future' },
  { id: 'hold', date: '2026-12-05', time: 'if unpaid', title: 'Credit hold', body: '30 days overdue: new invoices for Saltbush stop auto-approving.', state: 'future' },
];
