/**
 * Balance sheet (T-0089, design §8.1, §3.5, SS-RPT-03): assets, liabilities and equity at a date,
 * with the retained and current-year earnings lines the report works out, and the "balanced" flag
 * — all as the API returned them. Posted lines open their general-ledger detail for the financial
 * year to the date; current-year earnings opens the profit and loss for the same dates (P1).
 */
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Money } from '@ledgerforce/ui';
import { PageHead } from '../admin/common.tsx';
import { useServices } from '../env.tsx';
import type { BalanceSheet, StatementLine } from './client.ts';
import { queryState, ReportFilters, ReportScope, useReportGate } from './common.tsx';
import { csvAmount, dayWords, localToday, toCsv } from './logic.ts';
import {
  STATEMENT_CSV_HEADER,
  statementCsvRows,
  StatementTable,
  type SectionSpec,
} from './Statement.tsx';

const sectionsOf = (bs: BalanceSheet): SectionSpec[] => [
  { heading: 'Assets', totalLabel: 'Total assets', section: bs.assets },
  { heading: 'Liabilities', totalLabel: 'Total liabilities', section: bs.liabilities },
  { heading: 'Equity', totalLabel: 'Total equity', section: bs.equity },
];

export function balanceSheetCsv(bs: BalanceSheet): string {
  return toCsv([
    STATEMENT_CSV_HEADER,
    ...statementCsvRows(sectionsOf(bs)),
    ['', '', '', 'Total liabilities and equity', csvAmount(bs.total_liabilities_and_equity)],
  ]);
}

function LineLink({
  bs,
  line,
  subtype,
}: {
  bs: BalanceSheet;
  line: StatementLine;
  subtype: string;
}) {
  const name = (
    <>
      <span className="code">{line.code}</span> {line.name}
    </>
  );
  if (!line.computed)
    return (
      <Link
        to="/reports/gl-detail"
        search={{ from: bs.fiscal_year.start, to: bs.as_at, account_id: line.account_id }}
      >
        {name}
      </Link>
    );
  // Current-year earnings is this year's profit: the P&L from the year start shows where it
  // comes from. Retained earnings spans every earlier year, so it is described, not linked.
  return subtype === 'current_year_earnings' ? (
    <Link to="/reports/profit-and-loss" search={{ from: bs.fiscal_year.start, to: bs.as_at }}>
      {name}
    </Link>
  ) : (
    <span>{name}</span>
  );
}

export function BalanceSheetPage({ search }: { search: { as_at?: string } }) {
  const { reports } = useServices();
  const navigate = useNavigate();
  const asAt = search.as_at ?? localToday();
  const gate = useReportGate('reports.run', 'the balance sheet');
  const co = gate.company;
  const q = useQuery({
    queryKey: ['reports', 'bs', co?.id ?? '', asAt],
    queryFn: () => reports.balanceSheet(co?.id ?? '', asAt),
    enabled: !!co,
  });
  const bs = q.data;

  let body = gate.blocked;
  if (!body) {
    const state = queryState(q, 'the balance sheet');
    body = (
      <>
        <ReportFilters
          key={asAt}
          fields={[{ name: 'as_at', label: 'As at', value: asAt }]}
          onShow={(v) =>
            void navigate({ to: '/reports/balance-sheet', search: { as_at: v['as_at'] ?? asAt } })
          }
          csv={
            bs
              ? { fileName: `balance-sheet-${asAt}.csv`, content: () => balanceSheetCsv(bs) }
              : undefined
          }
        />
        {state ??
          (bs ? (
            <div className="admin-block">
              <ReportScope>
                {co?.name}, as at {dayWords(bs.as_at)}, in financial year {bs.fiscal_year.label} (
                {dayWords(bs.fiscal_year.start)} to {dayWords(bs.fiscal_year.end)}). Amounts in{' '}
                {bs.currency}.
              </ReportScope>
              <StatementTable
                label="Balance sheet"
                currency={bs.currency}
                sections={sectionsOf(bs)}
                lineLink={(l, subtype) => <LineLink bs={bs} line={l} subtype={subtype} />}
                footer={
                  <tr>
                    <th scope="row">Total liabilities and equity</th>
                    <td className="num">
                      <Money value={bs.total_liabilities_and_equity} />
                    </td>
                  </tr>
                }
              />
              <p className="report-check">
                <span className="word" data-status={bs.balanced ? 'balanced' : 'unbalanced'}>
                  {bs.balanced
                    ? 'Balanced: assets equal liabilities plus equity'
                    : 'Not balanced: assets differ from liabilities plus equity'}
                </span>
              </p>
              <p className="admin-note">
                Lines marked &ldquo;Worked out&rdquo; are not posted: retained earnings adds the
                profit of earlier years, and current year earnings is this year&rsquo;s profit to
                date.
              </p>
            </div>
          ) : null)}
      </>
    );
  }

  return (
    <>
      <PageHead
        title="Balance sheet"
        gloss="What the business owns, owes and is worth on one day, from posted journals."
      />
      {body}
    </>
  );
}
