/**
 * Chart of accounts (SS-PLAT-93, design §3.2, IA "Accounting → Chart of accounts"): every account
 * of the company in code order, grouped by type with a plain gloss (P12 v1); control accounts,
 * system roles and accounts that cannot be posted to are said in words (P2). Read-only here;
 * changing the chart is a setup task (settings.chart.manage).
 */
import { useQuery } from '@tanstack/react-query';
import { useServices } from '../env.tsx';
import {
  Empty,
  Failure,
  Forbidden,
  Loading,
  PageHead,
  useAccess,
  useFailureRouting,
} from '../admin/common.tsx';
import { TYPE_HEADING, TYPE_ORDER, typeGloss } from './gl-logic.ts';
import type { ChartAccount } from './client.ts';
import { GL_READERS } from './messages.ts';

export const CHART_KEY = ['gl', 'chart'] as const;

const TITLE = 'Chart of accounts';
const GLOSS =
  'The accounts your books are kept in, by number. Each journal line goes to one of them.';

/** The chart, for any GL screen (gl.account.read). */
export function useChart(enabled: boolean) {
  const { gl } = useServices();
  const q = useQuery({ queryKey: CHART_KEY, queryFn: () => gl.chart(), enabled });
  useFailureRouting(q.error);
  return q;
}

export function accountLabel(a: Pick<ChartAccount, 'code' | 'name'>): string {
  return `${a.code} ${a.name}`;
}

function notes(a: ChartAccount): string {
  const out: string[] = [];
  if (a.is_control) out.push('Control account: only its ledger posts here');
  if (!a.postable) out.push('Not postable: it adds up other accounts');
  if (a.status === 'archived') out.push('Archived');
  if (a.currency) out.push(`Only ${a.currency}`);
  out.push(...a.system_roles);
  return out.length ? out.join('; ') : '—';
}

export function ChartPage() {
  const access = useAccess();
  const canRead = access.can('gl.account.read');
  const chart = useChart(canRead);

  let body;
  if (access.isPending) body = <Loading what="your access" />;
  else if (access.isError)
    body = (
      <Failure
        heading="We could not check what you may do"
        error={access.error}
        onRetry={() => void access.refetch()}
      />
    );
  else if (!canRead)
    body = (
      <Forbidden heading="You can't see the chart of accounts">
        {GL_READERS} can see the chart of accounts. Ask your Owner if you need to.
      </Forbidden>
    );
  else if (chart.isPending) body = <Loading what="the chart of accounts" />;
  else if (chart.isError)
    body = (
      <Failure
        heading="We could not load the chart of accounts"
        error={chart.error}
        onRetry={() => void chart.refetch()}
      />
    );
  else if (chart.data.accounts.length === 0)
    body = (
      <Empty heading="No chart of accounts yet">
        The chart is chosen in step 2 of setup, from a template you can change. Journals can be
        written once it is in place.
      </Empty>
    );
  else
    body = (
      <>
        {chart.data.companies.map((c) => (
          <p key={c.id} className="admin-note">
            {c.name}, amounts in {c.base_currency}
          </p>
        ))}
        {TYPE_ORDER.map((type) => {
          const rows = chart.data.accounts.filter((a) => a.type === type);
          if (rows.length === 0) return null;
          const id = `chart-${type}`;
          return (
            <section key={type} className="admin-block" aria-labelledby={id}>
              <h2 id={id}>
                {TYPE_HEADING[type]} — {typeGloss(type)}
              </h2>
              <table className="admin-table" aria-labelledby={`${id}-t`}>
                <caption id={`${id}-t`} className="sr-only">
                  {TYPE_HEADING[type]}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Code</th>
                    <th scope="col">Name</th>
                    <th scope="col">Kind</th>
                    <th scope="col">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((a) => (
                    <tr key={a.id}>
                      <td data-label="Code" className="code">
                        {a.code}
                      </td>
                      <td data-label="Name">{a.name}</td>
                      <td data-label="Kind">{a.subtype.replaceAll('_', ' ')}</td>
                      <td data-label="Notes">{notes(a)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          );
        })}
      </>
    );

  return (
    <>
      <PageHead title={TITLE} gloss={GLOSS} />
      {body}
    </>
  );
}
