/**
 * Verify a supplier's new bank details (T-0087, UC-06, SS-UC06-09 screen half, design §6.1,
 * §6.2, §6.5 rule 2, §6.6). Lists the changes waiting for verification — the new account and
 * the one it replaces, masked to the last 3 digits — and opens one to check. The Owner (holder of
 * parties.bank_account.verify) writes how the change was confirmed out of band and verifies it;
 * the API asks for a fresh step-up and runs the SoD engine (the person who asked cannot verify).
 * The screen says so before anyone tries, explains refusals in plain words, keeps the typed note
 * across the step-up round trip (this browser tab only) and shows when the new account becomes
 * payable after the cooling-off. Rejecting needs a reason and no step-up (the API's rule).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useState, type ReactNode } from 'react';
import {
  Empty,
  Failure,
  Forbidden,
  Loading,
  PageHead,
  useAccess,
  useFailureRouting,
} from '../admin/common.tsx';
import { timeLabel } from '../admin/dates.ts';
import { useServices } from '../env.tsx';
import { useApCompany } from './BillsPage.tsx';
import type { BankDetailChange } from './payments-client.ts';
import { accountLabel, refusalWords, STEP_UP_WHY_VERIFY } from './payments-logic.ts';
import { isStepUp, StepUpPrompt, useMutationFailureRouting } from './StepUpPrompt.tsx';

const noteKey = (changeId: string) => `lf-bank-verify-note-${changeId}`;
const SELF_VERIFY =
  'You asked for this change. Bank details are verified by someone other than the person who asked for them, so a fake request can’t redirect payments. Another Owner has to verify it.';

type Outcome = { kind: 'verified'; text: string } | { kind: 'rejected'; text: string } | null;

export function BankDetailsPage({ changeId }: { changeId?: string }) {
  const access = useAccess();
  const { payments } = useServices();
  const canRead = access.can('parties.bank_account.read');
  const company = useApCompany();
  const companyId = company.company?.id ?? '';
  const [outcome, setOutcome] = useState<Outcome>(null);
  const list = useQuery({
    queryKey: ['parties', 'bank-detail-changes', companyId],
    queryFn: () => payments.changes(companyId),
    enabled: canRead && !!companyId,
  });
  useFailureRouting(list.error ?? company.error);

  let body: ReactNode;
  if (access.isPending || (canRead && (company.isPending || list.isPending)))
    body = <Loading what="bank-detail changes" />;
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
      <Forbidden heading="You can't see supplier bank details">
        You do not have access to supplier bank details. The Owner, Finance Admin, Accountant, AP
        Clerk, Approver and Auditor can see them, masked; ask your Owner if you need to.
      </Forbidden>
    );
  else if (list.isError || !list.data)
    body = (
      <Failure
        heading="We could not load the bank-detail changes"
        error={list.error ?? company.error}
        onRetry={() => void (list.isError ? list.refetch() : company.refetch())}
      />
    );
  else if (list.data.changes.length === 0)
    body = (
      <Empty heading="Nothing waiting for verification">
        When someone asks to change a supplier’s bank details, the change waits here until another
        person checks it with the supplier and verifies it.
      </Empty>
    );
  else {
    const changes = list.data.changes;
    const chosen = changes.find((c) => c.id === changeId) ?? changes[0];
    body = (
      <>
        <div className="admin-block">
          <table className="admin-table" aria-label="Waiting for verification">
            <thead>
              <tr>
                <th scope="col">Supplier</th>
                <th scope="col">New account</th>
                <th scope="col">Asked for by</th>
                <th scope="col">When</th>
              </tr>
            </thead>
            <tbody>
              {changes.map((c) => (
                <tr key={c.id} aria-current={c.id === chosen?.id ? 'true' : undefined}>
                  <td data-label="Supplier">
                    <Link to="/purchases/bank-details" search={{ change: c.id }}>
                      {c.party_name}
                    </Link>
                  </td>
                  <td data-label="New account">{accountLabel(c.bank_account)}</td>
                  <td data-label="Asked for by">{c.requested_by_name ?? 'Unknown'}</td>
                  <td data-label="When">{timeLabel(c.requested_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {chosen ? (
          <Review
            key={chosen.id}
            change={chosen}
            canVerify={access.can('parties.bank_account.verify')}
            onDone={setOutcome}
          />
        ) : null}
      </>
    );
  }

  return (
    <>
      <PageHead
        title="Supplier bank details to verify"
        gloss="New bank details for suppliers wait here until someone other than the person who asked confirms them with the supplier. Only the last 3 digits of an account number are ever shown."
      />
      {outcome ? (
        <p role="status" className="admin-note">
          {outcome.text}
        </p>
      ) : null}
      {body}
      <p className="admin-note">
        <Link to="/purchases/payment-batches">Payment batches</Link>
      </p>
    </>
  );
}

function Review({
  change,
  canVerify,
  onDone,
}: {
  change: BankDetailChange;
  canVerify: boolean;
  onDone: (o: Outcome) => void;
}) {
  const { payments, api } = useServices();
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ['auth', 'me'], queryFn: () => api.me() });
  const headingId = useId();
  const noteId = useId();
  const helpId = useId();
  const reasonId = useId();
  const [note, setNote] = useState(() => sessionStorage.getItem(noteKey(change.id)) ?? '');
  const [reason, setReason] = useState('');
  const [prompting, setPrompting] = useState(false);
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ['parties', 'bank-detail-changes'] });
  const verify = useMutation({
    mutationFn: () => payments.verify(change.id, note),
    onSuccess: async (r) => {
      sessionStorage.removeItem(noteKey(change.id));
      onDone({
        kind: 'verified',
        text: `Verified. ${change.party_name} can be paid to ${accountLabel(change.bank_account)} from ${timeLabel(r.payable_from)}, after the waiting time. Until then payment batches leave their bills out. Their previous remittance contact has been told about the change.`,
      });
      await refresh();
    },
    onError: (e) => setPrompting(isStepUp(e)),
  });
  const reject = useMutation({
    mutationFn: () => payments.reject(change.id, reason),
    onSuccess: async () => {
      sessionStorage.removeItem(noteKey(change.id));
      onDone({
        kind: 'rejected',
        text: `Rejected. ${change.party_name}’s bank details stay as they were.`,
      });
      await refresh();
    },
  });
  useMutationFailureRouting(verify.error ?? reject.error);
  const mine = !!me.data && me.data.user_id === change.requested_by;

  let action: ReactNode;
  if (!canVerify)
    action = (
      <p className="admin-note">
        Only the Owner verifies bank details. You can see this change but not verify it.
      </p>
    );
  else if (mine) action = <p className="admin-note">{SELF_VERIFY}</p>;
  else if (prompting && isStepUp(verify.error))
    action = (
      <StepUpPrompt
        error={verify.error}
        why={STEP_UP_WHY_VERIFY}
        onLeave={() => sessionStorage.setItem(noteKey(change.id), note)}
        onCancel={() => {
          setPrompting(false);
          verify.reset();
        }}
      />
    );
  else
    action = (
      <>
        <form
          className="gl-actions-col"
          onSubmit={(e) => {
            e.preventDefault();
            verify.mutate();
          }}
        >
          <div className="field">
            <label htmlFor={noteId}>How you confirmed it with the supplier</label>
            <p id={helpId} className="admin-note">
              Call the supplier on a number you already had, not one from the request, and write
              down who confirmed the new account.
            </p>
            <textarea
              id={noteId}
              aria-describedby={helpId}
              required
              maxLength={2000}
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <div className="gl-actions">
            <button
              type="submit"
              className="primary"
              disabled={verify.isPending || note.trim() === ''}
            >
              Verify new bank details
            </button>
          </div>
          {verify.isError && !isStepUp(verify.error) ? (
            <p className="refusal" role="alert">
              {refusalWords(verify.error)}
            </p>
          ) : null}
        </form>
        <details className="admin-block">
          <summary>Reject this change instead</summary>
          <form
            className="gl-actions-col"
            onSubmit={(e) => {
              e.preventDefault();
              reject.mutate();
            }}
          >
            <div className="field">
              <label htmlFor={reasonId}>Why you are rejecting it</label>
              <textarea
                id={reasonId}
                required
                maxLength={2000}
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
            <div className="gl-actions">
              <button
                type="submit"
                className="secondary"
                disabled={reject.isPending || reason.trim() === ''}
              >
                Reject change
              </button>
            </div>
            {reject.isError ? (
              <p className="refusal" role="alert">
                {refusalWords(reject.error)}
              </p>
            ) : null}
          </form>
        </details>
      </>
    );

  return (
    <section className="admin-block bank-review" aria-labelledby={headingId}>
      <h2 id={headingId}>Check {change.party_name}</h2>
      <dl className="bank-change">
        <dt>New account</dt>
        <dd>
          {change.bank_account.account_name}, {accountLabel(change.bank_account)}
        </dd>
        <dt>Replaces</dt>
        <dd>
          {change.previous_bank_account
            ? `${change.previous_bank_account.account_name}, ${accountLabel(change.previous_bank_account)}`
            : 'No bank details before'}
        </dd>
        <dt>Asked for by</dt>
        <dd>
          {change.requested_by_name ?? 'Unknown'}
          {mine ? ' (you)' : ''}, {timeLabel(change.requested_at)}
        </dd>
      </dl>
      {action}
    </section>
  );
}
