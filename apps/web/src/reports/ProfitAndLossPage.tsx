/**
 * Profit and loss (T-0089, design §8.1, SS-RPT-02): income then expenses for the dates, grouped
 * by account kind, and the net profit — all as the API returned them. Each line opens its
 * general-ledger detail for the same dates (P1).
 */
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { formatMoney, Money } from '@ledgerforce/ui';
import { PageHead } from '../admin/common.tsx';
import { useServices } from '../env.tsx';
import type { ProfitAndLoss } from './client.ts';
import { queryState, ReportFilters, ReportScope, useReportGate } from './common.tsx';
import { csvAmount, dateRange, dayWords, localToday, toCsv, type RangeSearch } from './logic.ts';
import {
  STATEMENT_CSV_HEADER,
  statementCsvRows,
  StatementTable,
  type SectionSpec,
} from './Statement.tsx';

const sectionsOf = (pl: ProfitAndLoss): SectionSpec[] => [
  { heading: 'Income', totalLabel: 'Total income', section: pl.revenue },
  { heading: 'Expenses', totalLabel: 'Total expenses', section: pl.expenses },
];

const netLabel = (pl: ProfitAndLoss) =>
  formatMoney(pl.net_profit).negative ? 'Net loss' : 'Net profit';

export function profitAndLossCsv(pl: ProfitAndLoss): string {
  return toCsv([
    STATEMENT_CSV_HEADER,
    ...statementCsvRows(sectionsOf(pl)),
    ['', '', '', netLabel(pl), csvAmount(pl.net_profit)],
  ]);
}

export function ProfitAndLossPage({ search }: { search: RangeSearch }) {
  const { reports } = useServices();
  const navigate = useNavigate();
  const range = dateRange(search, localToday(), false);
  const from = range.from ?? range.to;
  const gate = useReportGate('reports.run', 'the profit and loss');
  const co = gate.company;
  const q = useQuery({
    queryKey: ['reports', 'pl', co?.id ?? '', from, range.to],
    queryFn: () => reports.profitAndLoss(co?.id ?? '', { from, to: range.to }),
    enabled: !!co,
  });
  const pl = q.data;

  let body = gate.blocked;
  if (!body) {
    const state = queryState(q, 'the profit and loss');
    body = (
      <>
        <ReportFilters
          key={`${from}|${range.to}`}
          fields={[
            { name: 'from', label: 'From', value: from },
            { name: 'to', label: 'To', value: range.to },
          ]}
          onShow={(v) =>
            void navigate({
              to: '/reports/profit-and-loss',
              search: { from: v['from'] ?? from, to: v['to'] ?? range.to },
            })
          }
          csv={
            pl
              ? {
                  fileName: `profit-and-loss-${from}-to-${range.to}.csv`,
                  content: () => profitAndLossCsv(pl),
                }
              : undefined
          }
        />
        {state ??
          (pl ? (
            <div className="admin-block">
              <ReportScope>
                {co?.name}, {dayWords(pl.from)} to {dayWords(pl.to)}. Amounts in {pl.currency};
                losses in brackets.
              </ReportScope>
              <StatementTable
                label="Profit and loss"
                currency={pl.currency}
                sections={sectionsOf(pl)}
                lineLink={(l) => (
                  <Link
                    to="/reports/gl-detail"
                    search={{ from: pl.from, to: pl.to, account_id: l.account_id }}
                  >
                    <span className="code">{l.code}</span> {l.name}
                  </Link>
                )}
                footer={
                  <tr>
                    <th scope="row">{netLabel(pl)}</th>
                    <td className="num">
                      <Money value={pl.net_profit} />
                    </td>
                  </tr>
                }
              />
            </div>
          ) : null)}
      </>
    );
  }

  return (
    <>
      <PageHead
        title="Profit and loss"
        gloss="What you earned and spent in the dates you choose, from posted journals (income statement)."
      />
      {body}
    </>
  );
}
