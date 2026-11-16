---
adr: 0087
title: "A step-up re-authentication rotates the session id and cookie (ASVS 5.0 7.2.4)"
status: Accepted
date: 2026-11-15
author: claude
category: security
human_gate: yes (delegated, DL-0691)
supersedes: ADR-0025 (in part — "no new session row, no new session cookie" on step-up)
superseded_by: none
---

# ADR-0087: A step-up re-authentication rotates the session id and cookie (ASVS 5.0 7.2.4)

## Status

Accepted 2026-11-15 by the building agent under the product owner's standing instruction
DL-0691 (security decision delegated on condition of research, a decision-log entry and tests):
research RQ-0169, decision DL-0730, tests listed below.

Supersedes the part of ADR-0025 that keeps the session id on step-up ("No new session row, no
new session cookie" and the driver "must not create a second session"). Everything else in
ADR-0025 (MFA rule, step-up routes, interceptor order, `max_age`/`acr_values`/`prompt=login`, the
same-user and same-cookie checks at the callback, auditing) stays in force.

## Context and problem statement

ADR-0025 chose "step-up on the existing session": the callback updated `auth_time`, `amr`, `acr`
of the browser's session and kept its id and cookie. OWASP ASVS 5.0 7.2.4 (Level 1) requires a
new session token "on user authentication, including re-authentication", terminating the
current one; the OWASP Session Management cheat sheet requires renewing the id after any
privilege change. A step-up is both. Research: RQ-0169.

## Decision drivers

- Meet ASVS 5.0 7.2.4 (L1) and the OWASP cheat sheet: a session id known before the step-up must
  not carry the fresh step-up.
- Fail closed under concurrency: no request with the old cookie may ever use the new `auth_time`.
- No loss of the user's work: same user, same screen, same lifetime; the retried action works.
- Directive 6: nothing is deleted; the old row is revoked and kept as history.
- Keep ADR-0025's other guarantees (same user, same browser session at the callback).

## Considered options

1. **Keep the id (ADR-0025).** Fails ASVS 7.2.4; rejected.
2. **Rotate only the secret on the same row.** The cookie changes, but the row id (which the
   audit trail and `bank_detail_step_up_fresh` use as the session identity) stays, so audit
   cannot tell the pre- and post-step-up sessions apart, and "terminate the current token" is
   only implicit. Rejected.
3. **New row, old row revoked, in one transaction (chosen)** — the Django `cycle_key` /
   Spring `migrateSession` pattern: new id and secret, state carried over.
4. **Rotation with a grace period for the old cookie.** The OWASP grace interval is for timeout
   renewal, not authentication events; it would keep a stolen id alive. Rejected (RQ-0169 §6).

## Decision outcome

Chosen option 3:

- **Callback.** After the ADR-0025 checks pass (cookie = the session linked to the pre-auth row,
  session valid, ID token names the same user, MFA, fresh `auth_time` within `max_age`),
  `SessionService.rotateInTx` in the callback's tenant transaction:
  1. revokes the old row (`revoked_at = now`, `revoke_reason = 'rotated'`) with
     `WHERE revoked_at IS NULL` — if it is no longer live, the step-up fails (`invalid_request`);
  2. inserts a new row for the same user with a new id and a new 32-byte secret (only its SHA-256
     stored), `created_at = last_seen_at = now`, the **old row's** `absolute_expires_at` (a
     step-up never extends the 12-hour cap), `idle_timeout_seconds` and `user_session_epoch`,
     and the step-up's `amr`, `acr`, `auth_time`;
  3. writes the `step_up` audit row with `entity_id` = the new session and
     `after.rotated_from` = the old session.
- **Response.** `303` to `return_to` with `Set-Cookie: lf_session=<tenant>.<new id>.<secret>`
  (same attributes as login: `HttpOnly`, `SameSite=Lax`, `Secure` in production, `Path=/`).
- **Old cookie.** From the commit on it is refused everywhere (401 `session_expired`). A request
  that read the old row before the commit runs with the old, pre-step-up facts, so a step-up
  route answers 401 `step_up_required` and the database re-check (`bank_detail_step_up_fresh`,
  `revoked_at IS NULL`) refuses as well. No grace period; no row lock on ordinary requests.
- **Refusals unchanged.** A wrong user, a non-MFA answer, a stale `auth_time` or a missing/other
  cookie leaves the old session untouched and issues no cookie (ADR-0025).
- **Web.** No change: the cookie is `HttpOnly` and never read by the SPA; StepUpPrompt returns to
  the same path and the user's retried action carries the new cookie.

### Consequences

- Good: ASVS 5.0 7.2.4 (L1) met; a pre-step-up id (fixation, leak) cannot use a step-up.
- Good: audit shows the chain old → new session; history kept (directive 6).
- Neutral: one extra `app.session` row per step-up (rows are small; step-ups are rare).
- Bad: a background request from another tab that was sent with the old cookie in the
  milliseconds the callback commits gets 401 and the user is asked to sign in again. Accepted:
  fail closed; RQ-0169 follow-up describes a later client-side mitigation if ever needed.
- Bad: other in-flight step-ups started from the old session (another tab) fail with
  `invalid_request` at their callback, because their pre-auth row names the old session. The user
  presses the action again.

## Compliance and verification

| Claim | Proven by |
|---|---|
| After step-up the old cookie is refused and the new one works with the fresh `auth_time`; lifetime and epoch carried, nothing deleted, audited with `rotated_from` | `apps/api/src/authz/mfa-step-up.db.test.ts` (SS-PLAT-139) |
| A request with the old cookie during the rotation fails closed (401), never with elevated rights; racing requests likewise | same file (SS-PLAT-140) |
| The rotated session keeps the revoke-all epoch: a later revoke-all ends it | same file (SS-PLAT-139) |
| Refused step-ups issue no cookie and leave the session unchanged | same file (SS-PLAT-59) |
| StepUpPrompt keeps the user on the same screen and the retried action succeeds with the new cookie | `tests/e2e/web/step-up-rotation.spec.ts` (SS-PLAT-141) |

## Links

- RQ-0169, RQ-0165 (follow-up 8), RQ-0027; ADR-0016, ADR-0025; DL-0691, DL-0730; T-0192.
- OWASP ASVS 5.0 V7.2.4; OWASP Session Management Cheat Sheet.
