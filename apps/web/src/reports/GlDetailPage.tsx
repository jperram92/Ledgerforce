/**
 * General-ledger detail (T-0089, design §8.1, SS-RPT-04): for each account, the opening balance,
 * every posted line in date order with the running balance, and the closing balance — all as the
 * API (GET /gl/detail) returned them. Filters: dates, one account, and a customer or supplier
 * (from the aged reports). Balances read debit-positive; credit balances are in brackets.
 */
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { Money } from '@ledgerforce/ui';
import { Empty, PageHead, useAccess } from '../admin/common.tsx';
import { useServices } from '../env.tsx';
import type { GlDetail } from './client.ts';
import { queryState, ReportFilters, ReportScope, useReportGate } from './common.tsx';
import {
  csvAmount,
  csvText,
  dateRange,
  dayWords,
  localToday,
  toCsv,
  type GlDetailSearch,
} from './logic.ts';

export function glDetailCsv(gl: GlDetail): string {
  const rows: string[][] = [
    ['Code', 'Account', 'Date', 'Entry', 'Details', 'Debit', 'Credit', 'Balance'],
  ];
  for (const a of gl.accounts) {
    const acct = [csvText(a.code), csvText(a.name)];
    rows.push([...acct, '', '', 'Opening balance', '', '', csvAmount(a.opening)]);
    for (const l of a.lines)
      rows.push([
        ...acct,
        l.date,
        csvText(l.entry_no ?? ''),
        csvText(details(l.memo, l.party_name)),
        csvAmount(l.debit),
        csvAmount(l.credit),
        csvAmount(l.balance),
      ]);
    rows.push([
      ...acct,
      '',
      '',
      'Closing balance',
      csvAmount(a.total_debit),
      csvAmount(a.total_credit),
      csvAmount(a.closing),
    ]);
  }
  return toCsv(rows);
}

const details = (memo: string | null, party: string | null) =>
  [memo, party].filter((s): s is string => !!s).join(', ');

function AccountPicker({ value }: { value: string }) {
  const id = useId();
  const [chosen, setChosen] = useState(value);
  const { gl } = useServices();
  const access = useAccess();
  const canRead = access.can('gl.account.read');
  const chart = useQuery({
    queryKey: ['gl', 'chart'],
    queryFn: () => gl.chart(),
    enabled: canRead,
  });
  const accounts = [...(chart.data?.accounts ?? [])].sort((a, b) => a.code.localeCompare(b.code));
  return (
    <div className="field">
      <label htmlFor={id}>Account</label>
      <select
        id={id}
        name="account_id"
        value={chosen}
        onChange={(e) => {
          setChosen(e.target.value);
        }}
      >
        <option value="">All accounts</option>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.code} {a.name}
          </option>
        ))}
        {value && !accounts.some((a) => a.id === value) ? (
          <option value={value}>The chosen account</option>
        ) : null}
      </select>
    </div>
  );
}

export function GlDetailPage({ search }: { search: GlDetailSearch }) {
  const { reports } = useServices();
  const navigate = useNavigate();
  const range = dateRange(search, localToday(), true);
  const gate = useReportGate('reports.run', 'general ledger detail');
  const co = gate.company;
  const q = useQuery({
    queryKey: [
      'reports',
      'gl',
      co?.id ?? '',
      range.from,
      range.to,
      search.account_id ?? '',
      search.party_id ?? '',
    ],
    queryFn: () =>
      reports.glDetail(co?.id ?? '', {
        ...range,
        accountId: search.account_id,
        partyId: search.party_id,
      }),
    enabled: !!co,
  });
  const gl = q.data;
  // The account list is loaded by the picker; it is keyed so a new URL resets the form.
  const formKey = `${range.from ?? ''}|${range.to}|${search.account_id ?? ''}`;

  let body = gate.blocked;
  if (!body) {
    const state = queryState(q, 'general ledger detail');
    body = (
      <>
        <ReportFilters
          key={formKey}
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
          extra={<AccountPicker value={search.account_id ?? ''} />}
          onShow={(v) =>
            void navigate({
              to: '/reports/gl-detail',
              search: {
                ...(v['from'] ? { from: v['from'] } : {}),
                to: v['to'] ?? range.to,
                ...(v['account_id'] ? { account_id: v['account_id'] } : {}),
                ...(search.party_id ? { party_id: search.party_id } : {}),
              },
            })
          }
          csv={
            gl && gl.accounts.length > 0
              ? {
                  fileName: `general-ledger-${range.from ?? 'start'}-to-${range.to}.csv`,
                  content: () => glDetailCsv(gl),
                }
              : undefined
          }
        />
        {search.party_id ? (
          <p className="admin-note">
            Showing the lines of one customer or supplier only.{' '}
            <Link
              to="/reports/gl-detail"
              search={{
                ...(range.from ? { from: range.from } : {}),
                to: range.to,
                ...(search.account_id ? { account_id: search.account_id } : {}),
              }}
            >
              Show everyone
            </Link>
          </p>
        ) : null}
        {state ??
          (gl && gl.accounts.length === 0 ? (
            <Empty heading="Nothing posted in these dates">
              No posted journal touches the chosen accounts in these dates.
            </Empty>
          ) : gl ? (
            <div className="admin-block">
              <ReportScope>
                {co?.name}, {gl.from ? dayWords(gl.from) : 'the start of your books'} to{' '}
                {dayWords(gl.to)}. Amounts in {gl.currency}; credit balances in brackets.
              </ReportScope>
              {gl.accounts.map((a) => (
                <section key={a.account_id} className="report-account">
                  <h2>
                    <span className="code">{a.code}</span> {a.name}
                  </h2>
                  <table className="admin-table report-lines" aria-label={`${a.code} ${a.name}`}>
                    <thead>
                      <tr>
                        <th scope="col">Date</th>
                        <th scope="col">Entry</th>
                        <th scope="col">Details</th>
                        <th scope="col" className="num">
                          Debit
                        </th>
                        <th scope="col" className="num">
                          Credit
                        </th>
                        <th scope="col" className="num">
                          Balance
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="report-edge">
                        <td data-label="Date">{gl.from ? dayWords(gl.from) : 'Start'}</td>
                        <td data-label="Entry" colSpan={4}>
                          Opening balance
                        </td>
                        <td data-label="Balance" className="num">
                          <Money value={a.opening} />
                        </td>
                      </tr>
                      {a.lines.map((l) => (
                        <tr key={`${l.entry_id}-${String(l.line_no)}`}>
                          <td data-label="Date">{dayWords(l.date)}</td>
                          <td data-label="Entry">{l.entry_no ?? 'Unnumbered'}</td>
                          <td data-label="Details">{details(l.memo, l.party_name) || '—'}</td>
                          <td data-label="Debit" className="num">
                            <Money value={l.debit} />
                          </td>
                          <td data-label="Credit" className="num">
                            <Money value={l.credit} />
                          </td>
                          <td data-label="Balance" className="num">
                            <Money value={l.balance} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="report-edge">
                        <td data-label="Date">{dayWords(gl.to)}</td>
                        <td data-label="Entry" colSpan={2}>
                          Closing balance
                        </td>
                        <td data-label="Debit" className="num">
                          <Money value={a.total_debit} />
                        </td>
                        <td data-label="Credit" className="num">
                          <Money value={a.total_credit} />
                        </td>
                        <td data-label="Balance" className="num">
                          <Money value={a.closing} />
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </section>
              ))}
            </div>
          ) : null)}
      </>
    );
  }

  return (
    <>
      <PageHead
        title="General ledger detail"
        gloss="Every posted journal line behind an account's balance, with the running balance after each line."
      />
      {body}
    </>
  );
}
