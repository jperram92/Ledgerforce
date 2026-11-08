---
id: RQ-0025
title: How does the web shell route, learn who is signed in, sign out, and get tested end to end without the API's database?
status: resolved
opened: 2026-10-24
resolved: 2026-10-24
opened_by: claude
linked_tasks: [T-0081]
linked_adrs: [ADR-0002, ADR-0016]
superseded_by:
---

# RQ-0025 — Web shell: routing, the auth round trip, and API mocking in Playwright

## Question

Q1. TanStack Router offers file-based routing (a bundler plugin that generates a route tree) and
code-based routing. Which one does the shell use, and what does each cost?

Q2. How does the single-page app take part in the OIDC login of T-0011 (ADR-0016): where does
"Sign in" go, where does the browser come back to, how does the app learn who is signed in, and
how does it sign out? What must the app do with a 401?

Q3. Which accessible primitive gives the user menu (sign out) the WAI-ARIA menu-button
behaviour, and is it within the design's stack?

Q4. How can Playwright test the shell (sign-in redirect, 401, sign-out) without starting
PostgreSQL, the API and an identity provider?

## Why it matters

T-0081 is the shell every later screen (T-0083 onward) sits in. A wrong guess about the origin,
the cookie or the 401 path would leave users stuck on a blank page or loop between sign-in and the
shell. Design §7.1 (React, Vite, TanStack, shadcn/ui), §6.2 (sessions), ADR-0016.

## Sources consulted

The public documentation sites (tanstack.com, playwright.dev, radix-ui.com) were not reachable
from this sandbox (DNS failure, 2026-10-24), so the installed library sources and their
docblocks — which those sites are generated from — were read instead, and the behaviour was
confirmed by running it.

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S1 | `apps/api/src/auth/login.controller.ts` (T-0011) | 2026-10-24 | primary (repo) | `GET t/:slug/auth/login` sets the `lf_oidc` cookie (path `/auth`) and 302s to the IdP; `GET auth/callback` sets `lf_session` with `httpOnly`, `sameSite: 'lax'`, `path: '/'`, then `res.redirect(303, '/')`. |
| S2 | `apps/api/src/auth/auth.controller.ts` | 2026-10-24 | primary (repo) | `GET auth/me` → `{ tenant_id, user_id, display_name }` or 401 `{"error":"unauthenticated"}`; `POST auth/logout` → 204, ends this session only; 401 when there is no session. |
| S3 | `packages/db/migrations/0014_auth_oidc.sql` line 19 | 2026-10-24 | primary (repo) | `slug ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'` — lower-case, 1–63 characters, no leading/trailing hyphen. Unknown slugs get the same 404 as suspended ones (SS-PLAT-42). |
| S4 | `apps/api/src/main.ts`, `app.ts` | 2026-10-24 | primary (repo) | No global prefix: the API's routes are `/auth/*`, `/t/*`, `/health`, `/companies`, … at the origin root. |
| S5 | `@tanstack/router-core@1.171.34` `dist/esm/route.d.ts`, `redirect.d.ts`; `@tanstack/react-router@1.170.41` `dist/esm/index.d.ts` | 2026-10-24 | source code | Routes are values built with `createRootRouteWithContext`, `createRoute({ getParentRoute, path })`, `createRouter({ routeTree })`; `beforeLoad` may throw `redirect({ to })` ("A redirect Response that can be thrown from loaders/beforeLoad"); `createMemoryHistory` and `createBrowserHistory` are exported. Code-based routing needs no plugin; file-based needs `@tanstack/router-plugin` and a generated `routeTree.gen.ts`. |
| S6 | `@radix-ui/react-dropdown-menu@2.1.25` and `@radix-ui/react-menu@2.1.25` `dist/index.mjs` | 2026-10-24 | source code | Trigger renders `aria-haspopup="menu"` and `aria-expanded`; opens on `Enter`, `Space`, `ArrowDown`; menu keys `ArrowDown/PageUp/Home` (first) and `ArrowUp/PageDown/End` (last); selection on `Enter`/`Space`; focus returns to the trigger on close; no styles shipped. |
| S7 | `playwright-core@1.63.0` `types/types.d.ts` lines 4408–4414, 10338–10343 | 2026-10-24 | source code | "Routing provides the capability to modify network requests that are made by a page. Once routing is enabled, every request matching the url pattern will stall unless it's continued, fulfilled or aborted." It "will not intercept requests intercepted by Service Worker". |
| S8 | `tests/e2e/ui-system.spec.ts` (T-0106), DL-0091 | 2026-10-24 | primary (repo) | Pages under test are served in-process by `createViteServer` from `vitest/node`, one cache dir per worker. |
| S9 | Spike (E1, below) | 2026-10-24 | experiment | Executed; output recorded. |

## Findings

1. **Q1.** Both routing styles are first-class in TanStack Router (S5). Code-based routing is
   plain TypeScript values: fully typed links, no bundler plugin, no generated file to keep in
   sync, and it can be built inside a Vitest test with `createMemoryHistory`. File-based routing
   adds `@tanstack/router-plugin` (another dependency and a code-generation step) whose benefit —
   automatic code splitting of many route files — does not apply to six placeholder sections.
   *Inference:* code-based now; a move to file-based later is mechanical (same route objects).
2. **Q2, origin.** The session cookie is `path=/`, `SameSite=Lax` and `HttpOnly`, and the
   callback redirects to `/` on the API's own origin (S1). The API has no prefix (S4). So the SPA
   must be served **on the same origin as the API**, with a reverse proxy sending `/auth/*`,
   `/t/*` and the API's resource paths to the API and every other path to the SPA. In dev, Vite's
   `server.proxy` does the same. The SPA must not use route paths that start with `/auth` or
   `/t/`. *Inference:* SPA section paths (`/sales`, `/purchases`, `/bank`, `/reports`,
   `/settings`) do not collide with today's API routes; the API's future resource routes should
   live under a prefix — recorded as an open question for the human (not this task's area).
3. **Q2, flow.** "Sign in" is a full-page navigation (not `fetch`) to `/t/<slug>/auth/login`,
   because the API answers with a 302 to the IdP and sets a cookie (S1). The slug is validated
   in the browser with the same pattern as the database (S3) so obvious typos never leave the
   page; the API's 404 for unknown slugs stays the source of truth. After the callback the browser
   lands on `/`, the shell asks `GET /auth/me` with `credentials: 'same-origin'`, and shows the
   display name (S2). A 401 from `/auth/me` (no session, idle or absolute expiry) sends the user to
   the sign-in page with a plain message; any other failure shows an error state with Retry,
   never a redirect loop. Sign-out is `POST /auth/logout` (S2); 204 **or** 401 (already ended)
   both end on the sign-in page with "You have signed out", and the cached `me` is cleared so the
   back button cannot show the old name. `SameSite=Lax` means a cross-site page cannot POST the
   logout with the cookie, so no extra CSRF token is needed for this call (S1).
4. **Q3.** Radix `DropdownMenu` implements the menu-button pattern (S6) and ships no styles, so it
   can be dressed in Timeline tokens; it is the primitive shadcn/ui's dropdown is built on, so it
   is inside design §7.1 / ADR-0002 (DL-0070: shadcn only as restyled accessible primitives;
   DL-0092 deferred Radix to this task). Its transitive packages are all ≥ 14 days old
   (DL-0109).
5. **Q4.** `page.route` intercepts every request the page makes, including `fetch` and top-level
   navigations, and can `fulfill` them (S7). The app itself is served in-process by Vite exactly
   like the T-0106 harness (S8), so the API is replaced by a small per-test fake: `/auth/me` →
   200 or 401, `/auth/logout` → 204 (recording that it was called), `/t/<slug>/auth/login` →
   recorded and fulfilled with a stand-in identity-provider page. No PostgreSQL, API or IdP is
   started, and the contract being faked is exactly the one SS-PLAT-41/42 already prove against
   the real API (S2). No service worker is used, so S7's caveat does not apply.

### E1 — spike (executed)

`pnpm install` of `@tanstack/react-router@1.170.41`, `@tanstack/react-query@5.104.1`,
`@radix-ui/react-dropdown-menu@2.1.25` and `vite@8.3.4` in `apps/web`, then the lockfile's added
`packages:` keys were dated with `npm view <pkg>@<ver> time`: 51 added; `seroval` and
`seroval-plugins` 1.7.2 (dependencies of `@tanstack/router-core`, range `^1.6.7`) were published
on 2026-10-24, the rest on or before 2026-10-08. With root overrides to 1.6.9 (2026-10-09) the
count of entries younger than 14 days is 0. `pnpm audit --prod` → "No known vulnerabilities
found" (exit 0).

## Conclusion / decision

- Use **code-based** TanStack Router routes; a pathless layout route holds the authenticated
  shell; `/sign-in` sits outside it.
- Serve the SPA on the API's origin; dev uses a Vite proxy for `/auth` and `/t`.
- Sign-in navigates the whole page to `/t/<slug>/auth/login` after validating the slug against
  the migration-0014 pattern; `/auth/me` through TanStack Query; 401 → `/sign-in?reason=expired`;
  sign-out `POST /auth/logout`, 204 or 401 → clear the cache → `/sign-in?reason=signed-out`.
- User menu: Radix `DropdownMenu`, restyled with Timeline tokens.
- E2E: serve `apps/web` with `createViteServer` and fake the API with `page.route`.

Decision-log entries: DL-0109 (dependencies), DL-0110 (routing and auth flow).

## Confidence

`high` for Q1, Q3, Q4 (library source read and executed); `high` for Q2's flow (the API code is
in this repository); the same-origin deployment is an inference from the cookie and redirect and
is listed as an open question for the deployment task.

## Follow-ups

- Human/deployment: give the API's resource routes a prefix (e.g. `/api`) before the SPA and
  API share an origin in production, so a future API route cannot shadow a screen.
- `/auth/me` returns no organisation name or roles; the shell shows the person's name only.
  Roles arrive with T-0012; an organisation name needs a field on `/auth/me` (later task).

**Affects:** apps/web, tests/e2e/web-shell.spec.ts, deployment (reverse proxy), T-0012 (roles in
`/auth/me`).
