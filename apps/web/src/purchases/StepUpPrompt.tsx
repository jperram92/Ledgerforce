/**
 * The step-up prompt (T-0087, design §6.2, ADR-0025, P6): when a payment release or a bank-detail
 * verification answers `401 step_up_required`, the screen says why in plain words and lets the
 * person go and confirm their sign-in; the API's `/auth/step-up` sends them to the identity
 * provider and back to this page, where they press the action again. Nothing is retried on its
 * own: money never moves without a fresh click.
 */
import { useRouterState } from '@tanstack/react-router';
import { useEffect, useId, useRef } from 'react';
import { AdminApiError } from '../admin/client.ts';
import { useFailureRouting } from '../admin/common.tsx';
import { stepUpUrl } from '../admin/stepUp.ts';
import { useServices } from '../env.tsx';

export const isStepUp = (e: unknown): e is AdminApiError =>
  e instanceof AdminApiError && e.status === 401 && e.code === 'step_up_required';

/** Routes a mutation's failure: an ended session goes to sign-in; a step-up stays on the page. */
export function useMutationFailureRouting(error: unknown): void {
  useFailureRouting(isStepUp(error) ? null : error);
}

export function StepUpPrompt({
  error,
  why,
  onLeave,
  onCancel,
}: {
  error: AdminApiError;
  why: string;
  /** Called just before the browser leaves for the step-up (e.g. to keep a typed note). */
  onLeave?: () => void;
  onCancel: () => void;
}) {
  const { env } = useServices();
  const here = useRouterState({ select: (s) => s.location.href });
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <section className="admin-block step-up" aria-labelledby={headingId}>
      <h2 id={headingId} ref={heading} tabIndex={-1}>
        Confirm it’s you
      </h2>
      <p>{why}</p>
      <p className="admin-note">
        You will go to your sign-in page for your second step (for example a code from your
        authenticator app), then come back here. Nothing has been done yet: press the button again
        when you are back.
      </p>
      <div className="gl-actions">
        <button
          type="button"
          className="primary"
          onClick={() => {
            onLeave?.();
            env.goExternal(stepUpUrl(env.apiBase, error.body['max_age'], here));
          }}
        >
          Confirm my sign-in
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Not now
        </button>
      </div>
    </section>
  );
}
