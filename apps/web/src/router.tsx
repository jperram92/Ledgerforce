/**
 * Code-based TanStack Router routes (RQ-0025 F1, DL-0110): `/sign-in` outside the shell; a pathless
 * layout route `shell` holding the sections and a catch-all not-found. No path starts with `/auth`
 * or `/t/`, which belong to the API on the same origin.
 */
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  type RouterHistory,
} from '@tanstack/react-router';
import { NotFoundPage, SectionPage } from './pages.tsx';
import { SECTIONS } from './sections.ts';
import { Shell } from './Shell.tsx';
import { SignInPage, type SignInReason } from './SignIn.tsx';

const rootRoute = createRootRoute({ component: Outlet });

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'sign-in',
  validateSearch: (search: Record<string, unknown>): { reason?: SignInReason } =>
    search['reason'] === 'signed-out' || search['reason'] === 'expired'
      ? { reason: search['reason'] }
      : {},
  component: function SignInRoute() {
    const { reason } = signInRoute.useSearch();
    return <SignInPage reason={reason} />;
  },
});

const shellRoute = createRoute({ getParentRoute: () => rootRoute, id: 'shell', component: Shell });

const sectionRoutes = SECTIONS.map((section) =>
  createRoute({
    getParentRoute: () => shellRoute,
    path: section.path,
    component: () => <SectionPage section={section} />,
  }),
);

const notFoundRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '$',
  component: NotFoundPage,
});

const routeTree = rootRoute.addChildren([
  signInRoute,
  shellRoute.addChildren([...sectionRoutes, notFoundRoute]),
]);

export function createAppRouter(history?: RouterHistory) {
  return createRouter({ routeTree, ...(history ? { history } : {}) });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
