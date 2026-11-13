/**
 * Invoices list (T-0083, UC-01): every invoice of the company, newest first, with its status in a
 * plain word (P2) and the total once posted. Readers: ar.read. Drafts have no number yet, so they
 * are named by customer.
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Money } from '@ledgerforce/ui';
import {
  Empty,
  Failure,
  Forbidden,
  Loading,
  PageHead,
  useAccess,
  useFailureRouting,
} from '../admin/common.tsx';
import { useServices } from '../env.tsx';
import type { InvoiceRow } from './client.ts';

export const STATUS_WORD: Record<InvoiceRow['status'], string> = {
  draft: 'Draft',
  posted: 'Posted',
  void: 'Void',
};
export const AR_READERS = 'Owners, Finance Admins, Accountants, AR Clerks and Auditors';

export function useCompany() {
  const { sales } = useServices();
  const q = useQuery({ queryKey: ['companies'], queryFn: () => sales.companies() });
  return { ...q, company: q.data?.[0] };
}

export const invoiceName = (i: Pick<InvoiceRow, 'invoice_no' | 'status' | 'party_name'>) =>
  i.invoice_no
    ? `${i.invoice_no}, ${i.party_name}`
    : `${STATUS_WORD[i.status]} invoice for ${i.party_name}`;

export function InvoicesPage() {
  const access = useAccess();
  const { sales } = useServices();
  const canRead = access.can('ar.read');
  const company = useCompany();
  const list = useQuery({
    queryKey: ['ar', 'invoices', company.company?.id ?? ''],
    queryFn: () => sales.invoices(company.company?.id ?? ''),
    enabled: canRead && !!company.company,
  });
  useFailureRouting(list.error ?? company.error);

  let body;
  if (access.isPending || (canRead && company.isPending)) body = <Loading what="invoices" />;
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
      <Forbidden heading="You can't see invoices">
        You do not have access to invoices. {AR_READERS} can see them; ask your Owner if you need
        to.
      </Forbidden>
    );
  else if (company.isError || !company.company)
    body = (
      <Failure
        heading="We could not find your company"
        error={company.error}
        onRetry={() => void company.refetch()}
      />
    );
  else if (list.isPending) body = <Loading what="invoices" />;
  else if (list.isError)
    body = (
      <Failure
        heading="We could not load the invoices"
        error={list.error}
        onRetry={() => void list.refetch()}
      />
    );
  else if (list.data.invoices.length === 0)
    body = (
      <Empty heading="No invoices yet">
        Invoices appear here when a deal is closed won in Salesforce or someone creates one.
      </Empty>
    );
  else
    body = (
      <div className="admin-block">
        <table className="admin-table" aria-label="Invoices">
          <thead>
            <tr>
              <th scope="col">Issued</th>
              <th scope="col">Invoice</th>
              <th scope="col">Status</th>
              <th scope="col">Due</th>
              <th scope="col" className="num">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {list.data.invoices.map((i) => (
              <tr key={i.id}>
                <td data-label="Issued">{i.issue_date}</td>
                <td data-label="Invoice">
                  <Link to="/sales/invoices/$invoiceId" params={{ invoiceId: i.id }}>
                    {invoiceName(i)}
                  </Link>
                </td>
                <td data-label="Status">
                  <span className="word" data-status={i.status}>
                    {STATUS_WORD[i.status]}
                  </span>
                </td>
                <td data-label="Due">{i.due_date}</td>
                <td data-label="Total" className="num">
                  {i.gross_total ? <Money value={i.gross_total} /> : 'Not priced yet'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );

  return (
    <>
      <PageHead
        title="Invoices"
        gloss="Tax invoices to customers (accounts receivable): drafts, posted and void."
      />
      {body}
    </>
  );
}
