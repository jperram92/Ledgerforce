import { Money as MoneyValue } from '@ledgerforce/shared/money';
import { Money } from './Money.tsx';

export interface JournalLine {
  code: string;
  /** The accounting term, e.g. "Trade debtors". */
  account: string;
  /** The plain gloss beside it (P12 v1), e.g. "Saltbush owes you". */
  gloss: string;
  debit?: string;
  credit?: string;
}

export interface JournalTableProps {
  journal: string;
  lines: readonly JournalLine[];
  currency?: string;
}

function side(line: JournalLine, code: string): { debit?: MoneyValue; credit?: MoneyValue } {
  const has = (v: string | undefined) => v !== undefined && v !== '';
  if (has(line.debit) === has(line.credit)) {
    throw new Error(`Journal line ${line.code} must have exactly one of debit or credit`);
  }
  const v = MoneyValue.of((has(line.debit) ? line.debit : line.credit) ?? '', code);
  if (v.isNegative()) {
    throw new Error(`Journal line ${line.code}: Dr/Cr amounts are always positive`);
  }
  return has(line.debit) ? { debit: v } : { credit: v };
}

/**
 * Dr/Cr table with a plain gloss beside every account (P12 v1). Debits and credits are always
 * positive, in separate columns (P3). Totals are exact (Money) and the footer says in words
 * whether the journal balances.
 */
export function JournalTable({ journal, lines, currency = 'AUD' }: JournalTableProps) {
  const sides = lines.map((l) => side(l, currency));
  const zero = MoneyValue.zero(currency);
  const dr = sides.reduce((a, s) => (s.debit ? a.add(s.debit) : a), zero);
  const cr = sides.reduce((a, s) => (s.credit ? a.add(s.credit) : a), zero);
  const balanced = dr.equals(cr);
  return (
    <div className="scroll">
      <table className="tbl journal">
        <caption className="sr-only">Journal {journal}</caption>
        <thead>
          <tr>
            <th scope="col">Journal {journal}</th>
            <th scope="col" className="num">
              Debit
            </th>
            <th scope="col" className="num">
              Credit
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => {
            const s = sides[i];
            return (
              <tr key={`${l.code}-${String(i)}`}>
                <td>
                  <span className="code">{l.code}</span>
                  {l.account}
                  <span className="sm">{l.gloss}</span>
                </td>
                <td className="num">{s?.debit ? <Money value={s.debit} /> : null}</td>
                <td className="num">{s?.credit ? <Money value={s.credit} /> : null}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <td>
              {balanced ? (
                'Balanced'
              ) : (
                <>
                  Out of balance by <Money value={dr.sub(cr).abs()} />
                </>
              )}
            </td>
            <td className="num">
              <Money value={dr} />
            </td>
            <td className="num">
              <Money value={cr} />
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
