---
adr: 0025
title: "MFA enforcement for finance roles and step-up re-authentication on the existing session"
status: Proposed
date: 2026-10-25
author: claude
category: security
human_gate: yes
supersedes: none
superseded_by: none
---

# ADR-0025: MFA enforcement for finance roles and step-up re-authentication on the existing session

## Status

Proposed — security category, waiting for product-owner acceptance. It extends ADR-0016
(sessions keep `amr`/`acr`, "enforcement is T-0013") and ADR-0023 (role templates carry
`mfaRequired`) without changing either. T-0013 is built to this proposal so it can be judged on
working, tested code.

## Context and problem statement

Design §6.2: MFA is mandatory for Owner, Finance Admin, Accountant, AP Clerk and Payroll
Officer; releasing payment batches, changing bank details and reopening a locked period need a
step-up re-authentication. Sessions are server-side and tenant-scoped (ADR-0016). Permissions
are checked centrally in `TenantInterceptor` (ADR-0023, DL-0102). The questions are: what counts
as MFA, where the check runs, how a step-up is requested and proven, and what the session keeps.
Research: RQ-0027.

## Decision drivers

- Fail closed: a missing claim, a missing `auth_time` or a forgotten decorator must refuse.
- Trust only what the IdP asserted in a validated ID token, never what LedgerForce asked for.
- A step-up must not change who is signed in, and must not create a second session.
- One central check, beside the permission check; no ad-hoc checks in controllers.
- Works with Keycloak (self-host) and any compliant IdP; testable in-process (oidc-provider).

## Considered options

1. **Re-login for step-up** (a new session replaces the old one). Simple, but it changes the
   session id and cookie mid-task, and an attacker-controlled IdP account could swap the user.
2. **Step-up on the existing session** (chosen): the callback updates `auth_time`/`amr`/`acr` of
   the browser's own session, after checking that the ID token names the same user.
3. **Per-action signed step-up tokens** (a short-lived token per release). Stronger binding to
   one action, but needs a second token type and UI plumbing; can be added later on top of 2.

## Decision outcome

Chosen option 2:

- **MFA rule.** A session is MFA when its `amr` contains `mfa`, `otp` or `hwk`, or its `acr` is
  one of the configured MFA `acr` values (default `urn:ledgerforce:loa:mfa`; `createApi` option
  `mfa.acrValues`).
- **Who must have MFA.** A user with at least one active role whose template has
  `mfaRequired: true`. Such a user is refused on every **permission** route with 403
  `{"error":"mfa_required"}` until the session is MFA. Member routes (`/auth/me`,
  `/auth/logout`, `/auth/step-up`) stay open so the user can step up or leave. Users with only
  non-finance roles are unaffected.
- **Step-up routes.** A route declares `@RequireStepUp(maxAgeSeconds)`. Fail closed: a route
  whose permission is in `STEP_UP_PERMISSIONS` (`ap.payment_batch.release`,
  `payroll.net_pay_batch.release`, `parties.bank_account.change_request`,
  `parties.bank_account.verify`, `period.reopen`, `period.lock.override`) needs a step-up even
  without the decorator, with the default maximum age of 300 seconds. A step-up is satisfied when
  the session is MFA **and** `now − auth_time ≤ maxAge`; otherwise 401
  `{"error":"step_up_required","max_age":N}`. This holds for every role, including
  Approvers, whose template does not require MFA at login.
- **Order in the interceptor.** Session verified → undeclared refused → roles loaded → MFA rule →
  permission → step-up → handler. Every refusal rolls back the request transaction and is audited
  in its own transaction (`mfa_required`, `step_up_required`, as `permission_denied`).
- **Storage.** `app.session.auth_time` (from the ID token's `auth_time`; `NULL` when the IdP did
  not assert one, which never satisfies a step-up). `app.auth_request` gains `session_id`,
  `max_age_seconds` and `return_to` for step-up requests (migration 0019).
- **Step-up flow.** `GET /auth/step-up?max_age=N&return_to=/path` (member route) stores a pre-auth
  row linked to the session and redirects to the IdP with `prompt=login`, `max_age=N` and
  `acr_values=<first MFA acr>`, using the same PKCE + state + nonce + `lf_oidc` browser binding
  as login (ADR-0016). `/auth/callback` recognises the row, passes `maxAge: N` to
  `openid-client` (which rejects a stale `auth_time`), requires the same `lf_session` cookie
  (session valid and equal to the linked one) and the same `(iss, sub)` user, then updates the
  session's `auth_time`, `amr`, `acr`, writes an audit row `step_up` and redirects to
  `return_to`. No new session row, no new session cookie.
- **Out of scope.** Segregation of duties (T-0015) runs beside these checks later; the web
  shell's handling of `step_up_required` is a follow-up.

### Consequences

- Good: one central, fail-closed check; step-up proven by the IdP's signed `auth_time`; the
  session id never changes; denials audited.
- Good: configurable MFA `acr` keeps the IdP choice open (RQ-0027 finding 1).
- Bad: a session-level step-up covers every step-up action for `maxAge` seconds, not one
  specific action (option 3 can narrow this later).
- Bad: existing sessions (before 0019) have no `auth_time` and must step up once.
- Follow-ups: Keycloak realm ACR-to-LoA mapping and AMR mapper (T-0094); web handling of
  `step_up_required`; per-tenant step-up age if the product owner wants it.

## Compliance and verification

| Claim | Proven by |
|---|---|
| MFA rule (`amr`/`acr`), finance roles refused, others unaffected | `apps/api/src/authz/mfa.test.ts`; `apps/api/src/authz/mfa-step-up.db.test.ts` (SS-PLAT-20) |
| Release needs a fresh MFA step-up; step-up refreshes the same session | `apps/api/src/authz/mfa-step-up.db.test.ts` (SS-UC06-03, SS-PLAT-58) |
| Step-up refuses another user, a stale `auth_time`, a missing session; fail-closed permissions | same file (SS-PLAT-59); `apps/api/src/authz/routes.test.ts` |
| New columns covered by tenant isolation | `packages/db/src/rls.db.test.ts` (SS-PLAT-04) |

## Links

- Design §6.2, §6.4; ADR-0016; ADR-0023; RQ-0027; T-0013; DL-0121 … DL-0124.
