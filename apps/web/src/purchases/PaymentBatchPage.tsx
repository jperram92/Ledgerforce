/**
 * Release a supplier payment batch (T-0087, UC-06 step 2, SS-UC06-10, design §6.2, §6.5 rule 1).
 * Shows who is paid, to which account (masked to the last 3 digits, §6.6), how much, and which
 * bills were left out and why (cooling-off after a bank-detail change, or no verified details).
 * The release button is for people with ap.payment_batch.release; before they press it the screen
 * says when a separation-of-duties rule will stop them (they built the batch, or already gave the
 * first of two releases). Pressing it calls the API, which runs the SoD engine and asks for a
 * fresh step-up: a `step_up_required` answer shows the step-up prompt; a `sod_violation` answer is
 * explained in plain words. Nothing here decides; the API does (P6).
 *
 * Once released, a releaser downloads the bank (ABA) file (T-0154, UC-06 step 3): a POST the API
 * audits (T-0056), saved as a file and never shown, since it holds the full account numbers. The
 * action follows the same rules as the release: hidden without ap.payment_batch.release, a
 * step-up answer shows the prompt, and refusals (including separation-of-duties) are explained.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Money } from '@ledgerforce/ui';
import { useId, useState, type ReactNode } from 'react';
import { Failure, Loading, PageHead, useAccess, useFailureRouting } from '../admin/common.tsx';
import { dayLabel, timeLabel } from '../admin/dates.ts';
import { useServices } from '../env.tsx';
import { useApCompany } from './BillsPage.tsx';
import { PaymentsForbidden } from './PaymentBatchesPage.tsx';
import type { Batch } from './payments-client.ts';
import {
  accountLabel,
  bankFileRefusalWords,
  BATCH_STATUS_WORD,
  exclusionText,
  refusalWords,
  releaseOutlook,
  releaseProgress,
  sodWords,
  STEP_UP_WHY_BANK_FILE,
  STEP_UP_WHY_RELEASE,
} from './payments-logic.ts';
import { isStepUp, StepUpPrompt, useMutationFailureRouting } from './StepUpPrompt.tsx';

function Region({ heading, children }: { heading: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="admin-block" aria-labelledby={id}>
      <h2 id={id}>{heading}</h2>
      {children}
    </section>
  );
}

export function PaymentBatchPage({ batchId }: { batchId: string }) {
  const access = useAccess();
  const { payments } = useServices();
  const canRead = access.can('ap.read');
  const company = useApCompany();
  const companyId = company.company?.id ?? '';
  const doc = useQuery({
    queryKey: ['ap', 'payment-batch', batchId],
    queryFn: () => payments.batch(companyId, batchId),
    enabled: canRead && !!companyId,
  });
  useFailureRouting(doc.error ?? company.error);

  if (access.isPending || (canRead && (company.isPending || doc.isPending)))
    return <Loading what="the payment batch" />;
  if (access.isError)
    return (
      <Failure
        heading="We could not check what you may do"
        error={access.error}
        onRetry={() => void access.refetch()}
      />
    );
  if (!canRead) return <PaymentsForbidden />;
  if (doc.isError || !doc.data)
    return (
      <Failure
        heading="We could not load this payment batch"
        error={doc.error ?? company.error}
        onRetry={() => void doc.refetch()}
      />
    );
  return <BatchView batch={doc.data} companyId={companyId} can={access.can} />;
}

function BatchView({
  batch,
  companyId,
  can,
}: {
  batch: Batch;
  companyId: string;
  can: (p: string) => boolean;
}) {
  return (
    <>
      <PageHead
        title={`Payment batch ${batch.batch_no}`}
        gloss={`Pays ${String(batch.payment_count)} bill${batch.payment_count === 1 ? '' : 's'} on ${dayLabel(batch.payment_date)}. Amounts in AUD.`}
      />
      <p className="admin-note">
        <span className="word" data-status={batch.status}>
          {BATCH_STATUS_WORD[batch.status]}
        </span>{' '}
        Total <Money value={batch.total} />
      </p>
      <Release batch={batch} companyId={companyId} can={can} />
      <BankFile batch={batch} companyId={companyId} can={can} />

      <Region heading="Payments in this batch">
        <table className="admin-table" aria-label="Payments in this batch">
          <thead>
            <tr>
              <th scope="col">Supplier</th>
              <th scope="col">Bill</th>
              <th scope="col">Paid to</th>
              <th scope="col" className="num">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {batch.payments.map((p) => (
              <tr key={p.bill_id}>
                <td data-label="Supplier">{p.party_name ?? 'Unnamed supplier'}</td>
                <td data-label="Bill">
                  <Link to="/purchases/bills/$billId" params={{ billId: p.bill_id }}>
                    {p.bill_no ?? 'Bill'}
                  </Link>
                </td>
                <td data-label="Paid to">
                  {p.bank_account ? accountLabel(p.bank_account) : 'Verified account'}
                </td>
                <td data-label="Amount" className="num">
                  <Money value={p.amount} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Region>

      <Region heading="Left out of this batch">
        {batch.excluded.length === 0 ? (
          <p className="admin-note">Every bill that was due is in this batch.</p>
        ) : (
          <>
            <p className="admin-note">
              These bills were due but are not paid in this batch. They stay due and go into a later
              batch once the reason is cleared.
            </p>
            <table className="admin-table" aria-label="Left out of this batch">
              <thead>
                <tr>
                  <th scope="col">Supplier</th>
                  <th scope="col">Bill</th>
                  <th scope="col">Why</th>
                  <th scope="col" className="num">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {batch.excluded.map((x) => (
                  <tr key={x.bill_id}>
                    <td data-label="Supplier">{x.party_name ?? 'Unnamed supplier'}</td>
                    <td data-label="Bill">{x.bill_no ?? 'Bill'}</td>
                    <td data-label="Why">{exclusionText(x.reason, x.payable_from)}</td>
                    <td data-label="Amount" className="num">
                      <Money value={x.amount} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Region>
      <p className="admin-note">
        <Link to="/purchases/payment-batches">All payment batches</Link>
      </p>
    </>
  );
}

function Release({
  batch,
  companyId,
  can,
}: {
  batch: Batch;
  companyId: string;
  can: (p: string) => boolean;
}) {
  const { payments, api } = useServices();
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ['auth', 'me'], queryFn: () => api.me() });
  const whyId = useId();
  const [prompting, setPrompting] = useState(false);
  const release = useMutation({
    mutationFn: () => payments.release(companyId, batch.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['ap', 'payment-batch', batch.id] });
      await queryClient.invalidateQueries({ queryKey: ['ap', 'payment-batches'] });
    },
    onError: (e) => setPrompting(isStepUp(e)),
  });
  useMutationFailureRouting(release.error);
  const outlook = releaseOutlook(batch, me.data?.user_id);
  const two = batch.releases_required === 2;
  const releasedByMe = release.isSuccess && !release.isPending;

  let action: ReactNode;
  if (outlook.why === 'done') action = null;
  else if (!can('ap.payment_batch.release'))
    action = (
      <p className="admin-note">
        An Approver or the Owner releases payment batches. You can see this batch but not release
        it.
      </p>
    );
  else if (prompting && isStepUp(release.error))
    action = (
      <StepUpPrompt
        error={release.error}
        why={STEP_UP_WHY_RELEASE}
        onCancel={() => {
          setPrompting(false);
          release.reset();
        }}
      />
    );
  else {
    const blocked = !outlook.allowed;
    action = (
      <div className="gl-actions-col">
        {blocked && outlook.why !== null ? (
          <p id={whyId} className="admin-note">
            {sodWords(outlook.why)}
          </p>
        ) : null}
        <div className="gl-actions">
          <button
            type="button"
            className="primary"
            disabled={blocked || release.isPending || me.isPending}
            {...(blocked ? { 'aria-describedby': whyId } : {})}
            onClick={() => release.mutate()}
          >
            Release payment batch
          </button>
        </div>
        {release.isError && !isStepUp(release.error) ? (
          <p className="refusal" role="alert">
            {refusalWords(release.error)}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <Region heading="Release">
      <ul className="gl-people" aria-label="People involved">
        <li>Built by {batch.created_by_name ?? 'someone no longer listed'}</li>
        {batch.releases.map((r, i) => (
          <li key={`${r.released_at}-${String(i)}`}>
            Released by {r.released_by_name ?? 'someone no longer listed'}
            {me.data && r.released_by === me.data.user_id ? ' (you)' : ''},{' '}
            {timeLabel(r.released_at)}
          </li>
        ))}
      </ul>
      <p className="admin-note">
        {releaseProgress(batch)}.{' '}
        {two
          ? 'This batch is over the two-person limit, so it needs two different people to release it, neither of them the person who built it.'
          : 'One person who did not build it releases it.'}
      </p>
      {releasedByMe ? (
        <p role="status" className="admin-note">
          You released {batch.batch_no}.{' '}
          {batch.status === 'released'
            ? 'It is released: the bank file can now be made and sent to the bank.'
            : 'It now waits for a second person to release it.'}
        </p>
      ) : null}
      {action}
    </Region>
  );
}

/** Hands the browser the file to save; the bytes are never read or shown here. */
function saveFile(fileName: string, content: Blob): void {
  const url = URL.createObjectURL(content);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

function BankFile({
  batch,
  companyId,
  can,
}: {
  batch: Batch;
  companyId: string;
  can: (p: string) => boolean;
}) {
  const { payments } = useServices();
  const [prompting, setPrompting] = useState(false);
  const [made, setMade] = useState<{ fileName: string; at: string } | null>(null);
  const file = useMutation({
    mutationFn: () => payments.abaFile(companyId, batch.id, batch.batch_no),
    onMutate: () => setMade(null),
    onSuccess: (f) => {
      saveFile(f.fileName, f.content);
      setMade({ fileName: f.fileName, at: new Date().toISOString() });
    },
    onError: (e) => setPrompting(isStepUp(e)),
  });
  useMutationFailureRouting(file.error);

  let body: ReactNode;
  if (batch.status === 'cancelled')
    body = <p className="admin-note">This batch was cancelled, so it has no bank file.</p>;
  else if (batch.status !== 'released')
    body = (
      <p className="admin-note">
        The bank file can be made once the batch is released. It is the file you upload to your
        bank’s business banking to make the payments.
      </p>
    );
  else if (!can('ap.payment_batch.release'))
    body = (
      <p className="admin-note">
        An Approver or the Owner downloads the bank file. It holds full account numbers, so only the
        people who release payments can have it.
      </p>
    );
  else if (prompting && isStepUp(file.error))
    body = (
      <StepUpPrompt
        error={file.error}
        why={STEP_UP_WHY_BANK_FILE}
        onCancel={() => {
          setPrompting(false);
          file.reset();
        }}
      />
    );
  else
    body = (
      <div className="gl-actions-col">
        <p className="admin-note">
          The bank file (ABA) holds the full account numbers of everyone paid in this batch. Upload
          it to your bank’s business banking; do not email it or keep copies. Each download is
          recorded in the audit log.
        </p>
        <div className="gl-actions">
          <button
            type="button"
            className="primary"
            disabled={file.isPending}
            onClick={() => file.mutate()}
          >
            Download the bank file
          </button>
        </div>
        {made ? (
          <p role="status" className="admin-note">
            Bank file made: {made.fileName}, saved to your downloads at {timeLabel(made.at)}. The
            download is recorded in the audit log.
          </p>
        ) : null}
        {file.isError && !isStepUp(file.error) ? (
          <p className="refusal" role="alert">
            {bankFileRefusalWords(file.error)}
          </p>
        ) : null}
      </div>
    );

  return <Region heading="Bank file">{body}</Region>;
}
