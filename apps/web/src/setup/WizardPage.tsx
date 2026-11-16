/**
 * Setup wizard (T-0091, design §4.1, SS-PLAT-127, SS-PLAT-128). Shows the ten setup steps of the
 * company: each step's state, what it covers, what is still missing in plain words (P12) and where
 * the settings are entered. Someone with settings.setup.manage completes the open step, or declares
 * "no history" on step 9 with a reason. The API (T-0157, ADR-0075) derives every state and enforces
 * order, validation, permission and audit; this screen only reads and explains it. It builds no
 * settings forms: steps 1 and 3 link to theirs (T-0176), step 4 to Bank accounts (T-0185); the others say plainly where (DL-0601).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState } from 'react';
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
import type { WizardStep } from './client.ts';
import {
  dayText,
  GAP_CHECK_STEP,
  NO_HISTORY_STEP,
  openStep,
  refusalOf,
  stateText,
  STEP_GLOSS,
  STEP_WHERE,
  summary,
} from './wizard-logic.ts';

const TITLE = 'Set up your company';
const GLOSS =
  'Ten steps, in order. Each step checks what LedgerForce already holds and says what is still missing.';
const newKey = () => `setup-${crypto.randomUUID()}`;

function StepRefusal({ error, step }: { error: unknown; step: number }) {
  const r = refusalOf(error, step);
  if (!r) return <Refusal error={error} />;
  return (
    <div className="refusal" role="alert">
      <p>{r.text}</p>
      {r.missing.length > 0 ? (
        <ul>
          {r.missing.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Missing({ s }: { s: WizardStep }) {
  if (s.status === 'complete') {
    if (s.missing.length === 0) return null;
    return <p className="admin-note">Something has changed since: {s.missing.join('; ')}</p>;
  }
  if (s.missing.length === 0)
    return (
      <p className="admin-note">
        Nothing is missing.{s.step === GAP_CHECK_STEP ? ' Gap check: no gaps.' : ''}
      </p>
    );
  return (
    <div className="wizard-missing">
      <p>Still missing:</p>
      <ul>
        {s.missing.map((m) => (
          <li key={m}>{m}</li>
        ))}
      </ul>
    </div>
  );
}

function Where({ step }: { step: number }) {
  const w = STEP_WHERE[step];
  if (!w) return null;
  return (
    <p className="admin-note">
      {w.text}
      {w.to && w.name ? (
        <>
          {' '}
          <Link to={w.to}>{w.name}</Link>.
        </>
      ) : null}
      {w.after ? ` ${w.after}` : null}
    </p>
  );
}

export function WizardPage() {
  const access = useAccess();
  const { setup } = useServices();
  const queryClient = useQueryClient();
  const canRead = access.can('settings.read');
  const canManage = access.can('settings.setup.manage');
  const company = useCompany();
  const companyId = company.company?.id ?? '';
  const [key, setKey] = useState(newKey);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState(false);
  const focusOpen = useRef(false);
  const reasonId = useId();
  const reasonErrorId = useId();

  const wizardKey = ['setup', 'wizard', companyId] as const;
  const wizard = useQuery({
    queryKey: wizardKey,
    queryFn: () => setup.wizard(companyId),
    enabled: canRead && !!companyId,
  });
  const complete = useMutation({
    mutationFn: (v: { step: number; reason?: string }) =>
      setup.complete(companyId, v.step, key, v.reason),
    onSuccess: async () => {
      setKey(newKey());
      setReason('');
      focusOpen.current = true;
      await queryClient.invalidateQueries({ queryKey: wizardKey });
    },
    onError: async () => {
      setKey(newKey());
      await queryClient.invalidateQueries({ queryKey: wizardKey });
    },
  });
  useFailureRouting(wizard.error ?? company.error);

  const open = wizard.data ? openStep(wizard.data) : undefined;
  // After a step completes, keyboard focus moves to the step that is open now (or the summary).
  useEffect(() => {
    if (!focusOpen.current || !wizard.data || wizard.isFetching) return;
    focusOpen.current = false;
    const target = document.getElementById(open ? `setup-step-${String(open.step)}` : 'setup-sum');
    target?.focus();
  }, [wizard.data, wizard.isFetching, open]);

  if (access.isPending || (canRead && (company.isPending || (!!companyId && wizard.isPending))))
    return <Loading what="the setup steps" />;
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
        <PageHead title={TITLE} gloss={GLOSS} />
        <Forbidden heading="You can't see the setup steps">
          You do not have access to the setup steps. The Owner, Finance Admin and Accountant can see
          them; ask your Owner if you need to.
        </Forbidden>
      </>
    );
  if (company.isError || wizard.isError || !wizard.data)
    return (
      <Failure
        heading="We could not load the setup steps"
        error={wizard.error ?? company.error}
        onRetry={() => void (wizard.isError ? wizard.refetch() : company.refetch())}
      />
    );

  const w = wizard.data;
  const openNumber = open?.step ?? w.steps.length + 1;

  const declare = (step: number) => {
    const r = reason.trim();
    if (r === '') {
      setReasonError(true);
      return;
    }
    setReasonError(false);
    complete.mutate({ step, reason: r });
  };

  const actions = (s: WizardStep) => {
    if (!canManage)
      return <p className="admin-note">The Owner or a Finance Admin completes setup steps.</p>;
    const busy = complete.isPending;
    const name = `Complete step ${String(s.step)}: ${s.title}`;
    return (
      <div className="wizard-actions">
        {s.valid ? (
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => complete.mutate({ step: s.step })}
          >
            {name}
          </button>
        ) : s.step === NO_HISTORY_STEP ? (
          <form
            className="admin-form"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              declare(s.step);
            }}
          >
            <p className="admin-note">
              A new company with nothing to bring across can complete this step by saying so. The
              reason is kept with the step.
            </p>
            <label htmlFor={reasonId}>Why the company has no history</label>
            <textarea
              id={reasonId}
              rows={3}
              maxLength={500}
              required
              aria-invalid={reasonError}
              aria-describedby={reasonError ? reasonErrorId : undefined}
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                if (e.target.value.trim() !== '') setReasonError(false);
              }}
            />
            {reasonError ? (
              <p className="refusal" id={reasonErrorId}>
                Write why the company has no history first.
              </p>
            ) : null}
            <button type="submit" className="primary" disabled={busy}>
              Declare no history and complete step {String(s.step)}
            </button>
          </form>
        ) : (
          <p className="admin-note">
            Step {String(s.step)} can be completed once nothing is missing. Enter the settings
            above, then check again.
          </p>
        )}
        {!s.valid ? (
          <button
            type="button"
            className="secondary"
            disabled={wizard.isFetching}
            onClick={() => void wizard.refetch()}
          >
            Check again
          </button>
        ) : null}
        {complete.isError ? <StepRefusal error={complete.error} step={s.step} /> : null}
      </div>
    );
  };

  return (
    <>
      <PageHead title={TITLE} gloss={GLOSS} />
      <p className="admin-note wizard-sum" id="setup-sum" tabIndex={-1} aria-live="polite">
        {summary(w)}
      </p>
      <section className="admin-block" aria-labelledby="setup-steps-h">
        <h2 id="setup-steps-h">Steps</h2>
        <ol className="wizard-steps" aria-label="Setup steps">
          {w.steps.map((s) => {
            const state =
              s.status === 'complete' ? 'done' : s.status === 'in_progress' ? 'open' : 'locked';
            return (
              <li key={s.step} data-state={state}>
                <h3 id={`setup-step-${String(s.step)}`} tabIndex={-1}>
                  Step {String(s.step)}: {s.title}
                </h3>
                <p>
                  <span className="word" data-status={state}>
                    {stateText(s, openNumber)}
                  </span>
                  {s.outcome === 'no_history' && s.reason ? <span> Reason: {s.reason}</span> : null}
                  {s.completed_at ? (
                    <span className="admin-note"> on {dayText(s.completed_at)}</span>
                  ) : null}
                </p>
                <p className="admin-note">{STEP_GLOSS[s.step]}</p>
                <Missing s={s} />
                <Where step={s.step} />
                {s.status === 'in_progress' ? actions(s) : null}
              </li>
            );
          })}
        </ol>
      </section>
    </>
  );
}
