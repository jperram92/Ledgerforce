---
id: RQ-0190
title: Bills mailbox OAuth2 hardening - provider calls outside the request transaction, failed refresh-token re-seal, PKCE verifier lifetime, SECURITY DEFINER checks
status: answered
opened: 2026-11-23
resolved: 2026-11-23
opened_by: claude
linked_tasks: [T-0243, T-0216]
linked_adrs: [ADR-0108, ADR-0105, ADR-0023, ADR-0018]
superseded_by:
---

# RQ-0190 — Bills mailbox OAuth2 hardening

## Question

Security review r12 (DL-0899) of T-0216 left four findings for T-0243:

- **Q1 (M1)** The OAuth callback exchanges the code with the provider (up to 15 s) inside the
  request's tenant transaction, holding a pooled `lf_app` connection and the request row lock.
  How do comparable systems keep network I/O out of database transactions, and how can a NestJS
  route that every request wraps in one tenant transaction (design §6.7, TenantInterceptor) do
  it without weakening the session, permission and step-up checks?
- **Q2 (L1)** If re-sealing a rotated refresh token fails (KMS or database error) the new token
  is dropped and the old one kept. What do providers do with the old token, and what should the
  poller do?
- **Q3 (L2)** The PKCE verifier stays in plain text forever. When may it be discarded?
- **Q4 (L3)** Which properties of `app.rotate_bill_inbox_refresh_token` need a test?

## Why it matters

Design §6 (security): a held connection per slow callback lets a slow or hostile provider
exhaust the API pool (availability), and an idle-in-transaction session keeps a row lock. A
lost rotated refresh token can disconnect a mailbox silently. A stored verifier is a secret that
outlives its purpose. A SECURITY DEFINER function owned by the wrong role, or with an unpinned
search_path, is a privilege-escalation path.

## Sources consulted

Network note (2026-11-23): `www.rfc-editor.org` and `www.postgresql.org` did not resolve from
this session (ENOTFOUND); the web search tool worked. Standards text below is cited from the
documents as known to the author and marked so; vendor facts come from search extracts.

| # | Source | Accessed | Kind | What it says |
|---|---|---|---|---|
| S1 | RFC 9700 (OAuth 2.0 Security BCP) §4.14.2 (standard text, not fetched) and search extract (arxiv.org/pdf/2608.04115) | 2026-11-23 | primary / secondary | Refresh tokens of public clients must be sender-constrained or rotated with replay detection; on detected reuse the authorization server cannot tell attacker from client and may revoke the active refresh token. The BCP leaves the exact family-revocation policy to the server. |
| S2 | auth0.com/docs/secure/tokens/refresh-tokens/refresh-token-rotation (search extract) | 2026-11-23 | primary (vendor) | With rotation enabled, reusing an already-rotated refresh token makes Auth0 invalidate the whole token family; a configurable leeway allows a client that lost a response to retry. |
| S3 | RQ-0187 S4 (learn.microsoft.com refresh-tokens extract) | 2026-11-23 | primary (extract) | Microsoft returns a new refresh token on every use, does not revoke the old one when used, and tells clients to delete the old token after storing the new one. |
| S4 | RFC 7636 §4.1, §7.1 (standard text) | 2026-11-23 | primary | The code verifier is a high-entropy secret that proves possession at the token request; it is needed only for that one request. |
| S5 | Spring Security `HttpSessionOAuth2AuthorizationRequestRepository.removeAuthorizationRequest` (called by `OAuth2LoginAuthenticationFilter` before the token exchange); Auth.js `pkce` check (`checks.ts`: the PKCE cookie is read once and cleared in the callback response); Keycloak (authentication session removed after code-to-token) — from source code as known to the author | 2026-11-23 | comparable systems | Each removes the stored authorization request / verifier when the callback consumes it, before or right after the token exchange; none keeps it after use. Expired entries disappear with the session or cookie. |
| S6 | PostgreSQL 16/17 docs, CREATE FUNCTION "Writing SECURITY DEFINER Functions Safely" (standard text, not fetched) | 2026-11-23 | primary | Set `search_path` so it excludes schemas writable by untrusted users, with `pg_temp` written last explicitly; revoke EXECUTE from PUBLIC and grant only to the roles that need it; the function runs with its owner's privileges, so the owner matters. |
| S7 | Django `transaction.on_commit`, Rails `after_commit`, GitLab development docs "transaction guidelines" (avoid external HTTP calls inside a database transaction) — as known to the author | 2026-11-23 | comparable systems | Frameworks give a hook to run network work after commit; large Rails apps forbid external calls inside a transaction because they hold a connection and locks for the call's duration. |
| S8 | Repository: `apps/api/src/tenancy/tenant.interceptor.ts`, `tenant-tx.ts`, `packages/modules/ap/src/inbox-mailbox.ts` (poll steps already split into short transactions with network in between), `packages/db/src/migrate.ts` (runner allows `DROP NOT NULL`, refuses `DROP CONSTRAINT`), migrations 0074, 0083 | 2026-11-23 | source code | The interceptor runs access checks and the handler in one `withTenant` transaction; `last_error` has an unnamed CHECK that cannot be widened; `code_verifier` is `NOT NULL`. |

## Findings

1. **Q1.** The callback has three phases: consume the pre-authorization (short write), exchange
   the code (network), save the mailbox and audit (short write). Comparable systems either run
   network work after commit (S7) or remove the authorization request before the exchange (S5).
   In this codebase the poller already does exactly that (S8). The handler cannot do it inside
   TenantInterceptor's single transaction, and marking the route `@Public` would move session
   and permission checks into the controller (rejected: ADR-0023 says never ad hoc). The
   smallest safe mechanism is a per-route opt-in in the interceptor: run the access checks in
   their own committed transaction, then run the handler with no open transaction and give it a
   `TenantTx.run(fn)` that opens a fresh tenant transaction which **re-verifies the session and
   repeats the permission, MFA and step-up checks** before `fn`. A session revoked or a role
   removed during the provider call therefore stops the save. To keep the interceptor's audit
   contract simple, the opt-in is allowed only on read-method routes without SoD (the callback
   is a GET that audits itself); anything else fails closed.
2. **Q2.** Keeping the old refresh token is safe with Microsoft (S3) but not in general: with
   rotation and reuse detection (S1, S2) presenting the old token can revoke the whole grant. A
   failed re-seal is usually transient (KMS or database hiccup), so retry a few times with a
   short backoff; if it still fails, stop the poll before using the access token, record an
   operator-visible state on the mailbox and return a named error, so the operator sees it
   before the provider's next answer is `invalid_grant`. The `last_error` CHECK cannot be widened
   (S8), so the state is a new column `secret_rotation_failed_at`, cleared by the next
   successful rotation, and the poll result error `token_rotation_failed`.
3. **Q3.** The verifier is needed only for the one token request (S4); comparable systems drop it
   on consumption (S5). Clear it (set NULL, stamp `verifier_cleared_at`) in the same statement
   that consumes the request — the callback reads it from that statement — and also on cancel.
   Expired, never-used requests are swept by the tenant's 5-minute inbox poll job and by each
   new start. A trigger makes the column write-once-to-NULL for every role. Sealing it was
   rejected: it would add a KMS round-trip for a value that is useless after one use.
4. **Q4.** Test the catalog: owner `lf_migrator`, `prosecdef = true`, `proconfig` exactly
   `search_path=pg_catalog, pg_temp`, no EXECUTE for PUBLIC, EXECUTE for `lf_app` (S6); the
   guard trigger functions' pinned search paths too.

## Conclusion

Adopt Findings 1–4. Finding 1 is a change to the request-transaction model and is recorded in
ADR-0108 (security). Decisions: DL-0960..DL-0964.

## Follow-ups

None outside T-0243.
