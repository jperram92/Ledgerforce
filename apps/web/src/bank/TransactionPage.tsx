/**
 * Create a transaction from a statement line (T-0088, UC-08 step 4, SS-UC08-08). The person picks
 * the account that takes the other side (a rule's suggestion is preselected) and posts. The API
 * (T-0149) builds the manual journal, puts the bank line on the bank account's GL account, and
 * posts it through the posting engine with the manual-journal rules: control accounts refused,
 * approval above the threshold, period checks. The screen does no arithmetic: the amount is the
 * line's own decimal string without its sign.
 */
import { Money } from '@ledgerforce/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { Empty, Failure, Loading, PageHead, useFailureRouting } from '../admin/common.tsx';
import { useServices } from '../env.tsx';
import { accountLabel, counterAmount, lineIsMoneyIn, newKey } from './bank-logic.ts';
import { BankForbidden, BankRefusal, dateText, Region, useBankContext } from './common.tsx';
import type { TransactionInput, TransactionResult } from './client.ts';

const TITLE = 'Create a transaction';
const GLOSS = 'Record a bank line that is not in your books yet, such as a bank fee or interest.';

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
    const trimmed = memo.trim();
    post.mutate({
      lines: [{ account_id: chosen, amount: amountText.trim() }],
      ...(suggestion && suggestion.account_id === chosen
        ? { from_suggestion_id: suggestion.id }
        : {}),
      ...(trimmed === '' ? {} : { memo: trimmed }),
    });
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
            <button type="submit" className="primary" disabled={post.isPending}>
              Post transaction
            </button>
            {post.isError ? <BankRefusal error={post.error} what="post this transaction" /> : null}
          </form>
        )}
      </Region>
    </>
  );
}
