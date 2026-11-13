/**
 * Create a transaction from a statement line (T-0088, UC-08 step 4, SS-UC08-08). The person picks
 * the account that takes the other side (a rule's suggestion is preselected), sees the journal the
 * posting engine would post (T-0150, P4 "show the journal before you post": rebuilt when the
 * account, amount or memo changes; posting is offered only while the journal on screen is the one
 * for what the form says) and posts. The API (T-0149) builds the manual journal, puts the bank
 * line on the bank account's GL account, and posts it through the posting engine with the
 * manual-journal rules: control accounts refused, approval above the threshold, period checks.
 * The screen does no arithmetic: the amount is the line's own decimal string without its sign.
 */
import { JournalTable, Money } from '@ledgerforce/ui';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useState, type FormEvent } from 'react';
import { Empty, Failure, Loading, PageHead, useFailureRouting } from '../admin/common.tsx';
import { useServices } from '../env.tsx';
import { typeGloss } from '../gl/gl-logic.ts';
import {
  accountLabel,
  counterAmount,
  lineIsMoneyIn,
  newKey,
  transactionInput,
} from './bank-logic.ts';
import { BankForbidden, BankRefusal, dateText, Region, useBankContext } from './common.tsx';
import type { TransactionInput, TransactionPreview, TransactionResult } from './client.ts';

const TITLE = 'Create a transaction';
const GLOSS = 'Record a bank line that is not in your books yet, such as a bank fee or interest.';

/** The value once it has stopped changing for `ms`, so typing does not ask the API each key. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

export function TransactionPage({
  accountId,
  statementId,
  lineId,
}: {
  accountId?: string;
  statementId?: string;
  lineId?: string;
}) {
  const ctx = useBankContext(accountId, statementId);
  const { bank, gl } = useServices();
  const queryClient = useQueryClient();
  const canReconcile = ctx.access.can('bank.reconcile');
  const account = ctx.account;
  const statement = ctx.statement;
  const enabled = ctx.canRead && canReconcile && !!account && !!statement;
  const lines = useQuery({
    queryKey: ['bank', 'lines', ctx.companyId, account?.id ?? '', statement?.id ?? ''],
    queryFn: () => bank.lines(ctx.companyId, account?.id ?? '', statement?.id ?? ''),
    enabled,
  });
  const chart = useQuery({ queryKey: ['gl', 'chart'], queryFn: () => gl.chart(), enabled });
  useFailureRouting(lines.error ?? chart.error);
  const line = lines.data?.lines.find((l) => l.id === lineId);
  const suggestion = line?.suggestions.find((s) => s.kind === 'rule' && s.account_id);
  const [accountChoice, setAccountChoice] = useState<string | null>(null);
  const [amount, setAmount] = useState<string | null>(null);
  const [memo, setMemo] = useState('');
  const [key, setKey] = useState(() => newKey('transaction'));
  const [done, setDone] = useState<TransactionResult | null>(null);
  // One request body for the preview and the post, so the post sends what the preview showed.
  const request = line
    ? transactionInput(line, accountChoice ?? suggestion?.account_id ?? '', amount, memo)
    : null;
  const requestText = request === null ? null : JSON.stringify(request);
  const settledText = useSettled(requestText, 300);
  // Not under ['bank']: posting invalidates ['bank'], and the posted line has no journal to preview.
  const preview = useQuery({
    queryKey: ['bank-transaction-preview', ctx.companyId, lineId ?? '', settledText],
    queryFn: () =>
      bank.previewTransaction(
        ctx.companyId,
        lineId ?? '',
        JSON.parse(settledText ?? '{}') as TransactionInput,
      ),
    enabled: enabled && settledText !== null && done === null && line?.status === 'unmatched',
  });
  /** The journal on screen is the one for what the form says now. */
  const previewCurrent = settledText === requestText && preview.isSuccess && !preview.isFetching;
  const post = useMutation({
    mutationFn: (input: TransactionInput) =>
      bank.createTransaction(ctx.companyId, lineId ?? '', input, key),
    onSuccess: async (r) => {
      setDone(r);
      setKey(newKey('transaction'));
      await queryClient.invalidateQueries({ queryKey: ['bank'] });
    },
    onError: () => setKey(newKey('transaction')),
  });

  if (ctx.isPending || (enabled && (lines.isPending || chart.isPending)))
    return <Loading what="the statement line" />;
  if (!ctx.access.isPending && !ctx.access.isError && !ctx.canRead)
    return <BankForbidden title={TITLE} gloss={GLOSS} />;
  if (ctx.error || lines.isError || chart.isError)
    return (
      <Failure
        heading="We could not load the statement line"
        error={ctx.error ?? lines.error ?? chart.error}
        onRetry={() => {
          void lines.refetch();
          void chart.refetch();
          ctx.refetch();
        }}
      />
    );
  if (!canReconcile)
    return (
      <>
        <PageHead title={TITLE} gloss={GLOSS} />
        <Empty heading="Only people who reconcile can do this">
          Creating transactions from bank lines needs the bank reconciliation permission. The Owner,
          Finance Admin and Accountant have it.
        </Empty>
      </>
    );
  if (!account || !statement || !line)
    return (
      <>
        <PageHead title={TITLE} gloss={GLOSS} />
        <Empty heading="That bank line was not found">
          <Link to="/bank/statements">Go to bank statements</Link>
        </Empty>
      </>
    );

  const back = (
    <Link to="/bank/match" search={{ account: account.id, statement: statement.id }}>
      Back to the statement lines
    </Link>
  );
  const choices = (chart.data?.accounts ?? []).filter(
    (a) => a.postable && !a.is_control && a.status === 'active',
  );
  const chosen = accountChoice ?? suggestion?.account_id ?? '';
  const amountText = amount ?? counterAmount(line.amount);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (request && previewCurrent) post.mutate(request);
  };

  return (
    <>
      <PageHead title={TITLE} gloss={GLOSS} />
      <p className="admin-back">{back}</p>
      <Region heading="The bank line">
        <dl className="bank-facts">
          <dt>Bank account</dt>
          <dd>{accountLabel(account)}</dd>
          <dt>Date</dt>
          <dd>{dateText(line.posted_on)}</dd>
          <dt>Description</dt>
          <dd>{line.description || 'No description'}</dd>
          {line.reference ? (
            <>
              <dt>Reference</dt>
              <dd className="code">{line.reference}</dd>
            </>
          ) : null}
          <dt>Amount</dt>
          <dd>
            <Money value={line.amount} />{' '}
            <span className="admin-note">
              ({lineIsMoneyIn(line.amount) ? 'money in' : 'money out'})
            </span>
          </dd>
        </dl>
      </Region>

      <Region heading="The other side">
        {done ? (
          <p className="done" role="status">
            Posted as {done.entry_no}. The line is matched to it.
          </p>
        ) : line.status !== 'unmatched' ? (
          <p className="admin-note">
            This line is already matched to {line.match?.entry_no ?? 'a posted entry'}. Unmatch it
            first to record it differently.
          </p>
        ) : (
          <form className="admin-form" onSubmit={submit}>
            {suggestion ? (
              <p className="admin-note">
                The rule {suggestion.rule_name ?? ''} suggests {suggestion.account_code}{' '}
                {suggestion.account_name}. Keep it to accept the suggestion.
              </p>
            ) : null}
            <label htmlFor="txn-account">Account</label>
            <select
              id="txn-account"
              required
              value={chosen}
              onChange={(e) => setAccountChoice(e.target.value)}
            >
              <option value="">Choose an account</option>
              {choices.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} {a.name}
                </option>
              ))}
            </select>
            <label htmlFor="txn-amount">Amount</label>
            <input
              id="txn-amount"
              inputMode="decimal"
              required
              value={amountText}
              aria-describedby="txn-amount-hint"
              onChange={(e) => setAmount(e.target.value)}
            />
            <p className="admin-note" id="txn-amount-hint">
              The whole bank line goes to this account. The journal must balance, so the API refuses
              any other amount.
            </p>
            <label htmlFor="txn-memo">Memo (optional)</label>
            <input id="txn-memo" value={memo} onChange={(e) => setMemo(e.target.value)} />
            <JournalPreview request={requestText} settled={settledText} preview={preview} />
            <button
              type="submit"
              className="primary"
              disabled={post.isPending || !previewCurrent}
              aria-describedby="txn-post-hint"
            >
              Post transaction
            </button>
            <p className="admin-note" id="txn-post-hint">
              {previewCurrent
                ? 'Posting records exactly the journal shown above.'
                : 'You can post once the journal above is built.'}
            </p>
            {post.isError ? <BankRefusal error={post.error} what="post this transaction" /> : null}
          </form>
        )}
      </Region>
    </>
  );
}

/** The posting engine's journal for the form as it is now, or why there is none (P4, P6). */
function JournalPreview({
  request,
  settled,
  preview,
}: {
  request: string | null;
  settled: string | null;
  preview: UseQueryResult<TransactionPreview>;
}) {
  let body;
  if (request === null) {
    body = (
      <p className="admin-note">
        Choose an account and enter the amount, like 10.00, to see the journal.
      </p>
    );
  } else if (request !== settled || preview.isPending || preview.isFetching) {
    body = <p className="admin-note">Building the journal LedgerForce would post…</p>;
  } else if (preview.isError) {
    body = <BankRefusal error={preview.error} what="build the journal" />;
  } else {
    const p = preview.data;
    body = (
      <>
        <p className="admin-note">
          This is the journal LedgerForce would post, from the posting engine itself. Nothing is
          posted yet.
          {p.redirected
            ? ` The date ${p.requested_date} is in a closed period, so it would post on ${p.entry_date}.`
            : ''}
        </p>
        <JournalTable
          journal="preview"
          currency={p.base_currency}
          lines={p.lines.map((l) => ({
            code: l.account_code,
            account: l.account_name,
            gloss: typeGloss(l.account_type),
            ...(l.debit !== '0.0000' ? { debit: l.debit } : { credit: l.credit }),
          }))}
        />
      </>
    );
  }
  return (
    <div className="bank-journal" aria-live="polite">
      <h3>The journal it will post</h3>
      {body}
    </div>
  );
}
