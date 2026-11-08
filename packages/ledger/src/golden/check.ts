/**
 * Golden arithmetic self-check (T-0031; postings.md "every table ends with a Total row; the
 * self-check verifies Σdebit = Σcredit for every journal"). Exact decimal via Money.
 */
import { Money } from '@ledgerforce/shared/money';
import type { GoldenPosting } from './parse.ts';

const CUR = 'XXX';
const m = (s: string | null) => Money.of(s ?? '0', CUR);

/** Problems found, as sentences; empty when every journal is consistent. */
export function goldenArithmetic(gp: GoldenPosting): string[] {
  const out: string[] = [];
  for (const j of gp.journals) {
    const at = j.label === null ? gp.id : `${gp.id} (${j.label})`;
    if (!m(j.total.debit).equals(m(j.total.credit))) {
      out.push(
        `${at}: Total row does not balance (debit ${j.total.debit}, credit ${j.total.credit})`,
      );
    }
    let debit = Money.zero(CUR);
    let credit = Money.zero(CUR);
    for (const l of j.lines) {
      debit = debit.add(m(l.debit));
      credit = credit.add(m(l.credit));
    }
    if (!debit.equals(m(j.total.debit))) {
      out.push(
        `${at}: lines sum to debit ${debit.toNumericString()} but the Total row says ${j.total.debit}`,
      );
    }
    if (!credit.equals(m(j.total.credit))) {
      out.push(
        `${at}: lines sum to credit ${credit.toNumericString()} but the Total row says ${j.total.credit}`,
      );
    }
  }
  return out;
}
