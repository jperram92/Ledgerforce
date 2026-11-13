/**
 * Aged receivables and aged payables (T-0089, design §8.1, SS-RPT-05/06): what each customer owes
 * you, or you owe each supplier, at a date, by how long it is past due — rows and totals as the
 * API returned them. Each name opens that party's general-ledger lines to the date (P1).
 */
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Money } from '@ledgerforce/ui';
import { Empty, PageHead } from '../admin/common.tsx';
import { useServices } from '../env.tsx';
import { AGE_BUCKETS, type Aged, type AgeBucket } from './client.ts';
import { queryState, ReportFilters, ReportScope, useReportGate } from './common.tsx';
import { csvAmount, csvText, dayWords, localToday, toCsv } from './logic.ts';

const BUCKET_WORDS: Record<AgeBucket, string> = {
  current: 'Not yet due',
  days1to30: '1–30 days late',
  days31to60: '31–60 days late',
  days61to90: '61–90 days late',
  days90plus: 'Over 90 days late',
};

interface Kind {
  title: string;
  gloss: string;
  path: '/reports/aged-receivables' | '/reports/aged-payables';
  permission: string;
  what: string;
  party: string;
  file: string;
  empty: string;
}

const KINDS = {
  receivables: {
    title: 'Aged receivables',
    gloss:
      'What each customer owes you on a date, by how late it is (accounts receivable ageing). Credits you hold for a customer reduce what they owe.',
    path: '/reports/aged-receivables',
    permission: 'ar.read',
    what: 'aged receivables',
    party: 'Customer',
    file: 'aged-receivables',
    empty: 'No customer owes you anything on this date.',
  },
  payables: {
    title: 'Aged payables',
    gloss:
      'What you owe each supplier on a date, by how late it is (accounts payable ageing). Payments made ahead reduce what you owe.',
    path: '/reports/aged-payables',
    permission: 'ap.read',
    what: 'aged payables',
    party: 'Supplier',
    file: 'aged-payables',
    empty: 'You owe no supplier anything on this date.',
  },
} as const satisfies Record<string, Kind>;

export function agedCsv(kind: Kind, aged: Aged): string {
  return toCsv([
    [kind.party, ...AGE_BUCKETS.map((b) => BUCKET_WORDS[b]), 'Total'],
    ...aged.rows.map((r) => [
      csvText(r.partyName),
      ...AGE_BUCKETS.map((b) => csvAmount(r[b])),
      csvAmount(r.total),
    ]),
    ['Total', ...AGE_BUCKETS.map((b) => csvAmount(aged.totals[b])), csvAmount(aged.totals.total)],
  ]);
}

export function AgedPage({
  kind: which,
  search,
}: {
  kind: keyof typeof KINDS;
  search: { as_of?: string };
}) {
  const kind: Kind = KINDS[which];
  const { reports } = useServices();
  const navigate = useNavigate();
  const asOf = search.as_of ?? localToday();
  const gate = useReportGate(kind.permission, kind.what);
  const co = gate.company;
  const q = useQuery({
    queryKey: ['reports', kind.file, co?.id ?? '', asOf],
    queryFn: () =>
      which === 'receivables'
        ? reports.agedReceivables(co?.id ?? '', asOf)
        : reports.agedPayables(co?.id ?? '', asOf),
    enabled: !!co,
  });
  const aged = q.data;

  let body = gate.blocked;
  if (!body) {
    const state = queryState(q, kind.what);
    body = (
      <>
        <ReportFilters
          key={asOf}
          fields={[{ name: 'as_of', label: 'As at', value: asOf }]}
          onShow={(v) => void navigate({ to: kind.path, search: { as_of: v['as_of'] ?? asOf } })}
          csv={
            aged && aged.rows.length > 0
              ? { fileName: `${kind.file}-${asOf}.csv`, content: () => agedCsv(kind, aged) }
              : undefined
          }
        />
        {state ??
          (aged && aged.rows.length === 0 ? (
            <Empty heading="Nothing outstanding">{kind.empty}</Empty>
          ) : aged ? (
            <div className="admin-block">
              <ReportScope>
                {co?.name}, as at {dayWords(aged.asOf)}. Amounts in {co?.base_currency}; credits in
                brackets.
              </ReportScope>
              <table className="admin-table report-aged" aria-label={kind.title}>
                <thead>
                  <tr>
                    <th scope="col">{kind.party}</th>
                    {AGE_BUCKETS.map((b) => (
                      <th scope="col" className="num" key={b}>
                        {BUCKET_WORDS[b]}
                      </th>
                    ))}
                    <th scope="col" className="num">
                      Total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {aged.rows.map((r) => (
                    <tr key={r.partyId}>
                      <th scope="row" data-label={kind.party}>
                        <Link
                          to="/reports/gl-detail"
                          search={{ to: aged.asOf, party_id: r.partyId }}
                        >
                          {r.partyName}
                        </Link>
                      </th>
                      {AGE_BUCKETS.map((b) => (
                        <td data-label={BUCKET_WORDS[b]} className="num" key={b}>
                          <Money value={r[b]} />
                        </td>
                      ))}
                      <td data-label="Total" className="num">
                        <Money value={r.total} />
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row" data-label={kind.party}>
                      Total
                    </th>
                    {AGE_BUCKETS.map((b) => (
                      <td data-label={BUCKET_WORDS[b]} className="num" key={b}>
                        <Money value={aged.totals[b]} />
                      </td>
                    ))}
                    <td data-label="Total" className="num">
                      <Money value={aged.totals.total} />
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          ) : null)}
      </>
    );
  }

  return (
    <>
      <PageHead title={kind.title} gloss={kind.gloss} />
      {body}
    </>
  );
}
