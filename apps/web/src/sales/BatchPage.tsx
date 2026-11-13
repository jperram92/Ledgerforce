/**
 * One batch billing run (T-0084, UC-02 steps 2–3, SS-UC02-08): the preview totals, the exception
 * list (warnings before the run, failures after it, each with what happens next) and every
 * invoice with its result. Approving needs ar.batch.approve and starts the job that posts each
 * invoice on its own (T-0044); this page never posts or computes anything itself: totals and
 * amounts are the API's decimal strings.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Money } from '@ledgerforce/ui';
import { useId, type ReactNode } from 'react';
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
import { batchTitle, exceptionsOf, itemResult, rolesWith } from './batch-logic.ts';
import type { Batch } from './client.ts';
import { AR_READERS, useCompany } from './InvoicesPage.tsx';

export const batchKey = (id: string) => ['ar', 'batch', id] as const;

const STATUS_WORD: Record<Batch['status'], string> = {
  preview: 'Preview',
  approved: 'Approved',
  posted: 'Posted',
  cancelled: 'Cancelled',
};

function Region({ heading, children }: { heading: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="admin-block" aria-labelledby={id}>
      <h2 id={id}>{heading}</h2>
      {children}
    </section>
  );
}

const Amount = ({ value }: { value: string | null }) =>
  value === null ? <>Not priced</> : <Money value={value} />;

function gloss(b: Batch): string {
  const n = String(b.totals.invoices);
  switch (b.status) {
    case 'preview':
      return `A preview of ${n} invoices dated ${b.issue_date}. Nothing is posted yet.`;
    case 'approved':
      return `Approved. One job posts each of the ${n} invoices on its own; one failure does not stop the others.`;
    case 'posted':
      return `The job has run: ${String(b.outcome.posted)} of ${n} invoices posted, dated ${b.issue_date}.`;
    case 'cancelled':
      return 'This batch was cancelled. Nothing from it was posted.';
  }
}

function approvalRefusal(error: unknown): ReactNode {
  if (error instanceof AdminApiError && error.code === 'BATCH_STATE') {
    return (
      <p className="refusal" role="alert">
        This batch is no longer waiting for approval: someone has approved it already. Reload the
        page to see where it is now.
      </p>
    );
  }
  return <Refusal error={error} />;
}

export function BatchPage({ batchId }: { batchId: string }) {
  const access = useAccess();
  const { sales } = useServices();
  const queryClient = useQueryClient();
  const canRead = access.can('ar.read');
  const canApprove = access.can('ar.batch.approve');
  const company = useCompany();
  const companyId = company.company?.id ?? '';
  const doc = useQuery({
    queryKey: batchKey(batchId),
    queryFn: () => sales.batch(companyId, batchId),
    enabled: canRead && !!companyId,
  });
  const approve = useMutation({
    mutationFn: () => sales.approveBatch(companyId, batchId),
    onSuccess: (b) => {
      queryClient.setQueryData(batchKey(batchId), b);
    },
  });
  useFailureRouting(doc.error ?? company.error ?? approve.error);

  let body: ReactNode;
  let title = 'Batch billing';
  let sub = 'One batch billing run.';
  if (access.isPending || (canRead && (company.isPending || doc.isPending)))
    body = <Loading what="the batch" />;
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
      <Forbidden heading="You can't see batch billing">
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
  else if (doc.isError || !doc.data)
    body = (
      <Failure
        heading="We could not load this batch"
        error={doc.error}
        onRetry={() => void doc.refetch()}
      />
    );
  else {
    const b = doc.data;
    title = batchTitle(b.period_from, b.period_to);
    sub = gloss(b);
    const exceptions = exceptionsOf(b.items);
    const ran = b.status === 'posted';
    body = (
      <>
        <Region heading="Totals">
          <p className="bb-state">
            Status{' '}
            <span className="word" data-status={b.status}>
              {STATUS_WORD[b.status]}
            </span>
          </p>
          <dl className="bb-totals">
            <div>
              <dt>Invoices</dt>
              <dd>
                {ran
                  ? `${String(b.outcome.posted)} of ${String(b.totals.invoices)} posted`
                  : `${String(b.totals.ready)} of ${String(b.totals.invoices)} ready`}
              </dd>
            </div>
            <div>
              <dt>{ran ? 'Before GST, previewed' : 'Before GST'}</dt>
              <dd>
                <Money value={b.totals.net} />
              </dd>
            </div>
            <div>
              <dt>{ran ? 'GST, previewed' : 'GST'}</dt>
              <dd>
                <Money value={b.totals.tax} />
              </dd>
            </div>
            <div>
              <dt>{ran ? 'Total previewed' : 'Total to invoice'}</dt>
              <dd>
                <Money value={b.totals.gross} />
              </dd>
            </div>
            {ran ? (
              <div>
                <dt>Total posted</dt>
                <dd>
                  <Money value={b.outcome.posted_gross} />
                </dd>
              </div>
            ) : null}
          </dl>
          <p className="admin-note">Amounts in {company.company.base_currency}.</p>
          {b.status === 'preview' && canApprove ? (
            <div className="bb-approve">
              <p id="bb-approve-what">
                Approving starts one job that posts each invoice in its own step and emails it to
                the customer&apos;s Billing To contact. An invoice that fails lands in the exception
                list; the others still post.
              </p>
              <button
                type="button"
                className="primary"
                aria-describedby="bb-approve-what"
                disabled={approve.isPending}
                onClick={() => {
                  approve.mutate();
                }}
              >
                Approve and post {String(b.totals.ready)} invoices
              </button>
              {approvalRefusal(approve.error)}
            </div>
          ) : b.status === 'preview' ? (
            <p className="turn">
              Waiting for approval by the {rolesWith('ar.batch.approve', 'or')}. Send them this
              page.
            </p>
          ) : b.status === 'approved' ? (
            <p className="done" role="status">
              Approved. The job is posting the invoices; reload this page to see each result.
            </p>
          ) : null}
        </Region>

        <Region heading="Exceptions">
          {exceptions.length === 0 ? (
            <p className="admin-note">
              {ran
                ? 'No exceptions: every invoice posted.'
                : 'No exceptions: every invoice is ready.'}
            </p>
          ) : (
            <table className="admin-table" aria-label="Exceptions">
              <thead>
                <tr>
                  <th scope="col">Customer</th>
                  <th scope="col">Result</th>
                  <th scope="col">Issue</th>
                  <th scope="col">What happens</th>
                  <th scope="col" className="num">
                    Total
                  </th>
                </tr>
              </thead>
              <tbody>
                {exceptions.map((x) => {
                  const r = itemResult(x.item);
                  return (
                    <tr key={x.item.item_no}>
                      <td data-label="Customer">{x.item.party_name}</td>
                      <td data-label="Result">
                        <span className="word" data-status={r.status}>
                          {r.word}
                        </span>
                      </td>
                      <td data-label="Issue">{x.issue}</td>
                      <td data-label="What happens">{x.next}</td>
                      <td data-label="Total" className="num">
                        <Amount value={x.item.gross} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Region>

        <Region heading="Invoices in this batch">
          <table className="admin-table" aria-label="Invoices in this batch">
            <thead>
              <tr>
                <th scope="col">Customer</th>
                <th scope="col" className="num">
                  Lines
                </th>
                <th scope="col">Result</th>
                <th scope="col" className="num">
                  Before GST
                </th>
                <th scope="col" className="num">
                  GST
                </th>
                <th scope="col" className="num">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {b.items.map((i) => {
                const r = itemResult(i);
                return (
                  <tr key={i.item_no}>
                    <td data-label="Customer">{i.party_name}</td>
                    <td data-label="Lines" className="num">
                      {String(i.line_count)}
                    </td>
                    <td data-label="Result">
                      <span className="word" data-status={r.status}>
                        {r.word}
                      </span>
                    </td>
                    <td data-label="Before GST" className="num">
                      <Amount value={i.net} />
                    </td>
                    <td data-label="GST" className="num">
                      <Amount value={i.tax} />
                    </td>
                    <td data-label="Total" className="num">
                      <Amount value={i.gross} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Region>
      </>
    );
  }

  return (
    <>
      <PageHead title={title} gloss={sub} />
      {body}
      <p className="admin-note">
        <Link to="/sales/batches">Batch billing</Link>
      </p>
    </>
  );
}
