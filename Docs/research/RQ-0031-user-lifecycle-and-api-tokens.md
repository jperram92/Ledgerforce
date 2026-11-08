---
id: RQ-0031
title: How should LedgerForce offboard users and issue scoped API tokens safely?
status: resolved
opened: 2026-10-25
resolved: 2026-10-25
opened_by: claude
linked_tasks: [T-0016]
linked_adrs: [ADR-0027, ADR-0016, ADR-0023, ADR-0025, ADR-0026]
superseded_by:
---

# RQ-0031 — User lifecycle (joiner/mover/leaver) and scoped API tokens

## Question

Design §6.2 asks for "scoped personal or app tokens (e.g. invoices:read, payments:write) …
hashed at rest and expire"; §6.3 asks for joiner (invite → role → MFA enrolment before first
access → welcome audit event), mover (role change by Owner or Finance Admin; SoD conflicts
blocked or documented) and leaver (disable, never delete; revoke sessions and tokens; reassign
pending approvals; retain audit history).

- Q1. How should an API token be generated, transported and stored?
- Q2. What may a token do relative to its owner, and how do MFA, step-up and SoD apply to it?
- Q3. What must happen to sessions and tokens when a user is disabled or changes role?
- Q4. Which "pending approvals" exist today, and what can "reassign" mean before T-0052?
- Q5. What SoD check belongs to a role change (mover)?

## Why it matters

A token is a long-lived bearer credential that skips the interactive OIDC login, so a weak design
turns into an MFA bypass, a privilege-escalation path or a credential that survives the leaver.
Offboarding done in application code only is easy to forget on one path.

## Sources consulted

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S1 | OWASP Session Management Cheat Sheet, https://github.com/OWASP/CheatSheetSeries/blob/master/cheatsheets/Session_Management_Cheat_Sheet.md (cheatsheetseries.owasp.org not resolvable from this session; read from the source repository) | 2026-10-25 | primary (OWASP) | "Session identifiers must have at least 64 bits of entropy"; build own IDs from a CSPRNG with at least 128 bits; split-token pattern: "the server stores the public lookup identifier and the full SHA-256 hash of the verifier"; IDs must be renewed "after any privilege level change"; invalidation "must" happen "at least on server side". |
| S2 | OWASP ASVS 5.0, V7 Session Management, https://github.com/OWASP/ASVS/blob/master/5.0/en/0x16-V7-Session-Management.md | 2026-10-25 | primary (OWASP standard) | 7.2.3 reference tokens "possess at least 128 bits of entropy"; 7.4.2 "terminates all active sessions when a user account is disabled or deleted"; 7.4.3 terminate other sessions after a factor change; 7.5.1 "full re-authentication before allowing modifications to sensitive account attributes". |
| S3 | OWASP Password Storage Cheat Sheet, https://github.com/OWASP/CheatSheetSeries/blob/master/cheatsheets/Password_Storage_Cheat_Sheet.md | 2026-10-25 | primary (OWASP) | "Fast hashing algorithms such as SHA-256 are not suitable for password storage" "because they allow attackers to perform large numbers of guesses quickly" — the reason is guessable (low-entropy) input. Peppering protects hashes if "an attacker … only [has] access to the database". |
| S4 | OWASP REST Security Cheat Sheet, https://github.com/OWASP/CheatSheetSeries/blob/master/cheatsheets/REST_Security_Cheat_Sheet.md | 2026-10-25 | primary (OWASP) | Require the API key on every request to protected endpoints; do not rely on API keys alone for sensitive/high-value resources; return 429 when too fast; "Revoke the API key if the client violates the usage agreement." |
| S5 | OWASP Authorization Cheat Sheet, https://github.com/OWASP/CheatSheetSeries/blob/master/cheatsheets/Authorization_Cheat_Sheet.md | 2026-10-25 | primary (OWASP) | Least privilege; "deny access by default"; "Validating permissions correctly on just the majority of requests is insufficient." |
| S6 | GitHub Docs, "Managing your personal access tokens", https://github.com/github/docs/blob/main/content/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens.md | 2026-10-25 | vendor docs (prior art) | Fine-grained tokens get specific permissions; a token's permission does not exceed its owner's (an `admin:org` token of a non-owner gives no admin access); tokens "become inactive if the user loses access"; "choose the minimal permissions necessary"; maximum-lifetime policies. |
| S7 | Third-party summaries of API-key storage (zuplo.com learning centre; docs.rs `jerrycan-auth` api_key module), found by web search | 2026-10-25 | secondary | Machine-generated keys with ~256 bits of entropy: brute-forcing a SHA-256 preimage is infeasible, so a fast hash is the usual choice; a slow hash adds cost to every request without benefit; keep a non-secret prefix to identify keys. Used only as corroboration of S1/S3. |
| S8 | Repository: `apps/api/src/auth/session.service.ts`, migrations 0004, 0016, 0018, 0019, 0021 | 2026-10-25 | source code | Sessions already use `<tenant>.<id>.<secret>` with a 32-byte secret, only SHA-256 stored, constant-time compare; `session_epoch` revoke-all; role grants bump the epoch by trigger; `app.period_reopen_request` is the only pending-approval table (approvable by any other `period.reopen` holder; immutable except pending → approved); SoD eligibility already counts only `status = 'active'` users. |
| S9 | Design §6.2–6.5, §11.2 | 2026-10-25 | design | As quoted in the Question. §6.4: Integration role has "only the scopes of its connector" and no interactive login. |

## Findings

1. **Generation and storage (Q1).** A token secret from a CSPRNG with ≥128 bits is required
   (S1, S2 7.2.3); 256 bits matches the existing session secret (S8). Because the secret is not
   guessable, the reason slow password hashes exist (S3: guessing low-entropy input) does not
   apply; SHA-256 of the secret is sufficient, and is the OWASP split-token pattern (S1, S7).
   *(fact for the requirements; inference for "SHA-256 suffices", corroborated by S7)* A public
   lookup id plus a hashed verifier allows an indexed lookup and a constant-time compare (S1).
2. **Transport.** The token travels in the `Authorization: Bearer` header on every request to
   protected endpoints (S4); never in a URL. *(fact for S4; the URL rule is standard practice,
   RFC 6750 §2.3 discourages it — not re-fetched in this session)*
3. **Scope (Q2).** Least privilege and deny-by-default (S5); prior art never lets a token exceed
   its owner's current rights and deactivates it when the owner loses access (S6). So: a token
   carries an explicit list of permissions (its scopes), chosen as a subset of the owner's
   permissions at issue, and at each request its effective permissions are
   *scopes ∩ the owner's current role permissions*. *(inference from S5, S6)*
4. **MFA and step-up (Q2).** A token skips the interactive login, so it must not become an MFA
   bypass: issuing one is a sensitive change and needs fresh re-authentication (S2 7.5.1), i.e.
   an ADR-0025 step-up, which by definition is MFA. A token never proves a *fresh* interactive
   authentication, so it can never satisfy a step-up; permissions that always need step-up
   (`STEP_UP_PERMISSIONS`) cannot be scopes, and neither can user and role administration or
   SoD settings (S4: do not rely on keys alone for sensitive resources). *(inference)*
5. **SoD (Q2).** SoD rules are about *who* acts (ADR-0026). A token acts as its owner, so the
   owner is the actor and every rule applies unchanged. *(inference from S8)*
6. **Leaver (Q3).** Disabling must terminate all sessions server-side (S1, S2 7.4.2) and, by the
   same reasoning, all tokens (S6). A database trigger on the status change makes it impossible
   to forget on any path, as 0016 did for role changes (S8). Role grants are revoked too (kept as
   history), so a disabled account holds no access and is not counted anywhere. *(inference)*
7. **Mover (Q3, Q5).** Role change already revokes sessions (S1 "after any privilege level
   change", S8). Tokens need no revoke because of finding 3: lost permissions disappear from
   them at the next request. The SoD check that applies to *granting access itself* is
   requester ≠ beneficiary: nobody grants a role to themselves (same principle as §6.5's
   requester ≠ verifier). Design §6.4 does not define forbidden role *combinations* (the Owner
   holds everything; per-item SoD stops self-approval), so no combination is blocked.
   *(inference; combinations recorded as an open question for the product owner)*
8. **Pending approvals (Q4).** Nothing today is *assigned* to a named approver (S8): period
   reopen requests wait for any other holder of `period.reopen`, SoD exceptions are recorded
   after the fact. Reassignment can therefore only (a) record the leaver's successor so that
   approval tables built later (T-0052 bills, T-0054 batches) route items of a disabled
   assignee to an active successor, and (b) report the leaver's pending items (reopen requests
   they raised) to the administrator. *(fact for the inventory; scope decision in DL-0143)*

## Conclusion / decision

- Token string `lfpat.<tenant_id>.<token_id>.<secret>`; secret = 32 random bytes base64url;
  stored: `secret_sha256` only; compare in constant time; tenant taken from the string and
  proven by finding the row under that tenant's RLS (as ADR-0016 for cookies).
- `Authorization: Bearer` only; a request carrying both a session cookie and a bearer token is
  refused (no ambiguity about the principal).
- Scopes ⊆ owner's permissions at issue, minus a deny-list (step-up permissions, user/role
  administration, SoD settings); effective permissions = scopes ∩ owner's current permissions.
- Issue requires a session with a fresh step-up (≤ 300 s); tokens cannot issue tokens and never
  satisfy step-up; MFA-role checks are satisfied by the issuance step-up.
- Mandatory expiry: 1–366 days (default 90); `last_used_at` tracked; revoke once, kept.
- Leaver: `status → disabled` trigger revokes sessions, tokens and role grants and bumps the
  epoch; history kept; successor recorded; pending reopen requests reported.
- Mover: self-grant refused by the API and by the database.
- Joiner: invited users whose roles require MFA must authenticate with MFA to be activated;
  activation writes a `user.joined` audit event.

Recorded in ADR-0027 (security, Proposed) and DL-0141..DL-0145.

## Confidence

`medium-high` — the OWASP requirements are primary sources read from their repositories; the
"SHA-256 is enough for 256-bit secrets" step is an inference from S3's own rationale, matching
the session design already accepted in ADR-0016. RFC 6750 could not be fetched (DNS) and is
cited from prior knowledge for one point only (no tokens in URLs).

## Follow-ups

- App tokens for the Integration role (issued by an admin, not by the user): connector tasks.
- Rate limiting of token requests (S4 429): design §6.9 task.
- Forbidden role combinations, if the product owner wants any: open question (DL-0144).
- Approval tables (T-0052, T-0054) must route by `app.approval_assignee()`.

**Affects:** apps/api auth/authz/tenancy, migration 0022, T-0052, T-0054, connector tasks.
