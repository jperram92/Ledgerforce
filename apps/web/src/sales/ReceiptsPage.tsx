/**
 * Receipts waiting to be allocated (T-0085, UC-03, SS-UC03-10). The AR Clerk picks a receipt,
 * chooses one of that customer's posted invoices and allocates; the ledger (T-0046, T-0151)
 * decides whether the amount fits and the invoice's payment status is read back from the API.
 * Nothing is computed here: amounts are the API's decimal strings, the amount field starts as the
 * receipt's unallocated amount and the API refuses anything that does not fit (OVER_ALLOCATED).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Money } from '@ledgerforce/ui';
import { useId, useState, type FormEvent } from 'react';
import { AdminApiError } from '../admin/client.ts';
import {
  Empty,
  Failure,
  Forbidden,
  Loading,
  PageHead,
  Refusal,
  useAccess,
  useFailureRouting,
} from '../admin/common.tsx';
import { useServices } from '../env.tsx';
import { amountInput, invoicesFor, PAYMENT_WORD } from './cash-logic.ts';
import type { ReceiptRow } from './client.ts';
import { AR_READERS, useCompany } from './InvoicesPage.tsx';

const METHOD_WORD: Record<ReceiptRow['method'], string> = {
  eft: 'Bank transfer',
  cheque: 'Cheque',
  cash: 'Cash',
  card: 'Card',
};
const newKey = () => `alloc-${crypto.randomUUID()}`;
const receiptsKey = (companyId: string) => ['ar', 'receipts', companyId] as const;

/** Where the last allocation left its invoice, read back from the API. */
interface Done {
  invoiceId: string;
  invoiceNo: string;
}

export function ReceiptsPage() {
  const access = useAccess();
  const { sales } = useServices();
  const canRead = access.can('ar.read');
  const canAllocate = access.can('ar.receipt.record');
  const company = useCompany();
  const companyId = company.company?.id ?? '';
  const [chosen, setChosen] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const list = useQuery({
    queryKey: receiptsKey(companyId),
    queryFn: () => sales.receipts(companyId),
    enabled: canRead && !!companyId,
  });
  useFailureRouting(list.error ?? company.error);

  let body;
  if (access.isPending || (canRead && (company.isPending || list.isPending)))
    body = <Loading what="receipts" />;
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
      <Forbidden heading="You can't see receipts">
        You do not have access to receipts. {AR_READERS} can see them; ask your Owner if you need
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
  else if (list.isError)
    body = (
      <Failure
        heading="We could not load the receipts"
        error={list.error}
        onRetry={() => void list.refetch()}
      />
    );
  else {
    const receipts = list.data?.receipts ?? [];
    const receipt = receipts.find((r) => r.id === chosen);
    body = (
      <>
        {done ? <PaidNote companyId={companyId} done={done} /> : null}
        {receipts.length === 0 ? (
          <Empty heading="No receipts waiting">
            Every receipt is allocated to an invoice. Receipts appear here when money arrives that
            is not yet matched to an invoice.
          </Empty>
        ) : (
          <div className="admin-block">
            <table className="admin-table" aria-label="Receipts waiting to be allocated">
              <thead>
                <tr>
                  <th scope="col">Received</th>
                  <th scope="col">Receipt</th>
                  <th scope="col">Customer</th>
                  <th scope="col" className="num">
                    Amount
                  </th>
                  <th scope="col" className="num">
                    Not yet allocated
                  </th>
                  {canAllocate ? <th scope="col">Action</th> : null}
                </tr>
              </thead>
              <tbody>
                {receipts.map((r) => (
                  <tr key={r.id}>
                    <td data-label="Received">{r.receipt_date}</td>
                    <td data-label="Receipt">
                      {r.receipt_no}
                      <br />
                      <span className="admin-note">
                        {METHOD_WORD[r.method]}
                        {r.reference ? `, ${r.reference}` : ''}
                      </span>
                    </td>
                    <td data-label="Customer">{r.party_name}</td>
                    <td data-label="Amount" className="num">
                      <Money value={r.amount} />
                    </td>
                    <td data-label="Not yet allocated" className="num">
                      <Money value={r.unallocated} />
                    </td>
                    {canAllocate ? (
                      <td data-label="Action">
                        <button
                          type="button"
                          className="secondary"
                          aria-pressed={chosen === r.id}
                          onClick={() => {
                            setChosen(r.id);
                            setDone(null);
                          }}
                        >
                          Allocate {r.receipt_no}
                        </button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
            {!canAllocate ? (
              <p className="admin-note">
                AR Clerks, Finance Admins and Owners allocate receipts to invoices.
              </p>
            ) : null}
          </div>
        )}
        {receipt && canAllocate ? (
          <AllocateForm
            key={receipt.id}
            companyId={companyId}
            receipt={receipt}
            onDone={(d) => {
              setChosen(null);
              setDone(d);
            }}
          />
        ) : null}
      </>
    );
  }

  return (
    <>
      <PageHead
        title="Receipts"
        gloss="Money customers paid that is not yet matched to an invoice. Allocate it and the invoice shows as paid."
      />
      {body}
      <p className="admin-note">
        <Link to="/sales/invoices">All invoices</Link>
      </p>
    </>
  );
}

function PaidNote({ companyId, done }: { companyId: string; done: Done }) {
  const { sales } = useServices();
  const status = useQuery({
    queryKey: ['ar', 'invoice', done.invoiceId, 'payment-status'],
    queryFn: () => sales.paymentStatus(companyId, done.invoiceId),
  });
  if (!status.data) return null;
  return (
    <p className="admin-state" role="status">
      Allocated. {done.invoiceNo} is now{' '}
      <span className="word" data-status={status.data.status}>
        {PAYMENT_WORD[status.data.status]}
      </span>
      .
    </p>
  );
}

function AllocateForm({
  companyId,
  receipt,
  onDone,
}: {
  companyId: string;
  receipt: ReceiptRow;
  onDone: (d: Done) => void;
}) {
  const { sales } = useServices();
  const queryClient = useQueryClient();
  const headingId = useId();
  const invoices = useQuery({
    queryKey: ['ar', 'invoices', companyId, 'posted'],
    queryFn: () => sales.invoices(companyId, 'posted'),
  });
  const options = invoicesFor(invoices.data?.invoices ?? [], receipt.party_id);
  const [picked, setPicked] = useState('');
  const invoiceId = picked || options[0]?.id || '';
  const invoice = options.find((i) => i.id === invoiceId);
  const [amount, setAmount] = useState(() => amountInput(receipt.unallocated));
  const [date, setDate] = useState(receipt.receipt_date);
  const [key, setKey] = useState(newKey);
  const status = useQuery({
    queryKey: ['ar', 'invoice', invoiceId, 'payment-status'],
    queryFn: () => sales.paymentStatus(companyId, invoiceId),
    enabled: !!invoiceId,
  });
  const allocate = useMutation({
    mutationFn: () =>
      sales.allocate(
        receipt.id,
        { company_id: companyId, invoice_id: invoiceId, amount, allocation_date: date },
        key,
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['ar', 'invoice', invoiceId] });
      await queryClient.invalidateQueries({ queryKey: receiptsKey(companyId) });
      onDone({ invoiceId, invoiceNo: invoice?.invoice_no ?? '' });
    },
    // A refused allocation wrote nothing; the next try is a new request.
    onError: () => setKey(newKey()),
  });
  useFailureRouting(allocate.error ?? invoices.error);
  const change = (set: (v: string) => void) => (v: string) => {
    set(v);
    setKey(newKey());
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    allocate.mutate();
  };
  const refused =
    allocate.error instanceof AdminApiError &&
    allocate.error.status === 422 &&
    typeof allocate.error.body['message'] === 'string'
      ? allocate.error.body['message']
      : null;

  return (
    <section className="admin-block" aria-labelledby={headingId}>
      <h2 id={headingId}>Allocate {receipt.receipt_no}</h2>
      <p>
        {receipt.party_name} paid <Money value={receipt.unallocated} /> that is not yet matched to
        an invoice. Choose which of their invoices it pays.
      </p>
      {invoices.isPending ? (
        <Loading what={`${receipt.party_name}'s invoices`} />
      ) : invoices.isError ? (
        <Failure
          heading="We could not load the invoices"
          error={invoices.error}
          onRetry={() => void invoices.refetch()}
        />
      ) : options.length === 0 ? (
        <p className="admin-note">
          {receipt.party_name} has no posted invoice to allocate this receipt to. It stays as their
          credit until one is posted.
        </p>
      ) : (
        <form className="admin-form" onSubmit={submit} noValidate>
          <label htmlFor="alloc-invoice">Invoice</label>
          <select
            id="alloc-invoice"
            value={invoiceId}
            onChange={(e) => change(setPicked)(e.target.value)}
          >
            {options.map((i) => (
              <option key={i.id} value={i.id}>
                {i.invoice_no}, due {i.due_date}
              </option>
            ))}
          </select>
          {status.data ? (
            <p className="admin-note" id="alloc-open">
              {invoice?.invoice_no} is{' '}
              <span className="word" data-status={status.data.status}>
                {PAYMENT_WORD[status.data.status]}
              </span>
              ; still owing <Money value={status.data.open} />.
            </p>
          ) : null}
          <label htmlFor="alloc-amount">Amount</label>
          <input
            id="alloc-amount"
            inputMode="decimal"
            autoComplete="off"
            required
            value={amount}
            onChange={(e) => change(setAmount)(e.target.value)}
          />
          <label htmlFor="alloc-date">Date</label>
          <input
            id="alloc-date"
            type="date"
            required
            value={date}
            onChange={(e) => change(setDate)(e.target.value)}
          />
          <button type="submit" className="primary" disabled={allocate.isPending || !invoiceId}>
            Allocate to {invoice?.invoice_no}
          </button>
          {refused ? (
            <p className="refusal" role="alert">
              We could not allocate this receipt: {refused}
            </p>
          ) : (
            <Refusal error={allocate.error} />
          )}
        </form>
      )}
    </section>
  );
}
