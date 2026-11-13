/**
 * Batch billing, step 1 (T-0084, UC-02 step 1): the AR Clerk chooses the period and asks for a
 * preview. The preview is the API's (POST /ar/batches/preview, ar.batch.run); it posts nothing.
 * One Idempotency-Key per period chosen, so a double click previews once.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
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
import { checkPeriod, monthOf, rolesWith, type PeriodForm } from './batch-logic.ts';
import { batchKey } from './BatchPage.tsx';
import { useCompany } from './InvoicesPage.tsx';

const newKey = () => `bb-${crypto.randomUUID()}`;

/** The API's own refusal sentence (422), else the shared plain words. */
function PreviewRefusal({ error }: { error: unknown }) {
  if (
    error instanceof AdminApiError &&
    error.status === 422 &&
    typeof error.body['message'] === 'string'
  ) {
    return (
      <p className="refusal" role="alert">
        We could not preview this batch: {error.body['message']}
      </p>
    );
  }
  return <Refusal error={error} />;
}

export function BatchesPage() {
  const access = useAccess();
  const canRun = access.can('ar.batch.run');
  const company = useCompany();
  useFailureRouting(company.error);

  let body;
  if (access.isPending || (canRun && company.isPending)) body = <Loading what="batch billing" />;
  else if (access.isError)
    body = (
      <Failure
        heading="We could not check what you may do"
        error={access.error}
        onRetry={() => void access.refetch()}
      />
    );
  else if (!canRun)
    body = (
      <Forbidden heading="You can't run batch billing">
        Only the {rolesWith('ar.batch.run')} can preview a batch. A batch someone else previewed
        opens from its link; ask your Owner if you need to run one.
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
  else body = <StartForm companyId={company.company.id} />;

  return (
    <>
      <PageHead
        title="Batch billing"
        gloss="Invoice every customer with billing due in a period at once. You see every invoice, the totals and anything that needs fixing before anything is posted."
      />
      {body}
    </>
  );
}

function StartForm({ companyId }: { companyId: string }) {
  const { sales } = useServices();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<PeriodForm>(() => ({
    ...monthOf(new Date().toISOString().slice(0, 10)),
    issue: '',
  }));
  const [key, setKey] = useState(newKey);
  const [problems, setProblems] = useState<string[]>([]);
  const preview = useMutation({
    mutationFn: () =>
      sales.previewBatch(
        {
          company_id: companyId,
          period_from: form.from,
          period_to: form.to,
          ...(form.issue ? { issue_date: form.issue } : {}),
        },
        key,
      ),
    onSuccess: async (b) => {
      queryClient.setQueryData(batchKey(b.id), b);
      await navigate({ to: '/sales/batches/$batchId', params: { batchId: b.id } });
    },
  });
  useFailureRouting(preview.error);
  const change = (k: keyof PeriodForm, v: string) => {
    setForm({ ...form, [k]: v });
    setKey(newKey());
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const p = checkPeriod(form);
    setProblems(p);
    if (p.length === 0) preview.mutate();
  };

  return (
    <section className="admin-block" aria-labelledby="bb-form-h">
      <h2 id="bb-form-h">Which period?</h2>
      <p>
        Billing lines dated in the period are invoiced, one invoice per customer. The invoices are
        dated the last day of the period unless you choose another date.
      </p>
      <form className="admin-form" onSubmit={submit} noValidate>
        <label htmlFor="bb-from">From</label>
        <input
          id="bb-from"
          type="date"
          required
          value={form.from}
          onChange={(e) => {
            change('from', e.target.value);
          }}
        />
        <label htmlFor="bb-to">To</label>
        <input
          id="bb-to"
          type="date"
          required
          value={form.to}
          onChange={(e) => {
            change('to', e.target.value);
          }}
        />
        <label htmlFor="bb-issue">Invoice date (optional)</label>
        <input
          id="bb-issue"
          type="date"
          value={form.issue}
          onChange={(e) => {
            change('issue', e.target.value);
          }}
        />
        {problems.length > 0 ? (
          <div className="refusal" role="alert">
            <p>Before the preview:</p>
            <ul>
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <button type="submit" className="primary" disabled={preview.isPending}>
          Preview the invoices
        </button>
      </form>
      <PreviewRefusal error={preview.error} />
    </section>
  );
}
