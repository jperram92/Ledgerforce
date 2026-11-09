/**
 * Ageing of AR open items (T-0049, RQ-0122 findings 1–2, DL-0360, DL-0361). Pure shaping, no I/O.
 *
 * - Debit items (open amount > 0) are aged by **due date**: days overdue = asOf − due date in
 *   calendar days; buckets current (≤ 0, not yet due), 1–30, 31–60, 61–90, 90+ (> 90).
 * - Credit items (open amount < 0: unallocated receipts / over-payments, unallocated credit notes)
 *   are not aged: they are listed per party and totalled in `unallocatedCredits`.
 * - Per party and in total: total = Σ buckets + unallocatedCredits; overdue = Σ 1–30 … 90+.
 *   A party whose total is negative is `inCredit` (the T-0125 balance-sheet case; presentation on
 *   the balance sheet is T-0125's, the ageing keeps the party).
 * Amounts are NUMERIC text in one currency chosen by the caller (base for the aged report, the
 * transaction currency for a statement); arithmetic is decimal.js through Money.
 */
import { Money } from '@ledgerforce/shared/money';

export const AGEING_BUCKETS = [
  'current',
  'days1to30',
  'days31to60',
  'days61to90',
  'over90',
] as const;
export type AgeingBucket = (typeof AGEING_BUCKETS)[number];

const X = 'XXX';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function epochDay(s: string): number {
  const t = DATE_RE.test(s) ? Date.parse(`${s}T00:00:00Z`) : Number.NaN;
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== s) {
    throw new RangeError(`${JSON.stringify(s)} is not a date (YYYY-MM-DD)`);
  }
  return Math.round(t / DAY_MS);
}

/** Calendar days from `dueDate` to `asOf`; ≤ 0 means not yet overdue. */
export function daysOverdue(dueDate: string, asOf: string): number {
  return epochDay(asOf) - epochDay(dueDate);
}

export function ageingBucketOf(days: number): AgeingBucket {
  if (days <= 0) return 'current';
  if (days <= 30) return 'days1to30';
  if (days <= 60) return 'days31to60';
  if (days <= 90) return 'days61to90';
  return 'over90';
}

export interface AgeingInput {
  itemId: string;
  partyId: string | null;
  partyName: string | null;
  sourceType: string;
  documentId: string | null;
  /** Document number shown to people (invoice no, credit-note no, receipt reference). */
  reference: string | null;
  documentDate: string;
  dueDate: string;
  /** Transaction currency of the item (information; `amount` is in the caller's currency). */
  currency: string;
  /** Signed open amount as at the date (debit +, credit −). */
  amount: string;
}

export interface AgedLine extends AgeingInput {
  daysOverdue: number;
  bucket: AgeingBucket;
}

export interface AgeingTotals {
  current: string;
  days1to30: string;
  days31to60: string;
  days61to90: string;
  over90: string;
  /** Σ open credit items (≤ 0). */
  unallocatedCredits: string;
  /** Σ of the 1–30 … 90+ buckets. */
  overdue: string;
  /** Σ buckets + unallocatedCredits: the net receivable. */
  total: string;
}

export interface AgedParty {
  partyId: string | null;
  partyName: string | null;
  totals: AgeingTotals;
  /** Net credit balance (total < 0). */
  inCredit: boolean;
  /** Open debit items, oldest due date first. */
  items: AgedLine[];
  /** Open credit items, oldest document first. */
  credits: AgeingInput[];
}

export interface Ageing {
  asOf: string;
  parties: AgedParty[];
  totals: AgeingTotals;
}

type Acc = Record<AgeingBucket | 'unallocatedCredits', Money>;

const emptyAcc = (): Acc => ({
  current: Money.zero(X),
  days1to30: Money.zero(X),
  days31to60: Money.zero(X),
  days61to90: Money.zero(X),
  over90: Money.zero(X),
  unallocatedCredits: Money.zero(X),
});

function totalsOf(a: Acc): AgeingTotals {
  const overdue = a.days1to30.add(a.days31to60).add(a.days61to90).add(a.over90);
  const total = a.current.add(overdue).add(a.unallocatedCredits);
  return {
    current: a.current.toNumericString(),
    days1to30: a.days1to30.toNumericString(),
    days31to60: a.days31to60.toNumericString(),
    days61to90: a.days61to90.toNumericString(),
    over90: a.over90.toNumericString(),
    unallocatedCredits: a.unallocatedCredits.toNumericString(),
    overdue: overdue.toNumericString(),
    total: total.toNumericString(),
  };
}

const byText = (a: string | null, b: string | null) => (a ?? '').localeCompare(b ?? '');

/** Age open items as at `asOf`. Items open at zero are ignored; items dated after asOf refused. */
export function ageOpenItems(items: readonly AgeingInput[], asOf: string): Ageing {
  const asOfDay = epochDay(asOf);
  const parties = new Map<
    string,
    {
      partyId: string | null;
      partyName: string | null;
      acc: Acc;
      items: AgedLine[];
      credits: AgeingInput[];
    }
  >();
  const all = emptyAcc();
  for (const it of items) {
    if (epochDay(it.documentDate) > asOfDay) {
      throw new RangeError(`item ${it.itemId} is dated ${it.documentDate}, after ${asOf}`);
    }
    const amount = Money.of(it.amount, X);
    if (amount.isZero()) continue;
    const key = it.partyId ?? '';
    let p = parties.get(key);
    if (!p) {
      p = { partyId: it.partyId, partyName: it.partyName, acc: emptyAcc(), items: [], credits: [] };
      parties.set(key, p);
    }
    const line = { ...it, amount: amount.toNumericString() };
    if (amount.isNegative()) {
      p.credits.push(line);
      p.acc.unallocatedCredits = p.acc.unallocatedCredits.add(amount);
      all.unallocatedCredits = all.unallocatedCredits.add(amount);
    } else {
      const days = asOfDay - epochDay(it.dueDate);
      const bucket = ageingBucketOf(days);
      p.items.push({ ...line, daysOverdue: days, bucket });
      p.acc[bucket] = p.acc[bucket].add(amount);
      all[bucket] = all[bucket].add(amount);
    }
  }
  const out: AgedParty[] = [...parties.values()]
    .map((p) => {
      const totals = totalsOf(p.acc);
      return {
        partyId: p.partyId,
        partyName: p.partyName,
        totals,
        inCredit: Money.of(totals.total, X).isNegative(),
        items: p.items.sort(
          (a, b) =>
            a.dueDate.localeCompare(b.dueDate) ||
            a.documentDate.localeCompare(b.documentDate) ||
            a.itemId.localeCompare(b.itemId),
        ),
        credits: p.credits.sort(
          (a, b) =>
            a.documentDate.localeCompare(b.documentDate) || a.itemId.localeCompare(b.itemId),
        ),
      };
    })
    .sort((a, b) => byText(a.partyName, b.partyName) || byText(a.partyId, b.partyId));
  return { asOf, parties: out, totals: totalsOf(all) };
}
