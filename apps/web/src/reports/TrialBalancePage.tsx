/**
 * Trial balance (T-0089, design §8.1, SS-RPT-01): every account with posted activity in the dates,
 * its net balance on the debit or credit side, and the totals and "debits equal credits" flag as
 * the API returns them. Each account opens its general-ledger detail for the same dates (P1).
 */
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Money } from '@ledgerforce/ui';
import { Empty, PageHead } from '../admin/common.tsx';
import { useServices } from '../env.tsx';
import type { TrialBalance } from './client.ts';
import { queryState, ReportFilters, ReportScope, useReportGate } from './common.tsx';
import {
  csvAmount,
  csvText,
  dateRange,
  dayWords,
  localToday,
  toCsv,
  type RangeSearch,
} from './logic.ts';

export function trialBalanceCsv(tb: TrialBalance): string {
  return toCsv([
    ['Code', 'Account', 'Debit', 'Credit'],
    ...tb.rows.map((r) => [
      csvText(r.code),
      csvText(r.name),
      csvAmount(r.debit),
      csvAmount(r.credit),
    ]),
    ['', 'Total', csvAmount(tb.total_debit), csvAmount(tb.total_credit)],
  ]);
}

export function TrialBalancePage({ search }: { search: RangeSearch }) {
  const { reports } = useServices();
  const navigate = useNavigate();
  const range = dateRange(search, localToday(), true);
  const gate = useReportGate('reports.run', 'the trial balance');
  const co = gate.company;
  const q = useQuery({
    queryKey: ['reports', 'tb', co?.id ?? '', range.from, range.to],
    queryFn: () => reports.trialBalance(co?.id ?? '', range),
    enabled: !!co,
  });
  const tb = q.data;
  const scopeFrom = range.from ? dayWords(range.from) : 'the start of your books';

  let body = gate.blocked;
  if (!body) {
    const state = queryState(q, 'the trial balance');
    body = (
      <>
        <ReportFilters
          key={`${range.from ?? ''}|${range.to}`}
          fields={[
            {
              name: 'from',
              label: 'From',
              value: range.from ?? '',
              required: false,
              hint: 'Leave empty to start at the beginning of your books.',
            },
            { name: 'to', label: 'To', value: range.to },
          ]}
          onShow={(v) =>
            void navigate({
              to: '/reports/trial-balance',
              search: { ...(v['from'] ? { from: v['from'] } : {}), to: v['to'] ?? range.to },
            })
          }
          csv={
            tb && tb.rows.length > 0
              ? {
                  fileName: `trial-balance-${range.from ?? 'start'}-to-${range.to}.csv`,
                  content: () => trialBalanceCsv(tb),
                }
              : undefined
          }
        />
        {state ??
          (tb && tb.rows.length === 0 ? (
            <Empty heading="Nothing posted in these dates">
              The trial balance lists accounts with posted journals. Choose other dates, or post
              invoices, bills or journals first.
            </Empty>
          ) : tb ? (
            <div className="admin-block">
              <ReportScope>
                {co?.name}, {scopeFrom} to {dayWords(tb.to)}. Amounts in {tb.currency}.
              </ReportScope>
              <table className="report-table" aria-label="Trial balance">
                <thead>
                  <tr>
                    <th scope="col">Account</th>
                    <th scope="col" className="num">
                      Debit
                    </th>
                    <th scope="col" className="num">
                      Credit
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {tb.rows.map((r) => (
                    <tr key={r.account_id}>
                      <th scope="row">
                        <Link
                          to="/reports/gl-detail"
                          search={{
                            ...(range.from ? { from: range.from } : {}),
                            to: range.to,
                            account_id: r.account_id,
                          }}
                        >
                          <span className="code">{r.code}</span> {r.name}
                        </Link>
                      </th>
                      <td className="num">
                        <Money value={r.debit} />
                      </td>
                      <td className="num">
                        <Money value={r.credit} />
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row">Total</th>
                    <td className="num">
                      <Money value={tb.total_debit} />
                    </td>
                    <td className="num">
                      <Money value={tb.total_credit} />
                    </td>
                  </tr>
                </tfoot>
              </table>
              <p className="report-check">
                <span className="word" data-status={tb.nets_to_zero ? 'balanced' : 'unbalanced'}>
                  {tb.nets_to_zero ? 'Debits equal credits' : 'Debits and credits differ'}
                </span>
              </p>
            </div>
          ) : null)}
      </>
    );
  }

  return (
    <>
      <PageHead
        title="Trial balance"
        gloss="Every account's balance from posted journals, on its debit or credit side. Choose an account to see the journals behind it."
      />
      {body}
    </>
  );
}
