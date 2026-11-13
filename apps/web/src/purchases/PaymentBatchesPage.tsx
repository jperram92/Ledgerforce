/**
 * Supplier payment batches (T-0087, UC-06): every batch of the company, newest first, with its
 * state in words, how many releases it has of how many it needs, and how many bills were left
 * out. Opening one leads to the release screen. Batches are built from due bills by the AP Clerk
 * (T-0054); the list only reads (GET /ap/payment-batches, T-0153).
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
import { dayLabel } from '../admin/dates.ts';
import { useServices } from '../env.tsx';
import { AP_READERS, useApCompany } from './BillsPage.tsx';
import { BATCH_STATUS_WORD } from './payments-logic.ts';

export function PaymentsForbidden() {
  return (
    <Forbidden heading="You can't see payment batches">
      You do not have access to supplier payments. {AP_READERS} can see them; ask your Owner if you
      need to.
    </Forbidden>
  );
}

export function PaymentBatchesPage() {
  const access = useAccess();
  const { payments } = useServices();
  const canRead = access.can('ap.read');
  const company = useApCompany();
  const companyId = company.company?.id ?? '';
  const list = useQuery({
    queryKey: ['ap', 'payment-batches', companyId],
    queryFn: () => payments.batches(companyId),
    enabled: canRead && !!companyId,
  });
  useFailureRouting(list.error ?? company.error);

  let body;
  if (access.isPending || (canRead && (company.isPending || list.isPending)))
    body = <Loading what="payment batches" />;
  else if (access.isError)
    body = (
      <Failure
        heading="We could not check what you may do"
        error={access.error}
        onRetry={() => void access.refetch()}
      />
    );
  else if (!canRead) body = <PaymentsForbidden />;
  else if (list.isError || !list.data)
    body = (
      <Failure
        heading="We could not load the payment batches"
        error={list.error ?? company.error}
        onRetry={() => void (list.isError ? list.refetch() : company.refetch())}
      />
    );
  else if (list.data.batches.length === 0)
    body = (
      <Empty heading="No payment batches yet">
        A batch appears here when the AP Clerk builds one from the bills that are due.
      </Empty>
    );
  else
    body = (
      <div className="admin-block">
        <table className="admin-table" aria-label="Payment batches">
          <thead>
            <tr>
              <th scope="col">Batch</th>
              <th scope="col">Pays on</th>
              <th scope="col">State</th>
              <th scope="col">Releases</th>
              <th scope="col">Bills</th>
              <th scope="col">Built by</th>
              <th scope="col" className="num">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {list.data.batches.map((b) => (
              <tr key={b.id}>
                <td data-label="Batch">
                  <Link to="/purchases/payment-batches/$batchId" params={{ batchId: b.id }}>
                    {b.batch_no}
                  </Link>
                </td>
                <td data-label="Pays on">{dayLabel(b.payment_date)}</td>
                <td data-label="State">
                  <span className="word" data-status={b.status}>
                    {BATCH_STATUS_WORD[b.status]}
                  </span>
                </td>
                <td data-label="Releases">
                  {b.release_count} of {b.releases_required}
                </td>
                <td data-label="Bills">
                  {b.payment_count} paid
                  {b.excluded_count > 0 ? `, ${String(b.excluded_count)} left out` : ''}
                </td>
                <td data-label="Built by">{b.created_by_name ?? 'Unknown'}</td>
                <td data-label="Total" className="num">
                  <Money value={b.total} />
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
        title="Payment batches"
        gloss="Payments to suppliers, grouped into batches. Someone other than the person who built a batch releases it, with a second sign-in step."
      />
      {body}
      <p className="admin-note">
        <Link to="/purchases/bank-details">Supplier bank details to verify</Link>
      </p>
    </>
  );
}
