---
id: RQ-0169
title: Should a step-up re-authentication rotate the session id, and how do established systems rotate a session without losing the user's work or opening a race?
status: resolved
opened: 2026-11-15
resolved: 2026-11-15
opened_by: claude
linked_tasks: [T-0192]
linked_adrs: [ADR-0025, ADR-0087, ADR-0016]
superseded_by:
---

# RQ-0169 — Rotating the session id on step-up re-authentication

## Question

RQ-0165 (follow-up 8, security reviewer) noted that OWASP ASVS 5.0 requirement 7.2.4 (Level 1)
asks for a new session token on every authentication, *including re-authentication*, while
ADR-0025 deliberately keeps the session id and cookie on a step-up. The owner delegated the
decision (DL-0691). Questions:

1. Does ASVS 5.0 7.2.4 apply to a step-up (an OIDC re-authentication with `prompt=login`,
   `max_age`, `acr_values` on an existing session)? What do the OWASP cheat sheets say?
2. How do established frameworks and IdPs rotate a session: new id with the data kept, or a new
   empty session? Is the old id destroyed at once or kept for a grace period?
3. What must be carried from the old session to the new one so the user loses nothing
   (lifetime, idle timeout, revoke-all epoch), and what must not be extended?
4. How do concurrent requests that still carry the old cookie behave, and can any of them gain
   the fresh step-up?
5. Does the browser (React app, StepUpPrompt) need to change?

## Why it matters

A step-up raises the privilege of a session (it unlocks payment release, bank-detail
verification, period reopen, Stripe refund approval for 300 s). A session id that an attacker
learnt before the step-up (fixation, a leaked log line, a shared machine) would otherwise ride on
the user's fresh MFA. ASVS Level 1 is the floor the design targets (design §6.9 targets L2).

## Sources consulted

Network note: `cheatsheetseries.owasp.org`, `docs.djangoproject.com` and
`guides.rubyonrails.org` did not resolve in this session; the same texts were read from their
source repositories on `raw.githubusercontent.com` and `github.com`.

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S1 | https://raw.githubusercontent.com/OWASP/ASVS/v5.0.0/5.0/en/0x16-V7-Session-Management.md | 2026-11-15 | primary (standard) | **7.2.4 (L1)**: "Verify that the application generates a new session token on user authentication, including re-authentication, and terminates the current session token." 7.4.1 (L1): after termination "the application disallows any further use of the session". |
| S2 | https://raw.githubusercontent.com/OWASP/CheatSheetSeries/master/cheatsheets/Session_Management_Cheat_Sheet.md | 2026-11-15 | primary (OWASP guidance) | "Renew the Session ID After Any Privilege Level Change": renew on authentication, password change, permission change or role elevation; "the old or previous session ID must be destroyed"; previous ids must be ignored for protected resources. Describes an optional short grace period for *timeout-based* renewal; logout must revoke every id of the same logical session. |
| S3 | https://raw.githubusercontent.com/django/django/main/django/contrib/sessions/backends/base.py | 2026-11-15 | primary (source) | `cycle_key()`: "Create a new session key, while retaining the current session data." It creates a new key, restores the data, then deletes the old key. |
| S4 | https://raw.githubusercontent.com/django/django/main/django/contrib/auth/__init__.py | 2026-11-15 | primary (source) | `login()` calls `request.session.cycle_key()` when the same user logs in again, and `flush()` (new empty session) when the session belonged to another user. Every login, including a re-login of the same user, gets a new key. |
| S5 | https://github.com/expressjs/session/blob/master/README.md; https://raw.githubusercontent.com/expressjs/session/master/session/store.js | 2026-11-15 | primary (docs + source) | `req.session.regenerate(cb)`: "a new SID and `Session` instance will be initialized"; `Store.prototype.regenerate` calls `this.destroy(req.sessionID, …)` first: the old id is destroyed, no grace period. |
| S6 | https://raw.githubusercontent.com/rails/rails/main/guides/source/security.md | 2026-11-15 | primary (framework guide) | Session fixation countermeasure: "issue a new session identifier" and "declare the old one invalid after a successful login", with `reset_session`. |
| S7 | https://raw.githubusercontent.com/spring-projects/spring-security/main/docs/modules/ROOT/pages/servlet/authentication/session-management.adoc | 2026-11-15 | primary (framework docs) | Session-fixation protection on every authentication; default `changeSessionId` (same session data, new id, `HttpServletRequest#changeSessionId()`); alternatives `migrateSession` (copy attributes) and `newSession`. |
| S8 | https://raw.githubusercontent.com/keycloak/keycloak/main/docs/documentation/server_admin/topics/authentication/flows.adoc | 2026-11-15 | primary (IdP docs) | Step-up: levels of authentication with a max age per level; "subsequent SSO logins can reuse this level"; `acr_values` requests a level. Keycloak governs the IdP's SSO session only; the relying party's own session is the RP's responsibility. |
| S9 | RQ-0027 (this repo) | 2026-11-15 | internal | Step-up mechanics: `prompt=login`, `max_age`, `acr_values`, `auth_time` verified by `openid-client`. |
| S10 | `apps/api/src/auth/session.service.ts`, `oidc.service.ts`, `login.controller.ts`, `packages/db/migrations/0004_sessions.sql`, `0025_parties_bank_detail_change.sql` (read) | 2026-11-15 | internal code | Cookie `<tenant>.<session_id>.<secret>`; only the secret's SHA-256 stored; `bank_detail_step_up_fresh(tenant, user, session)` re-checks the session row by id, `revoked_at IS NULL`. |

## Findings

1. **ASVS 7.2.4 covers step-up explicitly** (S1): "including re-authentication". A step-up is a
   re-authentication (the IdP is forced to authenticate again with `prompt=login`, RQ-0027), so
   ADR-0025's "no new session cookie" does not meet Level 1. OWASP's cheat sheet (S2) reaches
   the same result from the other direction: a step-up raises the session's privilege level.
2. **Every surveyed framework rotates on (re-)authentication and keeps the user's state**
   (S3–S7). Django `cycle_key` and Spring `changeSessionId`/`migrateSession` are the "new id,
   same data" pattern; Rails `reset_session` and express-session `regenerate` start fresh and
   the app copies what it needs. None keeps the old id valid after a login: Django deletes it,
   express-session destroys it before creating the new one, Rails declares it invalid. The OWASP
   grace interval (S2) is described for periodic, timeout-based renewal, not for authentication
   events, and is optional.
3. **What to carry over** (inference from S2, S3, S7 and our model S10): the user, the absolute
   expiry (a step-up must not extend a session beyond its 12-hour cap — otherwise rotation would
   become a lifetime extension), the idle timeout, and the revoke-all epoch the session was
   created under (so a role change or leaver bump made before the step-up still kills the new
   session). The authentication facts (`amr`, `acr`, `auth_time`) come from the step-up's ID
   token. LedgerForce keeps no server-side "session data" besides these columns; the user's
   work lives in the browser (form state, URL) and in tenant tables, none of them keyed by
   session id except the bank-detail audit (`session_id` recorded at request time, history only).
4. **Old row: revoke, never delete** (directive 6, S2): mark the old row `revoked_at`,
   `revoke_reason = 'rotated'` in the same transaction that inserts the new row, and audit the
   link (`rotated_from`). Logout of the new session ends the logical session because the old row
   is already revoked (S2's "revoke together" holds trivially).
5. **Concurrency** (inference from PostgreSQL READ COMMITTED semantics and S10). The rotation is
   one transaction: revoke old + insert new + audit. A request that read the old row *before*
   the rotation committed sees the old row's pre-step-up `auth_time`, so it can never use the
   fresh step-up: any step-up route answers 401 `step_up_required`, and the database re-check
   (`bank_detail_step_up_fresh`, `revoked_at IS NULL`) refuses too. A request that reads after
   the commit finds the old row revoked: 401 `session_expired`. The fresh `auth_time` exists
   only on the new row, whose secret only the callback's response carries. No row lock on every
   request is needed (a `FOR SHARE` in `verify` would turn every request into a row write and
   risk lock upgrades with the idle-touch update).
6. **Grace period: none.** Unlike timeout renewal, the step-up callback is a top-level
   navigation whose response sets the new cookie before the browser loads `return_to`; the SPA
   makes no API call during the IdP round trip (it has left the page). Background tabs of the
   same browser share the cookie jar and pick up the new cookie. A grace period would let a
   stolen old id stay valid, which is what 7.2.4 forbids ("terminates the current session token").
7. **Browser** (S10, apps/web): the StepUpPrompt leaves the app for `/auth/step-up` and comes
   back to the same path (`return_to`). The cookie is `HttpOnly`; the SPA never reads or caches
   it, so no web change is required — but an end-to-end test should prove the retried action is
   sent with the new cookie and succeeds, and that the screen is the same.
8. **Login.** A login already creates a new row and cookie (ADR-0016); a pre-login cookie is
   ignored. Only step-up needed the change.

## Conclusion / decision

Rotate on step-up (ADR-0087, superseding ADR-0025 in part): on a successful step-up the callback,
in one tenant transaction, revokes the old session row (`revoke_reason = 'rotated'`) and inserts a
new row for the same user with a new id and secret, the old row's absolute expiry, idle timeout
and session epoch, and the step-up's `amr`/`acr`/`auth_time`; the audit row `step_up` names the
new session and `rotated_from`. The response sets the new `lf_session` cookie and redirects to
`return_to`. No grace period; the old cookie is refused (401) from the commit on, and a request
racing the rotation never sees the fresh step-up.

## Confidence

High for the requirement and the pattern (standard text plus five independent implementations).
Medium-high for the no-grace choice: it follows the authentication-event guidance; if real users
hit a race (two tabs firing while the callback commits), the symptom is one 401 asking to sign in
again, never a privilege leak.

## Follow-ups

- None required. If telemetry ever shows the race in practice, a refresh-on-401 in the web
  client (retry once if the browser's cookie changed) can be considered — not a grace period.
