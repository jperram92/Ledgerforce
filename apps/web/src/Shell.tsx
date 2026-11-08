/**
 * The authenticated shell (SS-PLAT-53): who is signed in (`GET /auth/me`), the section navigation
 * in the Timeline direction's top bar (no icon sidebar, no search/bell/avatar: genericness G5),
 * the user menu with sign-out, and the loading / error / signed-out paths (SS-PLAT-52, DL-0110).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { ApiError } from './api.ts';
import { useServices } from './env.tsx';
import { SECTIONS } from './sections.ts';
import { UserMenu } from './UserMenu.tsx';

export const ME_KEY = ['auth', 'me'] as const;

export function Shell() {
  const { api } = useServices();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const me = useQuery({ queryKey: ME_KEY, queryFn: () => api.me() });
  const signOut = useMutation({
    mutationFn: () => api.logout(),
    onSuccess: async () => {
      await navigate({ to: '/sign-in', search: { reason: 'signed-out' } });
      // The shell is gone now: drop who was signed in so Back cannot show it again.
      queryClient.removeQueries({ queryKey: ME_KEY });
    },
  });

  // A 401 at any point (first check or a later refetch) means there is no session.
  if (me.error instanceof ApiError && me.error.status === 401) {
    return <Navigate to="/sign-in" search={{ reason: 'expired' }} replace />;
  }
  if (me.isPending) {
    return (
      <main id="main" className="state">
        <p role="status">Checking your sign-in&hellip;</p>
      </main>
    );
  }
  if (me.isError) {
    return (
      <main id="main" className="state">
        <div role="alert">
          <h1>We could not check your sign-in</h1>
          <p>LedgerForce did not answer. Check your connection, then try again.</p>
          <button
            type="button"
            className="primary"
            onClick={() => {
              void me.refetch();
            }}
          >
            Try again
          </button>
        </div>
      </main>
    );
  }

  return (
    <>
      <a className="skip" href="#main">
        Skip to main content
      </a>
      <header className="top">
        <div className="org">LedgerForce</div>
        <nav aria-label="Sections">
          <ul>
            {SECTIONS.map((s) => (
              <li key={s.path}>
                {/* TanStack Link marks the current section with aria-current="page"; "/" is only
                    current at "/" (its path match requires a "/" boundary). shell.css styles it. */}
                <Link to={s.path}>{s.name}</Link>
              </li>
            ))}
          </ul>
        </nav>
        <UserMenu
          name={me.data.display_name}
          busy={signOut.isPending}
          onSignOut={() => {
            signOut.mutate();
          }}
        />
      </header>
      {signOut.isError ? (
        <p className="banner" role="alert">
          Sign-out did not finish. You are still signed in; try again in a moment.
        </p>
      ) : null}
      <main id="main" tabIndex={-1}>
        <FocusOnNavigate />
        <Outlet />
      </main>
    </>
  );
}

/** After a client-side navigation, move focus to the new page's heading (not on first load). */
function FocusOnNavigate() {
  const path = useRouterState({ select: (s) => s.resolvedLocation?.pathname });
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    document.querySelector<HTMLElement>('main h1')?.focus();
  }, [path]);
  return null;
}
