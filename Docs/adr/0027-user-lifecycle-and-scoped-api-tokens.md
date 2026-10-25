---
adr: 0027
title: "User lifecycle (joiner/mover/leaver) and scoped personal API tokens"
status: Proposed
date: 2026-10-25
author: claude
category: security
human_gate: yes
supersedes: none
superseded_by: none
---

# ADR-0027: User lifecycle (joiner/mover/leaver) and scoped personal API tokens

## Status

Proposed — security category, waiting for product-owner acceptance. It extends ADR-0016
(sessions), ADR-0023 (roles), ADR-0025 (MFA and step-up) and ADR-0026 (SoD) without changing
them. T-0016 is built to this proposal so it can be judged on working, tested code. Research:
[RQ-0031](../research/RQ-0031-user-lifecycle-and-api-tokens.md).

## Context and problem statement

Design §6.2 asks for scoped personal or app tokens, hashed at rest, with expiry. §6.3 asks for
joiner (invite → role → MFA enrolment before first access → welcome audit event), mover (role
change by Owner or Finance Admin, SoD conflicts blocked or documented) and leaver (disable never
delete, revoke sessions and tokens, reassign pending approvals, retain audit history). A token is
a bearer credential that skips the interactive OIDC login, so it must not become an MFA bypass,
a privilege-escalation path, or a credential that outlives its owner.

## Decision drivers

- No plaintext secret at rest; tenant isolation by RLS; deny by default (RQ-0031 S1, S5).
- A token can never do more than its owner can do *now* (RQ-0031 S6).
- MFA, step-up and SoD keep their meaning when a token is used.
- Offboarding cannot be forgotten on any code path; nothing is deleted (directive 6).

## Considered options

1. **Opaque reference tokens in a tenant table, split-token format, SHA-256 of a 256-bit
   secret; leaver revocation by database trigger** (chosen).
2. Self-contained signed tokens (JWT) (rejected: revocation needs a server-side list anyway,
   adds key management, and a stolen token's scope is fixed at issue).
3. Slow password hash (argon2/bcrypt) of the token (rejected: the secret has 256 bits of entropy,
   so guessing is infeasible and a slow hash only adds latency to every API call; RQ-0031 F1).
4. Offboarding only in application code (rejected: one forgotten path leaves a live credential).

## Decision outcome

### Tokens (`app.api_token`, migration 0022)

- String `lfpat.<tenant_id>.<token_id>.<secret>`; secret = 32 CSPRNG bytes, base64url. The
  database stores `secret_sha256` only (CHECK: 64 hex characters); the secret is shown once.
  Verification finds the row by id under the claimed tenant's RLS and compares hashes in
  constant time (as ADR-0016 cookies).
- Sent only as `Authorization: Bearer`; a request with both a session cookie and a bearer token
  is refused (401).
- **Personal tokens only** in T-0016: owner = issuer = the signed-in user. App tokens for the
  Integration role (issued by an administrator for a connector) are left to the connector tasks.
- **Scopes** are permission ids of the catalogue (`app.permission_known` mirrors it). At issue
  they must be a subset of the owner's permissions and must not include a *token-forbidden*
  permission: every `STEP_UP_PERMISSIONS` entry, `users.manage`, `users.roles.assign`,
  `users.roles.assign_owner`, `settings.sod.manage`, `subscription.manage`.
- **Effective permissions** at each request = scopes ∩ permissions of the owner's active roles.
  A mover who loses a role loses it on every token at once; no token revoke is needed.
- **Expiry** mandatory, 1–366 days (default 90), checked by the database; `last_used_at` is
  written at most once a minute; revoke once (`revoked_at`, `revoked_by`, `revoke_reason`),
  kept as history. A trigger allows no other change.
- **MFA / step-up:** issuing a token needs a session with a fresh step-up (ADR-0025, ≤ 300 s),
  which is MFA by definition; the MFA-role check of a later token request is satisfied by that
  issuance. A token never satisfies a step-up, so step-up routes refuse it (401
  `step_up_required`), and a token cannot issue tokens.
- **SoD:** the token's owner is the actor; every ADR-0026 rule applies unchanged.
- **Audit:** requests made with a token are audited as `actor_type = 'user'` with the owner's id
  and `token_id` in the audit row's `after`/denial details where the interceptor writes them.

### Joiner

`POST /users` (`users.manage`) creates an `invited` user with role grants (each needs the
permission to assign that role). At first login, a user whose roles require MFA (ADR-0025) is
activated only if the login was MFA; otherwise the login is refused (`mfa_enrolment_required`,
403) and the user stays `invited`. Activation writes a `user.joined` audit event.

### Mover

Existing role routes (ADR-0023). New: nobody grants a role to themselves — refused by the API
(403 `self_grant`) and by a trigger on `app.user_role` (requester ≠ beneficiary, as §6.5's
requester ≠ verifier). No role grant to a disabled user. No role *combination* is forbidden
(design §6.4 defines none; the Owner holds every permission; per-item SoD stops self-approval).

### Leaver

`POST /users/:id/offboard` (`users.manage`) with a reason and an optional successor. The status
change to `disabled` fires a database trigger that, in the same transaction: revokes every open
session (`revoke_reason = 'user_disabled'`) and bumps `session_epoch`; revokes every active token;
revokes every active role grant (`revoke_reason = 'leaver'`, `revoked_by` = the administrator).
Rows are kept; `lf_app` has no DELETE. A disabled user can never become `active` directly (only
re-invited, which goes through the joiner gate again). Self-offboarding and offboarding the last
active Owner are refused. The successor is recorded; `app.approval_assignee(user)` follows the
successor chain to an active user so approval tables (T-0052, T-0054) route a disabled
assignee's items. Pending period-reopen requests raised by the leaver are reported in the
response (they are immutable and approvable by any other holder).

## Consequences

- Good: a leaver's credentials die in the same commit as the status change, whichever code path
  changed it; tokens are least-privilege by construction and cannot escalate.
- Bad: users without MFA cannot create tokens (by design); integrations wait for app tokens.
- Follow-ups: rate limiting (§6.9); app tokens (connector tasks); approval routing (T-0052,
  T-0054); forbidden role combinations if the product owner wants any (DL-0144).

## Links

RQ-0031; DL-0141..DL-0145; design §6.2–6.5; ADR-0016, ADR-0023, ADR-0025, ADR-0026.
