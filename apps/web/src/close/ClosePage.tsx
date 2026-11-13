/**
 * Month-end close (T-0090, UC-10, SS-UC10-10). Shows one period's close checklist: each step's state,
 * who completed it and when, and the period's status. The next step can be completed from here by
 * someone with period.lock. The API (T-0148) enforces order, gates, permissions and audit, and the
 * screen only explains the result. Reopening a hard-locked period is a separate two-approver flow
 * (T-0079).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useId, useState, type ReactNode } from 'react';
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
import { useCompany } from '../sales/InvoicesPage.tsx';
import {
  defaultPeriod,
  PERIOD_STATUS_WORD,
  periodWindow,
  STEP_GLOSS,
  STEP_LABEL,
  stepStates,
  whenText,
} from './close-logic.ts';
import type { CloseStep } from './client.ts';

const STATE_WORD = { done: 'Done', next: 'Next', waiting: 'Waiting' } as const;
const newKey = () => `close-${crypto.randomUUID()}`;

function Region({ heading, children }: { heading: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="admin-block" aria-labelledby={id}>
      <h2 id={id}>{heading}</h2>
      {children}
    </section>
  );
}

/** A 422 from the close API: the module's message and, for the bank step, the accounts. */
function StepRefusal({ error }: { error: unknown }) {
  if (!(error instanceof AdminApiError) || (error.status !== 422 && error.status !== 409))
    return <Refusal error={error} />;
  const message = typeof error.body['message'] === 'string' ? error.body['message'] : null;
  const accounts = Array.isArray(error.body['accounts'])
    ? (error.body['accounts'] as { name?: unknown; unreconciledLines?: unknown }[])
    : [];
  return (
    <div className="refusal" role="alert">
      <p>We could not complete this step{message ? `: ${message}` : '.'}</p>
      {accounts.length > 0 ? (
        <ul>
          {accounts.map((a) => (
            <li key={String(a.name)}>
              {String(a.name)}: {String(a.unreconciledLines)} lines to reconcile
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function ClosePage({ periodId }: { periodId?: string }) {
  const access = useAccess();
  const { close } = useServices();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canRead = access.can('reports.run');
  const canComplete = access.can('period.lock');
  const company = useCompany();
  const companyId = company.company?.id ?? '';
  const [key, setKey] = useState(newKey);
  const window = periodWindow(new Date().toISOString().slice(0, 10));

  const periods = useQuery({
    queryKey: ['periods', companyId, window.from, window.to],
    queryFn: () => close.periods(companyId, window.from, window.to),
    enabled: canRead && !!companyId,
  });
  const chosen = periodId ?? defaultPeriod(periods.data?.periods ?? [])?.id ?? '';
  const checklistKey = ['close', 'checklist', chosen] as const;
  const checklist = useQuery({
    queryKey: checklistKey,
    queryFn: () => close.checklist(companyId, chosen),
    enabled: canRead && !!companyId && !!chosen,
  });
  const complete = useMutation({
    mutationFn: (step: CloseStep) => close.complete(companyId, chosen, step, key),
    onSuccess: async () => {
      setKey(newKey());
      await queryClient.invalidateQueries({ queryKey: checklistKey });
      await queryClient.invalidateQueries({ queryKey: ['periods', companyId] });
    },
    onError: () => setKey(newKey()),
  });
  useFailureRouting(checklist.error ?? periods.error ?? company.error);

  if (
    access.isPending ||
    (canRead && (company.isPending || periods.isPending || (!!chosen && checklist.isPending)))
  )
    return <Loading what="the close checklist" />;
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
        <PageHead title="Month-end close" gloss="The checklist that locks a month step by step." />
        <Forbidden heading="You can't see the close checklist">
          You do not have access to the close checklist. The Owner, Finance Admin, Accountant and
          Auditor can see it; ask your Owner if you need to.
        </Forbidden>
      </>
    );
  if (periods.isError || checklist.isError || !chosen || !checklist.data)
    return (
      <Failure
        heading="We could not load the close checklist"
        error={checklist.error ?? periods.error}
        onRetry={() => void (checklist.isError ? checklist.refetch() : periods.refetch())}
      />
    );

  const { period, steps } = checklist.data;
  const states = stepStates(steps);
  const nextIndex = states.indexOf('next');
  const next = nextIndex >= 0 ? steps[nextIndex] : undefined;
  return (
    <>
      <PageHead
        title="Month-end close"
        gloss={`${period.name}: ${PERIOD_STATUS_WORD[period.status]}. Each step locks a little more of the month; the order is fixed.`}
      />
      <div className="admin-filters">
        <div className="field">
          <label htmlFor="close-period">Period</label>
          <select
            id="close-period"
            value={period.id}
            onChange={(e) =>
              void navigate({ to: '/accounting/close', search: { period: e.target.value } })
            }
          >
            {(periods.data?.periods ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({PERIOD_STATUS_WORD[p.status]})
              </option>
            ))}
          </select>
        </div>
      </div>

      <Region heading="Checklist">
        <table className="admin-table" aria-label="Close checklist">
          <thead>
            <tr>
              <th scope="col">Step</th>
              <th scope="col">State</th>
              <th scope="col">Done by</th>
              <th scope="col">When</th>
            </tr>
          </thead>
          <tbody>
            {steps.map((s, i) => (
              <tr key={s.step} data-state={states[i]}>
                <td data-label="Step">
                  {STEP_LABEL[s.step]}
                  <br />
                  <span className="admin-note">{STEP_GLOSS[s.step]}</span>
                </td>
                <td data-label="State">{STATE_WORD[states[i] ?? 'waiting']}</td>
                <td data-label="Done by">{s.completed_by_name ?? '—'}</td>
                <td data-label="When">{s.completed_at ? whenText(s.completed_at) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Region>

      <Region heading="Next step">
        {!next ? (
          <p className="admin-note">Every step is done: {period.name} is hard locked.</p>
        ) : canComplete ? (
          <>
            <p className="admin-note" id="close-next-what">
              {STEP_GLOSS[next.step]}
            </p>
            <button
              type="button"
              className="primary"
              aria-describedby="close-next-what"
              disabled={complete.isPending}
              onClick={() => complete.mutate(next.step)}
            >
              Complete: {STEP_LABEL[next.step]}
            </button>
            {complete.isError ? <StepRefusal error={complete.error} /> : null}
          </>
        ) : (
          <p className="admin-note">
            Next is {STEP_LABEL[next.step].toLowerCase()}. The Owner or Finance Admin completes
            close steps.
          </p>
        )}
      </Region>
    </>
  );
}
