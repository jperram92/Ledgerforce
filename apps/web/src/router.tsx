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
import { AuditLogPage } from './admin/AuditLogPage.tsx';
import { AUDIT_FILTER_KEYS, type AuditQuery } from './admin/client.ts';
import { ControlExceptionsPage } from './admin/ControlExceptionsPage.tsx';
import { UserPage } from './admin/UserPage.tsx';
import { UsersPage } from './admin/UsersPage.tsx';
import { ChartPage } from './gl/ChartPage.tsx';
import { JournalFormPage } from './gl/JournalFormPage.tsx';
import { JournalPage } from './gl/JournalPage.tsx';
import { isJournalStatus, JournalsPage } from './gl/JournalsPage.tsx';
import type { JournalStatus } from './gl/client.ts';
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

// Administration (T-0093): people and roles under Settings; the control-exceptions report and
// the audit log under Reports (IA §2, S19).
const usersRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: 'settings/users',
  component: UsersPage,
});

const userRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: 'settings/users/$userId',
  component: function UserRoute() {
    const { userId } = userRoute.useParams();
    return <UserPage key={userId} userId={userId} />;
  },
});

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const exceptionsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: 'reports/control-exceptions',
  validateSearch: (search: Record<string, unknown>): { week?: string } =>
    typeof search['week'] === 'string' && DAY.test(search['week']) ? { week: search['week'] } : {},
  component: function ExceptionsRoute() {
    const { week } = exceptionsRoute.useSearch();
    return <ControlExceptionsPage week={week} />;
  },
});

const auditRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: 'reports/audit-log',
  validateSearch: (search: Record<string, unknown>): AuditQuery => {
    const out: AuditQuery = {};
    for (const k of AUDIT_FILTER_KEYS) {
      const v = search[k];
      if (typeof v === 'string' && v !== '') out[k] = v;
    }
    return out;
  },
  component: function AuditRoute() {
    return <AuditLogPage search={auditRoute.useSearch()} />;
  },
});

// GL (T-0082, DL-0226): chart of accounts and manual journals under /accounting, listed on Reports.
const chartRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: 'accounting/chart',
  component: ChartPage,
});

const journalsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: 'accounting/journals',
  validateSearch: (search: Record<string, unknown>): { status?: JournalStatus } =>
    isJournalStatus(search['status']) ? { status: search['status'] } : {},
  component: function JournalsRoute() {
    const { status } = journalsRoute.useSearch();
    return <JournalsPage status={status} />;
  },
});

const newJournalRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: 'accounting/journals/new',
  component: () => <JournalFormPage />,
});

const journalRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: 'accounting/journals/$journalId',
  component: function JournalRoute() {
    const { journalId } = journalRoute.useParams();
    return <JournalPage key={journalId} journalId={journalId} />;
  },
});

const editJournalRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: 'accounting/journals/$journalId/edit',
  component: function EditJournalRoute() {
    const { journalId } = editJournalRoute.useParams();
    return <JournalFormPage key={journalId} journalId={journalId} />;
  },
});

const notFoundRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '$',
  component: NotFoundPage,
});

const routeTree = rootRoute.addChildren([
  signInRoute,
  shellRoute.addChildren([
    ...sectionRoutes,
    usersRoute,
    userRoute,
    exceptionsRoute,
    auditRoute,
    chartRoute,
    journalsRoute,
    newJournalRoute,
    journalRoute,
    editJournalRoute,
    notFoundRoute,
  ]),
]);

/**
 * Search params are plain text both ways (T-0093): every parameter of this app is a string, so
 * `before=7` stays `before=7` instead of TanStack's JSON default (`before=%227%22`).
 */
export function parsePlainSearch(searchStr: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(searchStr));
}

export function stringifyPlainSearch(search: Record<string, unknown>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(search)) {
    if (typeof v === 'string' && v !== '') p.set(k, v);
  }
  const s = p.toString();
  return s === '' ? '' : `?${s}`;
}

export function createAppRouter(history?: RouterHistory) {
  return createRouter({
    routeTree,
    parseSearch: parsePlainSearch,
    stringifySearch: stringifyPlainSearch,
    ...(history ? { history } : {}),
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
