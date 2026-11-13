/**
 * Reconciliation report (T-0088, UC-08 step 5 and A2, SS-UC08-08). For one statement: the
 * statement's closing balance, the lines not yet matched, the book entries the bank has not
 * cleared, the adjusted balance, the book balance and the difference. Every figure comes from the
 * API (T-0149, the bank module); the screen formats decimal strings only. A statement that ties
 * can be completed, after which its lines can no longer be unmatched.
 */
import { Money } from '@ledgerforce/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { Empty, Failure, Loading, PageHead, useFailureRouting } from '../admin/common.tsx';
import { useServices } from '../env.tsx';
import { accountLabel, closingBalanceText, LINE_STATUS_WORD, newKey } from './bank-logic.ts';
import { BankForbidden, BankRefusal, dateText, Region, useBankContext } from './common.tsx';
import type { Report } from './client.ts';

const TITLE = 'Reconciliation report';
const GLOSS =
  'Does the bank statement agree with your books? What is left to explain, line by line.';

function Figures({ r }: { r: Report }) {
  const rows: [string, string][] = [
    ['Closing balance on the statement', r.statement_closing_balance],
    ['Less statement lines not matched yet', r.unreconciled_lines_total],
    ['Plus book entries the bank has not cleared yet', r.unreconciled_book_total],
    ['Adjusted statement balance', r.adjusted_statement_balance],
    ['Balance in the books', r.book_balance],
    ['Difference', r.difference],
  ];
  return (
    <table className="report-table" aria-label="Reconciliation">
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label}>
            <th scope="row">{label}</th>
            <td className="num">
              <Money value={value} currency={r.currency} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ReportPage({
  accountId,
  statementId,
  closing,
}: {
  accountId?: string;
  statementId?: string;
  closing?: string;
}) {
  const ctx = useBankContext(accountId, statementId);
  const { bank } = useServices();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canReconcile = ctx.access.can('bank.reconcile');
  const account = ctx.account;
  const statement = ctx.statement;
  const closingBalance = closing ?? statement?.closing_balance ?? undefined;
  const reportKey = ['bank', 'report', ctx.companyId, statement?.id ?? '', closingBalance ?? ''];
  const report = useQuery({
    queryKey: reportKey,
    queryFn: () => bank.report(ctx.companyId, statement?.id ?? '', closing),
    enabled: ctx.canRead && !!statement && closingBalance !== undefined,
  });
  useFailureRouting(report.error);
  const [typed, setTyped] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [key, setKey] = useState(() => newKey('reconcile'));
  const complete = useMutation({
    mutationFn: () => bank.complete(ctx.companyId, statement?.id ?? '', closing, key),
    onSuccess: async (r) => {
      setKey(newKey('reconcile'));
      queryClient.setQueryData(reportKey, r.report);
      await queryClient.invalidateQueries({ queryKey: ['bank', 'statements'] });
    },
    onError: () => setKey(newKey('reconcile')),
  });

  if (ctx.isPending || (closingBalance !== undefined && !!statement && report.isPending))
    return <Loading what="the reconciliation report" />;
  if (!ctx.access.isPending && !ctx.access.isError && !ctx.canRead)
    return <BankForbidden title={TITLE} gloss={GLOSS} />;
  if (ctx.error)
    return (
      <Failure
        heading="We could not load the reconciliation report"
        error={ctx.error}
        onRetry={ctx.refetch}
      />
    );
  if (!account || !statement)
    return (
      <>
        <PageHead title={TITLE} gloss={GLOSS} />
        <Empty heading="No statement to reconcile">
          Import a statement first. <Link to="/bank/statements">Go to bank statements</Link>
        </Empty>
      </>
    );

  const search = { account: account.id, statement: statement.id };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = closingBalanceText(typed ?? closingBalance ?? '');
    setInvalid(value === null);
    if (value !== null)
      void navigate({ to: '/bank/reconciliation', search: { ...search, closing: value } });
  };
  const r = report.data;
  return (
    <>
      <PageHead
        title={TITLE}
        gloss={`${accountLabel(account)}. Statement ${statement.file_name ?? ''}${
          r ? `, as at ${dateText(r.as_of)}` : ''
        }.`}
      />
      <p className="admin-back">
        <Link to="/bank/match" search={search}>
          Back to the statement lines
        </Link>
      </p>
      <div className="admin-filters">
        <form className="field wide bank-closing" onSubmit={submit} noValidate>
          <label htmlFor="closing-balance">Closing balance on the statement</label>
          <input
            id="closing-balance"
            inputMode="decimal"
            value={typed ?? closingBalance ?? ''}
            aria-describedby="closing-balance-hint"
            aria-invalid={invalid}
            onChange={(e) => setTyped(e.target.value)}
          />
          <p className="admin-note" id="closing-balance-hint">
            {statement.closing_balance === null
              ? 'This file carries no closing balance: type the one your bank shows.'
              : 'Taken from the statement file; change it if your bank shows another.'}
          </p>
          <button type="submit" className="secondary">
            Show report
          </button>
          {invalid ? (
            <p className="refusal" role="alert">
              Type an amount such as 13,394.43, with up to 4 decimals.
            </p>
          ) : null}
        </form>
      </div>

      {report.isError ? (
        <Region heading="The report">
          <BankRefusal error={report.error} what="build the report" />
        </Region>
      ) : !r ? (
        <Region heading="The report">
          <p className="admin-note">Give the closing balance to see the report.</p>
        </Region>
      ) : (
        <>
          <Region heading="The figures">
            <Figures r={r} />
            <p className="report-check">
              <span className="word" data-status={r.balanced ? 'balanced' : 'unbalanced'}>
                {r.balanced ? 'Ties' : 'Does not tie'}
              </span>{' '}
              {r.balanced ? (
                'The statement ties to the books.'
              ) : (
                <>
                  The statement does not tie to the books: the difference is{' '}
                  <Money value={r.difference} currency={r.currency} />.
                </>
              )}
            </p>
          </Region>

          <Region heading="Statement lines not matched yet">
            {r.unreconciled_lines.length === 0 ? (
              <p className="admin-note">Every statement line up to this date is matched.</p>
            ) : (
              <table className="admin-table" aria-label="Unreconciled statement lines">
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Description</th>
                    <th scope="col">State</th>
                    <th scope="col" className="num">
                      Amount
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {r.unreconciled_lines.map((l) => (
                    <tr key={l.id}>
                      <td data-label="Date">{dateText(l.posted_on)}</td>
                      <td data-label="Description">{l.description || 'No description'}</td>
                      <td data-label="State">
                        {LINE_STATUS_WORD[l.status as keyof typeof LINE_STATUS_WORD] ?? l.status}
                      </td>
                      <td data-label="Amount" className="num">
                        <Money value={l.amount} currency={r.currency} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Region>

          <Region heading="Book entries the bank has not cleared">
            {r.unreconciled_book_items.length === 0 ? (
              <p className="admin-note">Nothing outstanding in the books.</p>
            ) : (
              <table className="admin-table" aria-label="Outstanding book entries">
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Entry</th>
                    <th scope="col">Memo</th>
                    <th scope="col" className="num">
                      Amount
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {r.unreconciled_book_items.map((b) => (
                    <tr key={b.entry_id}>
                      <td data-label="Date">{dateText(b.entry_date)}</td>
                      <td data-label="Entry">{b.entry_no ?? 'Posted entry'}</td>
                      <td data-label="Memo">{b.memo ?? ''}</td>
                      <td data-label="Amount" className="num">
                        <Money value={b.amount} currency={r.currency} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Region>

          <Region heading="Complete">
            {r.reconciliation_id ? (
              <p className="done">
                Reconciled. These lines can no longer be unmatched, and the month-end close counts
                them as reconciled.
              </p>
            ) : !r.balanced ? (
              <p className="admin-note">
                A reconciliation can be completed once the statement ties to the books.
              </p>
            ) : canReconcile ? (
              <>
                <p className="admin-note" id="complete-what">
                  Completing records these figures. Lines up to {dateText(r.as_of)} can then no
                  longer be unmatched.
                </p>
                <button
                  type="button"
                  className="primary"
                  aria-describedby="complete-what"
                  disabled={complete.isPending}
                  onClick={() => complete.mutate()}
                >
                  Complete reconciliation
                </button>
                {complete.isError ? (
                  <BankRefusal error={complete.error} what="complete this reconciliation" />
                ) : null}
              </>
            ) : (
              <p className="admin-note">
                The statement ties. The Owner, Finance Admin or Accountant completes
                reconciliations.
              </p>
            )}
          </Region>
        </>
      )}
    </>
  );
}
