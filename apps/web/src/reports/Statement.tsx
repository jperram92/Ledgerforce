/**
 * A financial statement table (T-0089): sections (income, expenses; assets, liabilities, equity),
 * each grouped by account kind in plain words, with the totals the API returned. Group subtotals
 * are shown only where they add something (several lines in a section of several groups).
 * Lines link to their general-ledger detail (P1); lines the report works out are marked.
 */
import type { ReactNode } from 'react';
import { Money } from '@ledgerforce/ui';
import type { StatementLine, StatementSection } from './client.ts';
import { csvAmount, csvText, subtypeWord } from './logic.ts';

export interface SectionSpec {
  heading: string;
  totalLabel: string;
  section: StatementSection;
}

const showSubtotal = (s: StatementSection, lines: number) => s.groups.length > 1 && lines > 1;

export function StatementTable({
  label,
  currency,
  sections,
  lineLink,
  footer,
}: {
  label: string;
  currency: string;
  sections: SectionSpec[];
  lineLink: (line: StatementLine, subtype: string) => ReactNode;
  footer: ReactNode;
}) {
  return (
    <table className="report-table statement" aria-label={label}>
      <thead>
        <tr>
          <th scope="col">Account</th>
          <th scope="col" className="num">
            {currency}
          </th>
        </tr>
      </thead>
      {sections.map(({ heading, totalLabel, section }) => (
        <tbody key={heading}>
          <tr className="report-section">
            <th scope="rowgroup" colSpan={2}>
              {heading}
            </th>
          </tr>
          {section.groups.map((g) => (
            <GroupRows
              key={g.subtype}
              group={g}
              subtotal={showSubtotal(section, g.lines.length)}
              lineLink={lineLink}
            />
          ))}
          <tr className="report-total">
            <th scope="row">{totalLabel}</th>
            <td className="num">
              <Money value={section.total} />
            </td>
          </tr>
        </tbody>
      ))}
      <tfoot>{footer}</tfoot>
    </table>
  );
}

function GroupRows({
  group,
  subtotal,
  lineLink,
}: {
  group: StatementSection['groups'][number];
  subtotal: boolean;
  lineLink: (line: StatementLine, subtype: string) => ReactNode;
}) {
  const word = subtypeWord(group.subtype);
  return (
    <>
      <tr className="report-group">
        <th scope="row" colSpan={2}>
          {word}
        </th>
      </tr>
      {group.lines.map((l) => (
        <tr key={l.account_id}>
          <th scope="row" className="report-line">
            {lineLink(l, group.subtype)}
            {l.computed ? (
              <>
                {' '}
                <span className="word" data-status="computed">
                  Worked out
                </span>
              </>
            ) : null}
          </th>
          <td className="num">
            <Money value={l.amount} />
          </td>
        </tr>
      ))}
      {subtotal ? (
        <tr className="report-subtotal">
          <th scope="row">Total {word.charAt(0).toLowerCase() + word.slice(1)}</th>
          <td className="num">
            <Money value={group.total} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** The same rows as CSV: Section, Kind, Code, Account, Amount. */
export function statementCsvRows(sections: SectionSpec[]): string[][] {
  const rows: string[][] = [];
  for (const { heading, totalLabel, section } of sections) {
    for (const g of section.groups) {
      for (const l of g.lines)
        rows.push([
          csvText(heading),
          csvText(subtypeWord(g.subtype)),
          csvText(l.code),
          csvText(l.computed ? `${l.name} (worked out)` : l.name),
          csvAmount(l.amount),
        ]);
    }
    rows.push([csvText(heading), '', '', csvText(totalLabel), csvAmount(section.total)]);
  }
  return rows;
}

export const STATEMENT_CSV_HEADER = ['Section', 'Kind', 'Code', 'Account', 'Amount'];
