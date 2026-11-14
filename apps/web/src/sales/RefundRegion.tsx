/**
 * Refund of a customer's credit (T-0152, UC-11, SS-UC11-08 refund half, ADR-0074), shown in the
 * credit-note screen. The AR Clerk sees what the customer can have back (GET /ar/parties/:id/credit)
 * and requests a refund (PUT /ar/refunds/:id, a client id kept for the form's life, so a repeat is
 * the same refund). "Show me the journal" is the posting engine's GP-006 preview. Someone with
 * ar.refund.approve, other than the person who requested it (the API's SoD rule), approves it; the
 * money then leaves in the next supplier payment batch, under that batch's own release rules.
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
  const create = useMutation({
    mutationFn: () =>
      sales.createRefund(id, {
        company_id: companyId,
        party_id: partyId,
        refund_date: date,
        amount,
        method: 'bank_batch',
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
      <p>
        The refund is paid to the customer&rsquo;s verified bank account in the next supplier
        payment batch, after an Approver approves it.
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
}: {
  companyId: string;
  refund: CustomerRefund;
  canApprove: boolean;
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
  const approve = useMutation({
    mutationFn: () => sales.approveRefund(companyId, refund.id),
    onSuccess: (r) => queryClient.setQueryData(refundKey(r.id), r),
  });
  useFailureRouting(approve.error ?? journal.error);
  const approved = refund.approval === 'approved';
  const state =
    refund.status === 'paid'
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
            This is the journal LedgerForce will post when the bank confirms the payment batch that
            pays this refund, from the posting engine itself. Nothing is posted yet; it will be
            dated the day the bank confirms.
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
        canApprove ? (
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
      ) : (
        <Refusal error={approve.error} />
      )}
    </>
  );
}
