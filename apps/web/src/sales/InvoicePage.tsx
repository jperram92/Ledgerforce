/**
 * One invoice (T-0083, UC-01, SS-UC01-10): header facts, the lines as entered and, on request,
 * "Show me the journal": the posting engine's preview of exactly what approving the draft would
 * post (P4, design §3.9; T-0131). Nothing is posted from this screen; approving one invoice over
 * HTTP is T-0132. No accounting happens in the browser: amounts are the API's decimal strings.
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { JournalTable, Money } from '@ledgerforce/ui';
import { useId, useState, type ReactNode } from 'react';
import { AdminApiError } from '../admin/client.ts';
import {
  Failure,
  Forbidden,
  Loading,
  PageHead,
  useAccess,
  useFailureRouting,
} from '../admin/common.tsx';
import { useServices } from '../env.tsx';
import { typeGloss } from '../gl/gl-logic.ts';
import { AR_READERS, STATUS_WORD, useCompany } from './InvoicesPage.tsx';

function Region({ heading, children }: { heading: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="admin-block" aria-labelledby={id}>
      <h2 id={id}>{heading}</h2>
      {children}
    </section>
  );
}

/** NUMERIC text without trailing fractional zeros: 10.0000 → 10, 1.2500 → 1.25 (never 10 → 1). */
export const quantityText = (q: string): string =>
  q.includes('.') ? q.replace(/0+$/, '').replace(/\.$/, '') : q;

const refusalText = (e: unknown): string | null =>
  e instanceof AdminApiError && e.status === 422 && typeof e.body['message'] === 'string'
    ? e.body['message']
    : null;

export function InvoicePage({ invoiceId }: { invoiceId: string }) {
  const access = useAccess();
  const { sales } = useServices();
  const canRead = access.can('ar.read');
  const company = useCompany();
  const companyId = company.company?.id ?? '';
  const [wantJournal, setWantJournal] = useState(false);
  const doc = useQuery({
    queryKey: ['ar', 'invoice', invoiceId],
    queryFn: () => sales.invoice(companyId, invoiceId),
    enabled: canRead && !!companyId,
  });
  const journal = useQuery({
    queryKey: ['ar', 'invoice', invoiceId, 'journal'],
    queryFn: () => sales.journal(companyId, invoiceId),
    enabled: wantJournal && !!companyId,
    retry: false,
  });
  useFailureRouting(doc.error ?? company.error);

  if (access.isPending || (canRead && (company.isPending || doc.isPending)))
    return <Loading what="the invoice" />;
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
      <Forbidden heading="You can't see invoices">
        You do not have access to invoices. {AR_READERS} can see them; ask your Owner if you need
        to.
      </Forbidden>
    );
  if (doc.isError || !doc.data)
    return (
      <Failure
        heading="We could not load this invoice"
        error={doc.error}
        onRetry={() => void doc.refetch()}
      />
    );

  const inv = doc.data;
  const title = inv.invoice_no ? `Invoice ${inv.invoice_no}` : `${STATUS_WORD[inv.status]} invoice`;
  const refused = refusalText(journal.error);
  return (
    <>
      <PageHead
        title={title}
        gloss={`To ${inv.party_name}, issued ${inv.issue_date}, due ${inv.due_date}. Prices ${inv.pricing === 'inclusive' ? 'include' : 'exclude'} GST.`}
      />

      <Region heading="Lines">
        <table className="admin-table" aria-label="Invoice lines">
          <thead>
            <tr>
              <th scope="col">Description</th>
              <th scope="col" className="num">
                Quantity
              </th>
              <th scope="col" className="num">
                Unit price
              </th>
              <th scope="col" className="num">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {inv.lines.map((l) => (
              <tr key={l.line_no}>
                <td data-label="Description">{l.description}</td>
                <td data-label="Quantity" className="num">
                  {quantityText(l.quantity)}
                </td>
                <td data-label="Unit price" className="num">
                  <Money value={l.unit_price} />
                </td>
                <td data-label="Amount" className="num">
                  {l.gross ? <Money value={l.gross} /> : 'Priced when approved'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Region>

      <Region heading="Journal">
        {inv.status !== 'draft' ? (
          <p className="admin-note">
            This invoice is {STATUS_WORD[inv.status].toLowerCase()}; its journal is in the general
            ledger.
          </p>
        ) : !wantJournal ? (
          <button type="button" className="primary" onClick={() => setWantJournal(true)}>
            Show me the journal
          </button>
        ) : journal.isPending ? (
          <Loading what="the journal LedgerForce would post" />
        ) : journal.isSuccess ? (
          <>
            <p className="admin-note">
              This is the journal LedgerForce would post when the invoice is approved, from the
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
      <p className="admin-note">
        <Link to="/sales/invoices">All invoices</Link>
      </p>
    </>
  );
}
