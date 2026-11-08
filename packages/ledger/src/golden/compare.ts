/**
 * Line-for-line comparison of a golden journal with the journal the engine produced (T-0031).
 *
 * Both sides are LineViews: identities (account, tax code, party) compare by id, amounts by their
 * canonical NUMERIC(19,4) text; labels exist only to make a difference readable.
 */

export interface LineView {
  lineNo: number;
  accountId: string;
  /** Golden side: the binding and the account it resolved to; engine side: code and name. */
  accountLabel: string;
  /** NUMERIC(19,4) text; "0.0000" for the other side. */
  debit: string;
  credit: string;
  taxCodeId: string | null;
  taxLabel: string | null;
  /** Signed NUMERIC(19,4) text, or null. */
  taxAmount: string | null;
  partyId: string | null;
  partyLabel: string | null;
}

const ZERO = '0.0000';
const dash = (s: string | null) => s ?? '—';
const side = (l: LineView) => (l.debit !== ZERO ? `Dr ${l.debit}` : `Cr ${l.credit}`);

/** Every difference as a sentence; empty when the journals are equal line for line. */
export function diffJournal(expected: readonly LineView[], actual: readonly LineView[]): string[] {
  const out: string[] = [];
  const n = Math.max(expected.length, actual.length);
  for (let i = 0; i < n; i++) {
    const e = expected[i];
    const a = actual[i];
    if (e && !a) {
      out.push(
        `line ${String(e.lineNo)} missing from the engine journal (${e.accountLabel} ${side(e)})`,
      );
      continue;
    }
    if (a && !e) {
      out.push(
        `line ${String(a.lineNo)} unexpected in the engine journal (${a.accountLabel} ${side(a)})`,
      );
      continue;
    }
    if (!e || !a) continue;
    const at = `line ${String(e.lineNo)}`;
    const field = (name: string, same: boolean, exp: string, act: string) => {
      if (!same) out.push(`${at} ${name}: expected ${exp}, engine ${act}`);
    };
    field('line number', e.lineNo === a.lineNo, String(e.lineNo), String(a.lineNo));
    field('account', e.accountId === a.accountId, e.accountLabel, a.accountLabel);
    field('debit', e.debit === a.debit, e.debit, a.debit);
    field('credit', e.credit === a.credit, e.credit, a.credit);
    field('tax code', e.taxCodeId === a.taxCodeId, dash(e.taxLabel), dash(a.taxLabel));
    field('tax amount', e.taxAmount === a.taxAmount, dash(e.taxAmount), dash(a.taxAmount));
    field('party', e.partyId === a.partyId, dash(e.partyLabel), dash(a.partyLabel));
  }
  return out;
}

const blank = (amount: string) => (amount === ZERO ? '' : amount);

function table(lines: readonly LineView[]): string[] {
  return lines.map((l) =>
    [
      String(l.lineNo),
      l.accountLabel,
      blank(l.debit),
      blank(l.credit),
      l.taxLabel === null
        ? '—'
        : `${l.taxLabel}${l.taxAmount === null ? '' : ` (tax ${l.taxAmount})`}`,
      dash(l.partyLabel),
    ].join(' | '),
  );
}

/** The differences, then both journals as "# | account | debit | credit | tax | party" rows. */
export function formatJournalDiff(
  title: string,
  expected: readonly LineView[],
  actual: readonly LineView[],
  diffs: readonly string[] = diffJournal(expected, actual),
): string {
  return [
    `${title} — ${String(diffs.length)} difference(s)`,
    ...diffs.map((d) => `  ✗ ${d}`),
    '  expected (golden): # | account | debit | credit | tax | party',
    ...table(expected).map((r) => `    ${r}`),
    '  engine:            # | account | debit | credit | tax | party',
    ...table(actual).map((r) => `    ${r}`),
  ].join('\n');
}
