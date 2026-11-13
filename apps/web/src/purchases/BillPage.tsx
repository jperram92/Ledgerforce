/**
 * One bill (T-0086, UC-05, SS-UC05-08): the coding as entered with the API's GST and totals, the
 * people involved (P7), the next step — "Send for approval" for the AP Clerk, "Approve and post"
 * for an Approver — with the separation-of-duties rule in words before anyone tries it (P6), and
 * the journal: on request the posting engine's preview while it is a draft (P4), and the posted
 * entry once approved (P5: nothing here deletes or edits a posted bill). Whether the caller may
 * approve is decided by the API (SoD outlook), and the approve route checks it again.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { formatMoney, JournalTable, Money } from '@ledgerforce/ui';
import { useId, useState, type ReactNode } from 'react';
import { AdminApiError } from '../admin/client.ts';
import {
  Failure,
  Loading,
  PageHead,
  Refusal,
  useAccess,
  useFailureRouting,
} from '../admin/common.tsx';
import { useServices } from '../env.tsx';
import { typeGloss } from '../gl/gl-logic.ts';
import { billStatus } from './bill-logic.ts';
import { ApForbidden, useApCompany } from './BillsPage.tsx';
import type { Bill, BillStep } from './client.ts';

function Region({ heading, children }: { heading: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="admin-block" aria-labelledby={id}>
      <h2 id={id}>{heading}</h2>
      {children}
    </section>
  );
}

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-AU', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
const who = (s: BillStep) => `${s.by}${s.you ? ' (you)' : ''}, ${when(s.at)}`;

const refusalText = (e: unknown): string | null =>
  e instanceof AdminApiError && e.status === 422 && typeof e.body['message'] === 'string'
    ? e.body['message']
    : null;

export function BillPage({ billId }: { billId: string }) {
  const access = useAccess();
  const { purchases } = useServices();
  const canRead = access.can('ap.read');
  const company = useApCompany();
  const companyId = company.company?.id ?? '';
  const doc = useQuery({
    queryKey: ['ap', 'bill', billId],
    queryFn: () => purchases.bill(companyId, billId),
    enabled: canRead && !!companyId,
  });
  useFailureRouting(doc.error ?? company.error);

  if (access.isPending || (canRead && (company.isPending || doc.isPending)))
    return <Loading what="the bill" />;
  if (access.isError)
    return (
      <Failure
        heading="We could not check what you may do"
        error={access.error}
        onRetry={() => void access.refetch()}
      />
    );
  if (!canRead) return <ApForbidden />;
  if (doc.isError || !doc.data)
    return (
      <Failure
        heading="We could not load this bill"
        error={doc.error}
        onRetry={() => void doc.refetch()}
      />
    );
  return <BillView bill={doc.data} companyId={companyId} can={access.can} />;
}

function BillView({
  bill,
  companyId,
  can,
}: {
  bill: Bill;
  companyId: string;
  can: (p: string) => boolean;
}) {
  const st = billStatus(bill);
  const title = bill.bill_no ? `Bill ${bill.bill_no}` : `Draft bill from ${bill.supplier_name}`;
  return (
    <>
      <PageHead
        title={title}
        gloss={`${bill.supplier_name}'s invoice ${bill.supplier_ref}, dated ${bill.bill_date}, due ${bill.due_date}. Amounts in ${bill.currency}.`}
      />
      <p className="admin-note">
        <span className="word" data-status={st.key}>
          {st.word}
        </span>
      </p>

      <Region heading="Coding">
        <table className="admin-table" aria-label="Coding">
          <thead>
            <tr>
              <th scope="col">Description</th>
              <th scope="col">Account</th>
              <th scope="col">Tax code</th>
              <th scope="col" className="num">
                Before GST
              </th>
            </tr>
          </thead>
          <tbody>
            {bill.lines.map((l) => (
              <tr key={l.line_no}>
                <td data-label="Description">{l.description}</td>
                <td data-label="Account">
                  {l.account_code} {l.account_name}
                </td>
                <td data-label="Tax code">{l.tax_code}</td>
                <td data-label="Before GST" className="num">
                  <Money value={l.amount} />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="bill-totals">
            {(
              [
                ['Before GST', 'Before GST', bill.net],
                ['GST you can claim back', 'GST', bill.tax],
                [`Total you owe ${bill.supplier_name}`, 'Total', bill.gross],
              ] as const
            ).map(([label, short, value]) => (
              <tr key={short}>
                <td colSpan={3} className="bill-total-label">
                  {label}
                </td>
                <td data-label={short} className="num">
                  <Money value={value} />
                </td>
              </tr>
            ))}
          </tfoot>
        </table>
      </Region>

      <Approval bill={bill} companyId={companyId} can={can} />
      <Journal bill={bill} companyId={companyId} />
      <p className="admin-note">
        <Link to="/purchases/bills">All bills</Link>
      </p>
    </>
  );
}

function Approval({
  bill,
  companyId,
  can,
}: {
  bill: Bill;
  companyId: string;
  can: (p: string) => boolean;
}) {
  const { purchases, api } = useServices();
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ['auth', 'me'], queryFn: () => api.me() });
  const whyId = useId();
  const act = useMutation({
    mutationFn: (what: 'submit' | 'approve') =>
      what === 'submit'
        ? purchases.submit(companyId, bill.id)
        : purchases.approve(companyId, bill.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['ap', 'bill', bill.id] });
      await queryClient.invalidateQueries({ queryKey: ['ap', 'bills'] });
    },
  });
  useFailureRouting(act.error);
  const open = bill.status === 'draft';
  const canApprove = can('ap.bill.approve');
  const limit = bill.approval.self_approval_threshold
    ? formatMoney(bill.approval.self_approval_threshold, { currency: bill.currency }).text
    : null;
  const rule = limit
    ? `Bills over ${limit} need someone other than the person who entered them to approve them.`
    : null;
  const refused = refusalText(act.error);

  let action: ReactNode = null;
  if (open && !bill.awaiting_approval) {
    action = can('ap.bill.enter') ? (
      <button
        type="button"
        className="primary"
        disabled={act.isPending}
        onClick={() => {
          act.mutate('submit');
        }}
      >
        Send for approval
      </button>
    ) : (
      <p className="admin-note">
        The AP Clerk who entered it sends it for approval when it is coded.
      </p>
    );
  } else if (open && canApprove) {
    const blocked = !bill.approval.allowed;
    action = (
      <div className="gl-actions-col">
        {blocked ? (
          <p id={whyId} className="admin-note">
            {bill.approval.rule === 'SOD_BILL_SELF_APPROVAL'
              ? `You entered this bill. ${rule ?? ''} Another Approver has to approve it.`
              : 'A separation-of-duties rule stops you approving this bill. Another Approver has to approve it.'}
            {bill.approval.small_team_exception_required
              ? ' In small-team mode the Owner can allow it as a recorded exception.'
              : ''}
          </p>
        ) : null}
        <div className="gl-actions">
          <button
            type="button"
            className="primary"
            disabled={blocked || act.isPending}
            {...(blocked ? { 'aria-describedby': whyId } : {})}
            onClick={() => {
              act.mutate('approve');
            }}
          >
            Approve and post
          </button>
        </div>
      </div>
    );
  } else if (open) {
    action = <p className="admin-note">Waiting for an Approver. You can&apos;t approve bills.</p>;
  }

  return (
    <Region heading="Approval">
      <ul className="gl-people" aria-label="People involved">
        {bill.entered ? <li>Entered by {who(bill.entered)}</li> : null}
        {bill.submitted ? <li>Sent for approval by {who(bill.submitted)}</li> : null}
        {open && bill.awaiting_approval ? (
          canApprove && bill.approval.allowed ? (
            <li>Approver: {me.data?.display_name ?? 'you'} (you)</li>
          ) : (
            <li>Approver: anyone with the Approver role who did not enter it</li>
          )
        ) : null}
        {bill.approved ? <li>Approved by {who(bill.approved)}</li> : null}
      </ul>
      {open && rule ? <p className="admin-note">{rule}</p> : null}
      {action}
      {refused ? (
        <p className="refusal" role="alert">
          LedgerForce did not accept this: {refused}
        </p>
      ) : (
        <Refusal error={act.error} />
      )}
    </Region>
  );
}

function Journal({ bill, companyId }: { bill: Bill; companyId: string }) {
  const { purchases } = useServices();
  const posted = bill.status !== 'draft';
  const [want, setWant] = useState(false);
  const journal = useQuery({
    queryKey: ['ap', 'bill', bill.id, 'journal', bill.status],
    queryFn: () => purchases.journal(companyId, bill.id),
    enabled: posted || want,
    retry: false,
  });
  const refused = refusalText(journal.error);

  let body: ReactNode;
  if (!posted && !want)
    body = (
      <button
        type="button"
        className="secondary"
        onClick={() => {
          setWant(true);
        }}
      >
        Show me the journal
      </button>
    );
  else if (journal.isPending)
    body = <Loading what={posted ? 'the posted journal' : 'the journal LedgerForce would post'} />;
  else if (journal.isSuccess) {
    const j = journal.data;
    body = (
      <>
        <p className="admin-note">
          {j.posted
            ? `This bill is posted as journal ${j.entry_no ?? ''} on ${j.entry_date}. Posted journals are never edited or deleted; a correction is a reversal.`
            : 'This is the journal LedgerForce would post when the bill is approved, from the posting engine itself. Nothing is posted yet.'}
          {!j.posted && j.redirected
            ? ` The date ${j.requested_date} is in a closed period, so it would post on ${j.entry_date}.`
            : ''}
        </p>
        <JournalTable
          journal={j.posted ? (j.entry_no ?? 'posted') : 'preview'}
          currency={j.base_currency}
          lines={j.lines.map((l) => ({
            code: l.account_code,
            account: l.account_name,
            gloss: typeGloss(l.account_type),
            ...(l.debit !== '0.0000' ? { debit: l.debit } : { credit: l.credit }),
          }))}
        />
      </>
    );
  } else if (refused)
    body = (
      <p className="refusal" role="alert">
        We could not build the journal: {refused}
      </p>
    );
  else
    body = (
      <Failure
        heading="We could not load the journal"
        error={journal.error}
        onRetry={() => void journal.refetch()}
      />
    );
  return <Region heading="Journal">{body}</Region>;
}
