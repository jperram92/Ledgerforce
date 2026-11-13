/**
 * Match statement lines (T-0088, UC-08 steps 2–4, SS-UC08-08). One statement's lines with what
 * each is matched to, or what is suggested. "Find matches" runs the API's exact matching and
 * bank rules (T-0149): exact matches are recorded, rules only suggest. An unmatched line can
 * become a transaction (its own screen); a matched one can be unmatched while no completed
 * reconciliation or hard lock covers it (the API refuses otherwise and says why).
 */
import { Money } from '@ledgerforce/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Empty, Failure, Loading, PageHead, useFailureRouting } from '../admin/common.tsx';
import { useServices } from '../env.tsx';
import { accountLabel, LINE_STATUS_WORD, METHOD_WORD, newKey, plural } from './bank-logic.ts';
import { BankForbidden, BankRefusal, dateText, Region, useBankContext } from './common.tsx';
import type { MatchingRun, StatementLine, Suggestion } from './client.ts';

const TITLE = 'Match statement lines';
const GLOSS =
  'Each bank line is matched to what is already in your books, or becomes a new transaction.';

function suggestionText(s: Suggestion): string {
  if (s.kind === 'rule')
    return `Suggested: ${s.account_code ?? ''} ${s.account_name ?? ''}${
      s.rule_name ? ` (rule ${s.rule_name})` : ''
    }`;
  return `Suggested: ${s.entry_no ?? 'a posted entry'}`;
}

function MatchCell({ line }: { line: StatementLine }) {
  if (line.match)
    return (
      <>
        {line.match.entry_no ?? 'Posted entry'}{' '}
        <span className="admin-note">({METHOD_WORD[line.match.method] ?? line.match.method})</span>
      </>
    );
  if (line.suggestions.length === 0) return <span className="admin-note">Nothing yet</span>;
  return (
    <>
      {line.suggestions.map((s) => (
        <span key={s.id}>
          {suggestionText(s)}
          <br />
        </span>
      ))}
    </>
  );
}

export function MatchPage({
  accountId,
  statementId,
}: {
  accountId?: string;
  statementId?: string;
}) {
  const ctx = useBankContext(accountId, statementId);
  const { bank } = useServices();
  const queryClient = useQueryClient();
  const canReconcile = ctx.access.can('bank.reconcile');
  const account = ctx.account;
  const statement = ctx.statement;
  const linesKey = ['bank', 'lines', ctx.companyId, account?.id ?? '', statement?.id ?? ''];
  const lines = useQuery({
    queryKey: linesKey,
    queryFn: () => bank.lines(ctx.companyId, account?.id ?? '', statement?.id ?? ''),
    enabled: ctx.canRead && !!account && !!statement,
  });
  useFailureRouting(lines.error);
  const [runKey, setRunKey] = useState(() => newKey('match'));
  const [ran, setRan] = useState<MatchingRun | null>(null);
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['bank', 'lines'] });
    await queryClient.invalidateQueries({ queryKey: ['bank', 'statements'] });
  };
  const run = useMutation({
    mutationFn: () => bank.runMatching(ctx.companyId, account?.id ?? '', runKey),
    onSuccess: async (r) => {
      setRan(r);
      setRunKey(newKey('match'));
      await refresh();
    },
    onError: () => setRunKey(newKey('match')),
  });
  const unmatch = useMutation({
    mutationFn: (lineId: string) => bank.unmatch(ctx.companyId, lineId, newKey('unmatch')),
    onSuccess: refresh,
  });

  if (ctx.isPending || (!!statement && lines.isPending))
    return <Loading what="the statement lines" />;
  if (!ctx.access.isPending && !ctx.access.isError && !ctx.canRead)
    return <BankForbidden title={TITLE} gloss={GLOSS} />;
  if (ctx.error || lines.isError)
    return (
      <Failure
        heading="We could not load the statement lines"
        error={ctx.error ?? lines.error}
        onRetry={() => (lines.isError ? void lines.refetch() : ctx.refetch())}
      />
    );
  if (!account || !statement)
    return (
      <>
        <PageHead title={TITLE} gloss={GLOSS} />
        <Empty heading="No statement to match">
          Import a statement first. <Link to="/bank/statements">Go to bank statements</Link>
        </Empty>
      </>
    );

  const search = { account: account.id, statement: statement.id };
  const rows = lines.data?.lines ?? [];
  return (
    <>
      <PageHead
        title={TITLE}
        gloss={`${accountLabel(account)}. Statement ${statement.file_name ?? ''}, ${plural(
          statement.lines_total,
          'line',
        )}.`}
      />
      <p className="admin-back">
        <Link to="/bank/statements" search={{ account: account.id }}>
          Back to bank statements
        </Link>{' '}
        or see the{' '}
        <Link to="/bank/reconciliation" search={search}>
          Reconciliation report
        </Link>
      </p>

      {canReconcile ? (
        <Region heading="Find matches">
          <p className="admin-note" id="find-matches-what">
            Lines whose amount and reference agree with one receipt or payment are matched. Bank
            rules only suggest an account; you confirm each suggestion.
          </p>
          <button
            type="button"
            className="primary"
            aria-describedby="find-matches-what"
            disabled={run.isPending}
            onClick={() => run.mutate()}
          >
            Find matches
          </button>
          {run.isError ? <BankRefusal error={run.error} what="find matches" /> : null}
          {ran ? (
            <p className="done" role="status">
              {plural(ran.auto_matched, 'line')} matched, {plural(ran.suggested, 'suggestion')}{' '}
              added. {plural(ran.lines_considered, 'line')} were still to match before this run.
            </p>
          ) : null}
        </Region>
      ) : null}

      <Region heading="Statement lines">
        {unmatch.isError ? <BankRefusal error={unmatch.error} what="unmatch this line" /> : null}
        <table className="admin-table" aria-label="Statement lines">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Description</th>
              <th scope="col" className="num">
                Amount
              </th>
              <th scope="col">State</th>
              <th scope="col">Matched to</th>
              {canReconcile ? <th scope="col">Action</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => (
              <tr key={l.id}>
                <td data-label="Date">{dateText(l.posted_on)}</td>
                <td data-label="Description">
                  {l.description || 'No description'}
                  {l.reference ? (
                    <>
                      <br />
                      <span className="code">{l.reference}</span>
                    </>
                  ) : null}
                </td>
                <td data-label="Amount" className="num">
                  <Money value={l.amount} />
                </td>
                <td data-label="State">
                  <span className="word" data-status={l.status === 'matched' ? 'done' : 'open'}>
                    {LINE_STATUS_WORD[l.status]}
                  </span>
                </td>
                <td data-label="Matched to">
                  <MatchCell line={l} />
                </td>
                {canReconcile ? (
                  <td data-label="Action">
                    {l.status === 'unmatched' ? (
                      <Link to="/bank/match/transaction" search={{ ...search, line: l.id }}>
                        Create transaction
                        <span className="sr-only">
                          {' '}
                          for {l.description}, {dateText(l.posted_on)}
                        </span>
                      </Link>
                    ) : l.status === 'matched' ? (
                      <button
                        type="button"
                        className="secondary"
                        disabled={unmatch.isPending}
                        onClick={() => unmatch.mutate(l.id)}
                      >
                        Unmatch
                        <span className="sr-only">
                          {' '}
                          {l.description}, {dateText(l.posted_on)}
                        </span>
                      </button>
                    ) : null}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </Region>
    </>
  );
}
