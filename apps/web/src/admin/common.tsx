/**
 * Shared pieces of the admin screens (T-0093): the caller's access (`GET /auth/me/access`), the
 * routing of step-up challenges and ended sessions, and the loading / error / forbidden states
 * every screen has (apps/web AGENTS.md, P6).
 */
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useEffect, useId, type ReactNode } from 'react';
import { useServices } from '../env.tsx';
import { pageTitle } from '../sections.ts';
import { AdminApiError, type Access } from './client.ts';
import { messageFor } from './messages.ts';
import { stepUpUrl } from './stepUp.ts';

export const ACCESS_KEY = ['auth', 'access'] as const;
export const USERS_KEY = ['admin', 'users'] as const;

export function useTitle(name: string): void {
  useEffect(() => {
    document.title = pageTitle(name);
  }, [name]);
}

/** What the caller may do. The API stays the authority; this only hides or disables actions. */
export function useAccess() {
  const { admin } = useServices();
  const q = useQuery({ queryKey: ACCESS_KEY, queryFn: () => admin.access() });
  useFailureRouting(q.error);
  const can = (permission: string): boolean => q.data?.permissions.includes(permission) ?? false;
  return { ...q, can };
}

export type { Access };

/**
 * A step-up challenge leaves the app for `/auth/step-up` and comes back to this page
 * (ADR-0025); any other 401 means the session is gone: sign in again.
 */
export function useFailureRouting(error: unknown): void {
  const { env } = useServices();
  const navigate = useNavigate();
  const here = useRouterState({ select: (s) => s.location.href });
  useEffect(() => {
    if (!(error instanceof AdminApiError) || error.status !== 401) return;
    if (error.code === 'step_up_required') {
      env.goExternal(stepUpUrl(env.apiBase, error.body['max_age'], here));
    } else {
      void navigate({ to: '/sign-in', search: { reason: 'expired' } });
    }
  }, [error, env, here, navigate]);
}

export function PageHead({ title, gloss }: { title: string; gloss: string }) {
  useTitle(title);
  return (
    <div className="head">
      <h1 tabIndex={-1}>{title}</h1>
      <p>{gloss}</p>
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return (
    <p className="admin-state" role="status">
      Loading {what}&hellip;
    </p>
  );
}

export function Failure({
  heading,
  error,
  onRetry,
}: {
  heading: string;
  error: unknown;
  onRetry: () => void;
}) {
  return (
    <div className="admin-state" role="alert">
      <h2>{heading}</h2>
      <p>{messageFor(error)}</p>
      <button type="button" className="secondary" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

export function Forbidden({ heading, children }: { heading: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="empty" data-state="forbidden" aria-labelledby={id}>
      <h2 id={id}>{heading}</h2>
      <p>{children}</p>
    </section>
  );
}

export function Empty({ heading, children }: { heading: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="empty" data-state="empty" aria-labelledby={id}>
      <h2 id={id}>{heading}</h2>
      <p>{children}</p>
    </section>
  );
}

/** A refusal shown next to the action that caused it, in plain words. */
export function Refusal({ error }: { error: unknown }) {
  if (!error) return null;
  // Step-up and ended sessions navigate away instead (useFailureRouting).
  if (error instanceof AdminApiError && error.status === 401) return null;
  return (
    <p className="refusal" role="alert">
      {messageFor(error)}
    </p>
  );
}

export const READERS = 'Only the Owner, a Finance Admin or an Auditor';
