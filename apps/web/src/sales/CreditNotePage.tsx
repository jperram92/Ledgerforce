/**
 * Credit note (T-0085, UC-11, SS-UC11-08 credit-note half). From a posted invoice the AR Clerk
 * drafts a credit note for part of one line; the API (T-0045) prices it (GST at the line's own
 * rate) and refuses more than is still creditable. "Show me the journal" is the posting engine's
 * preview of exactly what approval posts (GP-005, T-0151); someone with ar.credit_note.approve
 * posts it, and the separation-of-duties rule for the Clerk's own credit notes is the API's.
 * The Refund region (T-0152, SS-UC11-08 refund half, ADR-0074) shows the customer's refundable
 * credit, requests a refund and lets an Approver approve it (RefundRegion.tsx); `?refund=` keeps
 * the requested refund open. No accounting in the browser: every amount is the API's.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { JournalTable, Money } from '@ledgerforce/ui';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { AdminApiError } from '../admin/client.ts';
import {
  Failure,
  Forbidden,
  Loading,
  PageHead,
  Refusal,
  useAccess,
  useFailureRouting,
} from '../admin/common.tsx';
import { useServices } from '../env.tsx';
import { typeGloss } from '../gl/gl-logic.ts';
import { CREDIT_REASONS, PAYMENT_WORD } from './cash-logic.ts';
import type { CreditNote, Invoice } from './client.ts';
import { quantityText } from './InvoicePage.tsx';
import { RefundRegion } from './RefundRegion.tsx';
import { AR_READERS, useCompany } from './InvoicesPage.tsx';

function Region({ heading, children }: { heading: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="admin-block" aria-labelledby={id}>
      <h2 id={id}>{heading}</h2>
      {children}
    </section>
  );
}

const message = (e: unknown): string | null =>
  e instanceof AdminApiError && e.status === 422 && typeof e.body['message'] === 'string'
    ? e.body['message']
    : null;
const today = () => new Date().toISOString().slice(0, 10);
const cnKey = (id: string) => ['ar', 'credit-note', id] as const;

export function CreditNotePage({
  invoiceId,
  creditNoteId,
  refundId,
}: {
  invoiceId?: string;
  creditNoteId?: string;
  refundId?: string;
}) {
  const access = useAccess();
  const { sales } = useServices();
  const canRead = access.can('ar.read');
  const company = useCompany();
  const companyId = company.company?.id ?? '';
  const note = useQuery({
    queryKey: cnKey(creditNoteId ?? ''),
    queryFn: () => sales.creditNote(companyId, creditNoteId ?? ''),
    enabled: canRead && !!companyId && !!creditNoteId,
  });
  const forInvoice = invoiceId ?? note.data?.invoice_id ?? '';
  const invoices = useQuery({
    queryKey: ['ar', 'invoices', companyId, 'posted'],
    queryFn: () => sales.invoices(companyId, 'posted'),
    enabled: canRead && !!companyId && !forInvoice && !creditNoteId,
  });
  const doc = useQuery({
    queryKey: ['ar', 'invoice', forInvoice],
    queryFn: () => sales.invoice(companyId, forInvoice),
    enabled: canRead && !!companyId && !!forInvoice,
  });
  useFailureRouting(doc.error ?? note.error ?? invoices.error ?? company.error);

  const head = (
    <PageHead
      title="Credit note"
      gloss="Credit part of a posted invoice: it reverses the revenue and its GST. If the invoice is paid, the credit stays with the customer."
    />
  );
  if (
    access.isPending ||
    (canRead &&
      (company.isPending ||
        (!!creditNoteId && note.isPending) ||
        (!!forInvoice && doc.isPending) ||
        (!forInvoice && !creditNoteId && invoices.isPending)))
  )
    return (
      <>
        {head}
        <Loading what="the credit note" />
      </>
    );
  if (access.isError)
    return (
      <Failure
        heading="We could not check what you may do"
        error={access.error}
        onRetry={() => void access.refetch()}
      />
    );
  if (!canRead)
    return (
      <>
        {head}
        <Forbidden heading="You can't see credit notes">
          You do not have access to invoices and credit notes. {AR_READERS} can see them; ask your
          Owner if you need to.
        </Forbidden>
      </>
    );
  const failed = company.error ?? note.error ?? doc.error ?? invoices.error;
  if (failed || !company.company)
    return (
      <>
        {head}
        <Failure
          heading="We could not load the credit note"
          error={failed}
          onRetry={() => {
            void company.refetch();
            if (creditNoteId) void note.refetch();
            if (forInvoice) void doc.refetch();
            else void invoices.refetch();
          }}
        />
      </>
    );

  return (
    <>
      {head}
      {!forInvoice ? (
        <InvoicePicker invoices={invoices.data?.invoices ?? []} />
      ) : doc.data ? (
        <Body
          companyId={companyId}
          invoice={doc.data}
          note={note.data ?? null}
          {...(refundId ? { refundId } : {})}
          search={{
            ...(invoiceId ? { invoice: invoiceId } : {}),
            ...(creditNoteId ? { credit_note: creditNoteId } : {}),
          }}
        />
      ) : null}
      <p className="admin-note">
        <Link to="/sales/invoices">All invoices</Link>
      </p>
    </>
  );
}

function InvoicePicker({ invoices }: { invoices: { id: string; invoice_no: string | null }[] }) {
  const navigate = useNavigate();
  const numbered = invoices.filter((i) => i.invoice_no !== null);
  return (
    <Region heading="Which invoice?">
      {numbered.length === 0 ? (
        <p className="admin-note">There is no posted invoice to credit yet.</p>
      ) : (
        <div className="admin-form">
          <label htmlFor="cn-invoice">Invoice to credit</label>
          <select
            id="cn-invoice"
            value=""
            onChange={(e) =>
              void navigate({ to: '/sales/credit-notes', search: { invoice: e.target.value } })
            }
          >
            <option value="" disabled>
              Choose an invoice
            </option>
            {numbered.map((i) => (
              <option key={i.id} value={i.id}>
                {i.invoice_no}
              </option>
            ))}
          </select>
        </div>
      )}
    </Region>
  );
}

function Body({
  companyId,
  invoice,
  note,
  refundId,
  search,
}: {
  companyId: string;
  invoice: Invoice;
  note: CreditNote | null;
  refundId?: string;
  search: { invoice?: string; credit_note?: string };
}) {
  const { sales } = useServices();
  const access = useAccess();
  const paid = useQuery({
    queryKey: ['ar', 'invoice', invoice.id, 'payment-status'],
    queryFn: () => sales.paymentStatus(companyId, invoice.id),
    enabled: invoice.status === 'posted',
  });
  const name = invoice.invoice_no ?? 'Draft invoice';
  return (
    <>
      <Region heading={`Invoice ${name}`}>
        <p>
          To {invoice.party_name}, issued {invoice.issue_date}, total{' '}
          {invoice.gross_total ? <Money value={invoice.gross_total} /> : 'not priced'}.
          {paid.data ? (
            <>
              {' '}
              <span className="word" data-status={paid.data.status}>
                {PAYMENT_WORD[paid.data.status]}
              </span>
              .
            </>
          ) : null}
        </p>
        <table className="admin-table" aria-label="Invoice lines">
          <thead>
            <tr>
              <th scope="col">Line</th>
              <th scope="col" className="num">
                Quantity
              </th>
              <th scope="col" className="num">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {invoice.lines.map((l) => (
              <tr key={l.line_no}>
                <td data-label="Line">
                  {l.line_no}. {l.description}
                </td>
                <td data-label="Quantity" className="num">
                  {quantityText(l.quantity)}
                </td>
                <td data-label="Amount" className="num">
                  {l.gross ? <Money value={l.gross} /> : 'Not priced'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Region>
      {note ? (
        <NoteView
          companyId={companyId}
          note={note}
          canApprove={access.can('ar.credit_note.approve')}
        />
      ) : invoice.status !== 'posted' ? (
        <p className="admin-note">Only a posted invoice can be credited.</p>
      ) : access.can('ar.credit_note.create') ? (
        <CreditForm companyId={companyId} invoice={invoice} />
      ) : (
        <p className="admin-note">AR Clerks, Finance Admins and Owners issue credit notes.</p>
      )}
      {invoice.status === 'posted' ? (
        <RefundRegion
          companyId={companyId}
          partyId={invoice.party_id}
          partyName={invoice.party_name}
          {...(refundId ? { refundId } : {})}
          search={search}
        />
      ) : null}
    </>
  );
}

function CreditForm({ companyId, invoice }: { companyId: string; invoice: Invoice }) {
  const { sales } = useServices();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const headingId = useId();
  const [id] = useState(() => crypto.randomUUID());
  const [line, setLine] = useState(String(invoice.lines[0]?.line_no ?? 1));
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState<string>(CREDIT_REASONS[0].code);
  const [date, setDate] = useState(today);
  const create = useMutation({
    mutationFn: () =>
      sales.createCreditNote(id, {
        company_id: companyId,
        invoice_id: invoice.id,
        issue_date: date,
        reason_code: reason,
        lines: [{ invoice_line_no: Number.parseInt(line, 10), amount }],
      }),
    onSuccess: async (cn) => {
      queryClient.setQueryData(cnKey(cn.id), cn);
      await navigate({ to: '/sales/credit-notes', search: { credit_note: cn.id } });
    },
  });
  useFailureRouting(create.error);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  const refused = message(create.error);
  const tax = invoice.pricing === 'inclusive' ? 'including' : 'excluding';
  return (
    <section className="admin-block" aria-labelledby={headingId}>
      <h2 id={headingId}>What to credit</h2>
      <p>
        Choose the line and how much of it to credit. GST is worked out by LedgerForce at the
        line&rsquo;s own rate.
      </p>
      <form className="admin-form" onSubmit={submit} noValidate>
        <label htmlFor="cn-line">Line</label>
        <select id="cn-line" value={line} onChange={(e) => setLine(e.target.value)}>
          {invoice.lines.map((l) => (
            <option key={l.line_no} value={String(l.line_no)}>
              {l.line_no}. {l.description}
            </option>
          ))}
        </select>
        <label htmlFor="cn-amount">Amount {tax} GST</label>
        <input
          id="cn-amount"
          inputMode="decimal"
          autoComplete="off"
          required
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <label htmlFor="cn-reason">Reason</label>
        <select id="cn-reason" value={reason} onChange={(e) => setReason(e.target.value)}>
          {CREDIT_REASONS.map((r) => (
            <option key={r.code} value={r.code}>
              {r.label}
            </option>
          ))}
        </select>
        <label htmlFor="cn-date">Date</label>
        <input
          id="cn-date"
          type="date"
          required
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
        <button type="submit" className="primary" disabled={create.isPending}>
          Create draft credit note
        </button>
        {refused ? (
          <p className="refusal" role="alert">
            We could not draft this credit note: {refused}
          </p>
        ) : (
          <Refusal error={create.error} />
        )}
      </form>
    </section>
  );
}

function NoteView({
  companyId,
  note,
  canApprove,
}: {
  companyId: string;
  note: CreditNote;
  canApprove: boolean;
}) {
  const { sales } = useServices();
  const queryClient = useQueryClient();
  const [wantJournal, setWantJournal] = useState(false);
  const journal = useQuery({
    queryKey: [...cnKey(note.id), 'journal'],
    queryFn: () => sales.creditNoteJournal(companyId, note.id),
    enabled: wantJournal && note.status === 'draft',
    retry: false,
  });
  const approve = useMutation({
    mutationFn: () => sales.approveCreditNote(companyId, note.id),
    onSuccess: (cn) => queryClient.setQueryData(cnKey(cn.id), cn),
  });
  useFailureRouting(approve.error ?? journal.error);
  const posted = note.status === 'posted';
  const refused = message(journal.error);
  const approveRefused = message(approve.error);
  return (
    <Region heading={posted ? `Credit note ${note.credit_note_no ?? ''}` : 'Draft credit note'}>
      {posted ? (
        <p className="admin-state" role="status">
          Posted. Its journal is in the general ledger.
        </p>
      ) : null}
      <dl className="bb-totals">
        <div>
          <dt>Credit before GST</dt>
          <dd>
            <Money value={note.net} />
          </dd>
        </div>
        <div>
          <dt>GST</dt>
          <dd>
            <Money value={note.tax} />
          </dd>
        </div>
        <div>
          <dt>Total credit</dt>
          <dd>
            <Money value={note.gross} />
          </dd>
        </div>
      </dl>
      {posted ? null : !wantJournal ? (
        <button type="button" className="primary" onClick={() => setWantJournal(true)}>
          Show me the journal
        </button>
      ) : journal.isPending ? (
        <Loading what="the journal LedgerForce would post" />
      ) : journal.isSuccess ? (
        <>
          <p className="admin-note">
            This is the journal LedgerForce would post when the credit note is approved, from the
            posting engine itself. Nothing is posted yet.
            {journal.data.redirected
              ? ` The date ${journal.data.requested_date} is in a closed period, so it would post on ${journal.data.entry_date}.`
              : ''}
          </p>
          <JournalTable
            journal="preview"
            currency={journal.data.base_currency}
            lines={journal.data.lines.map((l) => ({
              code: l.account_code,
              account: l.account_name,
              gloss: typeGloss(l.account_type),
              ...(l.debit !== '0.0000' ? { debit: l.debit } : { credit: l.credit }),
            }))}
          />
          {canApprove ? (
            <button
              type="button"
              className="primary"
              disabled={approve.isPending}
              onClick={() => approve.mutate()}
            >
              Approve and post
            </button>
          ) : (
            <p className="admin-note">
              An Approver posts it. Credit notes are approved by someone with approval rights; above
              the company&rsquo;s threshold, not by the person who drafted them.
            </p>
          )}
          {approveRefused ? (
            <p className="refusal" role="alert">
              We could not post this credit note: {approveRefused}
            </p>
          ) : (
            <Refusal error={approve.error} />
          )}
        </>
      ) : refused ? (
        <p className="refusal" role="alert">
          We could not build the journal: {refused}
        </p>
      ) : (
        <Failure
          heading="We could not build the journal"
          error={journal.error}
          onRetry={() => void journal.refetch()}
        />
      )}
    </Region>
  );
}
