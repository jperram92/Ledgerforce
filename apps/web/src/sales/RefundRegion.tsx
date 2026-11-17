/**
 * Refund of a customer's credit (T-0152, UC-11, SS-UC11-08 refund half, ADR-0074), shown in the
 * credit-note screen. The AR Clerk sees what the customer can have back (GET /ar/parties/:id/credit)
 * and requests a refund (PUT /ar/refunds/:id, a client id kept for the form's life, so a repeat is
 * the same refund). "Show me the journal" is the posting engine's GP-006 preview. Someone with
 * ar.refund.approve, other than the person who requested it (the API's SoD rule), approves it; the
 * money then leaves in the next supplier payment batch, under that batch's own release rules.
 * A refund back to the card through Stripe (T-0172, ADR-0083) is sent the moment it is approved,
 * so approving it needs a fresh sign-in step (DL-0562: the step-up prompt); the region then shows
 * what Stripe did, or that LedgerForce is retrying the send. A Stripe refund that Stripe refused can
 * be cancelled by someone who requests refunds (T-0190), after a confirmation step; the API asks
 * Stripe first and refuses if Stripe has a refund for it.
 * No accounting in the browser: every amount and journal line is the API's.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { JournalTable, Money } from '@ledgerforce/ui';
import { useId, useState, type FormEvent } from 'react';
import { AdminApiError } from '../admin/client.ts';
import { Failure, Loading, Refusal, useAccess, useFailureRouting } from '../admin/common.tsx';
import { useServices } from '../env.tsx';
import { typeGloss } from '../gl/gl-logic.ts';
import { isStepUp, StepUpPrompt, useMutationFailureRouting } from '../purchases/StepUpPrompt.tsx';
import type { CustomerRefund } from './client.ts';

const refused = (e: unknown): string | null =>
  e instanceof AdminApiError && e.status === 422 && typeof e.body['message'] === 'string'
    ? e.body['message']
    : null;
const refundKey = (id: string) => ['ar', 'refund', id] as const;
const creditKey = (partyId: string) => ['ar', 'party', partyId, 'credit'] as const;
const today = () => new Date().toISOString().slice(0, 10);
const NONE = '0.0000';

export function RefundRegion({
  companyId,
  partyId,
  partyName,
  refundId,
  search,
}: {
  companyId: string;
  partyId: string;
  partyName: string;
  refundId?: string;
  /** The credit-note page's own search, kept when a refund is opened. */
  search: { invoice?: string; credit_note?: string };
}) {
  const { sales } = useServices();
  const access = useAccess();
  const headingId = useId();
  const credit = useQuery({
    queryKey: creditKey(partyId),
    queryFn: () => sales.partyCredit(companyId, partyId),
  });
  const refund = useQuery({
    queryKey: refundKey(refundId ?? ''),
    queryFn: () => sales.refund(companyId, refundId ?? ''),
    enabled: !!refundId,
  });
  useFailureRouting(credit.error ?? refund.error);
  const body = () => {
    if (credit.isPending || (!!refundId && refund.isPending))
      return <Loading what="the customer's credit" />;
    if (credit.isError || refund.isError)
      return (
        <Failure
          heading="We could not load the customer's credit"
          error={credit.error ?? refund.error}
          onRetry={() => {
            void credit.refetch();
            if (refundId) void refund.refetch();
          }}
        />
      );
    const c = credit.data;
    return (
      <>
        <dl className="bb-totals">
          <div>
            <dt>{partyName} can have back</dt>
            <dd>
              <Money value={c.available} />
            </dd>
          </div>
          <div>
            <dt>Refunds already requested</dt>
            <dd>
              <Money value={c.requested} />
            </dd>
          </div>
        </dl>
        {refund.data ? (
          <RefundView
            companyId={companyId}
            refund={refund.data}
            canApprove={access.can('ar.refund.approve')}
            canCancel={access.can('ar.refund.create')}
          />
        ) : c.available === NONE ? (
          <p className="admin-note">
            {partyName} has no credit to refund. A credit appears when a paid invoice is credited.
          </p>
        ) : access.can('ar.refund.create') ? (
          <RefundForm companyId={companyId} partyId={partyId} search={search} />
        ) : (
          <p className="admin-note">
            AR Clerks, Finance Admins and Owners request refunds; an Approver then approves them.
          </p>
        )}
      </>
    );
  };
  return (
    <section className="admin-block" aria-labelledby={headingId}>
      <h2 id={headingId}>Refund</h2>
      {body()}
    </section>
  );
}

function RefundForm({
  companyId,
  partyId,
  search,
}: {
  companyId: string;
  partyId: string;
  search: { invoice?: string; credit_note?: string };
}) {
  const { sales } = useServices();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [id] = useState(() => crypto.randomUUID());
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today);
  const [reason, setReason] = useState('');
  const [method, setMethod] = useState<'bank_batch' | 'stripe'>('bank_batch');
  const create = useMutation({
    mutationFn: () =>
      sales.createRefund(id, {
        company_id: companyId,
        party_id: partyId,
        refund_date: date,
        amount,
        method,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      }),
    onSuccess: async (r) => {
      queryClient.setQueryData(refundKey(r.id), r);
      await queryClient.invalidateQueries({ queryKey: creditKey(partyId) });
      await navigate({ to: '/sales/credit-notes', search: { ...search, refund: r.id } });
    },
  });
  useFailureRouting(create.error);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  const why = refused(create.error);
  return (
    <form className="admin-form" onSubmit={submit} noValidate aria-label="Request a refund">
      <fieldset className="rf-method">
        <legend>How the customer gets it back</legend>
        <label>
          <input
            type="radio"
            name="rf-method"
            value="bank_batch"
            checked={method === 'bank_batch'}
            onChange={() => setMethod('bank_batch')}
          />{' '}
          To their verified bank account, in the next supplier payment batch
        </label>
        <label>
          <input
            type="radio"
            name="rf-method"
            value="stripe"
            checked={method === 'stripe'}
            onChange={() => setMethod('stripe')}
          />{' '}
          Back to the card they paid with, through Stripe
        </label>
      </fieldset>
      <p>
        {method === 'stripe'
          ? 'After an Approver approves it, the refund goes back to the card at once.'
          : 'The refund is paid to the customer’s verified bank account in the next supplier payment batch, after an Approver approves it.'}
      </p>
      <label htmlFor="rf-amount">Amount to refund</label>
      <input
        id="rf-amount"
        inputMode="decimal"
        autoComplete="off"
        required
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <label htmlFor="rf-date">Pay from</label>
      <input
        id="rf-date"
        type="date"
        required
        value={date}
        onChange={(e) => setDate(e.target.value)}
      />
      <label htmlFor="rf-reason">Reason (optional)</label>
      <input
        id="rf-reason"
        autoComplete="off"
        maxLength={500}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <button type="submit" className="secondary" disabled={create.isPending}>
        Request refund
      </button>
      {why ? (
        <p className="refusal" role="alert">
          We could not request this refund: {why}
        </p>
      ) : (
        <Refusal error={create.error} />
      )}
    </form>
  );
}

function RefundView({
  companyId,
  refund,
  canApprove,
  canCancel,
}: {
  companyId: string;
  refund: CustomerRefund;
  canApprove: boolean;
  canCancel: boolean;
}) {
  const { sales } = useServices();
  const queryClient = useQueryClient();
  const [wantJournal, setWantJournal] = useState(false);
  const journal = useQuery({
    queryKey: [...refundKey(refund.id), 'journal'],
    queryFn: () => sales.refundJournal(companyId, refund.id),
    enabled: wantJournal && refund.status === 'requested',
    retry: false,
  });
  const [prompting, setPrompting] = useState(false);
  const approve = useMutation({
    mutationFn: () => sales.approveRefund(companyId, refund.id),
    onSuccess: (r) => {
      setPrompting(false);
      queryClient.setQueryData(refundKey(r.id), r);
    },
    onError: (e) => setPrompting(isStepUp(e)),
  });
  useMutationFailureRouting(approve.error);
  useFailureRouting(journal.error);
  const approved = refund.approval === 'approved';
  const stripe = refund.method === 'stripe';
  const state = stripe
    ? stripeState(refund)
    : refund.status === 'paid'
      ? `Paid on ${refund.paid_on ?? ''}. Its journal is in the general ledger.`
      : refund.status === 'cancelled'
        ? 'Cancelled.'
        : approved
          ? 'Approved. It will be paid in the next supplier payment batch.'
          : 'Waiting for approval. An Approver, not the person who requested it, approves it.';
  const approveWhy = refused(approve.error);
  const journalWhy = refused(journal.error);
  return (
    <>
      <h3>
        Refund {refund.refund_no}: <Money value={refund.amount} />
      </h3>
      <p className="admin-state" role="status">
        {state}
      </p>
      {refund.status !== 'requested' ? null : !wantJournal ? (
        <div className="rf-action">
          <button type="button" className="secondary" onClick={() => setWantJournal(true)}>
            Show me the journal
          </button>
        </div>
      ) : journal.isPending ? (
        <Loading what="the journal LedgerForce would post" />
      ) : journal.isSuccess ? (
        <>
          <p className="admin-note">
            {stripe
              ? 'This is the journal LedgerForce will post when Stripe takes the refund, from the posting engine itself. Nothing is posted yet; it will be dated the day it is sent.'
              : 'This is the journal LedgerForce will post when the bank confirms the payment batch that pays this refund, from the posting engine itself. Nothing is posted yet; it will be dated the day the bank confirms.'}
          </p>
          <JournalTable
            journal="preview"
            currency={journal.data.base_currency}
            lines={journal.data.lines.map((l) => ({
              code: l.account_code,
              account: l.account_name,
              gloss: typeGloss(l.account_type),
              ...(l.debit !== NONE ? { debit: l.debit } : { credit: l.credit }),
            }))}
          />
        </>
      ) : journalWhy ? (
        <p className="refusal" role="alert">
          We could not build the journal: {journalWhy}
        </p>
      ) : (
        <Failure
          heading="We could not build the journal"
          error={journal.error}
          onRetry={() => void journal.refetch()}
        />
      )}
      {refund.status === 'requested' && !approved ? (
        canApprove && prompting && isStepUp(approve.error) ? (
          <StepUpPrompt
            error={approve.error}
            why={`Approving this refund sends ${money2(refund.amount)} back to the card at once, through Stripe. Confirm it’s you first.`}
            onCancel={() => {
              setPrompting(false);
              approve.reset();
            }}
          />
        ) : canApprove ? (
          <div className="rf-action">
            <button
              type="button"
              className="primary"
              disabled={approve.isPending}
              onClick={() => approve.mutate()}
            >
              Approve refund
            </button>
          </div>
        ) : (
          <p className="admin-note">An Approver, Finance Admin or Owner approves refunds.</p>
        )
      ) : null}
      {approveWhy ? (
        <p className="refusal" role="alert">
          We could not approve this refund: {approveWhy}
        </p>
      ) : isStepUp(approve.error) ? null : (
        <Refusal error={approve.error} />
      )}
      {canCancel && cancellable(refund) ? (
        <CancelRefund companyId={companyId} refund={refund} />
      ) : null}
    </>
  );
}

/**
 * T-0190: a requested Stripe refund that Stripe refused (its send failed, and Stripe does not have
 * the money: not SENT_NOT_POSTED) can be cancelled, so its credit can be refunded another way.
 */
const cancellable = (r: CustomerRefund) =>
  r.method === 'stripe' &&
  r.status === 'requested' &&
  r.stripe?.status === 'failed' &&
  r.stripe.code !== 'SENT_NOT_POSTED';

/** Cancel with a confirmation step (T-0190); the API asks Stripe first and may refuse. */
function CancelRefund({ companyId, refund }: { companyId: string; refund: CustomerRefund }) {
  const { sales } = useServices();
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState(false);
  const legendId = useId();
  const cancel = useMutation({
    mutationFn: () => sales.cancelRefund(companyId, refund.id),
    onSuccess: async (r) => {
      setAsking(false);
      queryClient.setQueryData(refundKey(r.id), r);
      await queryClient.invalidateQueries({ queryKey: creditKey(r.party_id) });
    },
  });
  useMutationFailureRouting(cancel.error);
  const why =
    cancel.error instanceof AdminApiError &&
    (cancel.error.status === 409 || cancel.error.status === 422) &&
    typeof cancel.error.body['message'] === 'string'
      ? cancel.error.body['message']
      : null;
  return (
    <>
      {asking ? (
        <div className="rf-action" role="group" aria-labelledby={legendId}>
          <p id={legendId}>
            <strong>Cancel this refund?</strong>
          </p>
          <p>
            Cancelling frees {money2(refund.amount)} of the customer’s credit, so it can be refunded
            another way. LedgerForce checks with Stripe first and refuses if Stripe has a refund for
            it.
          </p>
          <button
            type="button"
            className="primary"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate()}
          >
            Yes, cancel it
          </button>{' '}
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setAsking(false);
              cancel.reset();
            }}
          >
            Keep it
          </button>
        </div>
      ) : (
        <div className="rf-action">
          <button type="button" className="secondary" onClick={() => setAsking(true)}>
            Cancel refund
          </button>
        </div>
      )}
      {why ? (
        <p className="refusal" role="alert">
          We could not cancel this refund: {why}
        </p>
      ) : (
        <Refusal error={cancel.error} />
      )}
    </>
  );
}

/** "220.0000" → "220.00" for a sentence; the amount is the API's, only its text is shortened. */
const money2 = (v: string) => v.replace(/^(-?\d+)\.(\d{2})\d*$/, '$1.$2');

/** The state line of a Stripe refund (T-0172, ADR-0083), from the API's own fields. */
function stripeState(r: CustomerRefund): string {
  if (r.status === 'paid')
    return `Refunded to the card through Stripe on ${r.paid_on ?? ''}${
      r.stripe?.stripe_refund_id ? ` (Stripe refund ${r.stripe.stripe_refund_id})` : ''
    }. Its journal is in the general ledger.`;
  if (r.status === 'cancelled') return 'Cancelled.';
  // Security review r8 F1: Stripe has the money out, the journal is missing — never "refused".
  if (r.approval === 'approved' && r.stripe?.code === 'SENT_NOT_POSTED')
    return `Sent to Stripe${
      r.stripe.stripe_refund_id ? ` (Stripe refund ${r.stripe.stripe_refund_id})` : ''
    }: the money has left, but the refund is not posted in the books: ${
      r.stripe.message ?? 'no reason given'
    }. A Finance Admin sees it in Sync issues; retrying it there records this Stripe refund and never sends another.`;
  if (r.approval === 'approved')
    return r.stripe?.status === 'failed'
      ? `Approved, but Stripe refused the refund: ${(r.stripe.message ?? 'no reason given').replace(/\.$/, '')}. A Finance Admin sees it in Sync issues; whoever requests refunds can cancel it, so the credit can be refunded another way.`
      : 'Approved. Sending it to Stripe did not finish; LedgerForce tries again automatically, and a refund that keeps failing appears in Sync issues.';
  return 'Waiting for approval. An Approver, not the person who requested it, approves it; it then goes back to the card at once.';
}
