---
adr: 0108
title: "Own-transaction routes for slow external calls; bills mailbox OAuth hardening (verifier lifetime, failed re-seal)"
status: Accepted
date: 2026-11-24
author: claude
category: security
human_gate: yes (delegated, DL-0691)
supersedes: none
superseded_by: none
---

# ADR-0108: Own-transaction routes for slow external calls; bills mailbox OAuth hardening

## Status

Accepted 2026-11-24 by the building agent under the product owner's standing instruction DL-0691
(security decisions delegated if backed by research, a decision-log entry, tests and an
independent security review). Research: RQ-0190. Decisions: DL-0960..DL-0964. Tests are listed
below. The independent security review is part of T-0243's cross-provider review step and is
still pending.

Amends design §6.7 / TenantInterceptor ("one tenant transaction per request") for routes that
opt in. Amends ADR-0105 rules 3 and 6 as described below. Everything else in ADR-0105 stands.

## Context and problem statement

Security review r12 (DL-0899) found these problems in T-0216:
- **M1:** the bills-mailbox OAuth callback exchanges the code with the provider (up to 15 s)
  inside the request's tenant transaction. This holds a pooled `lf_app` connection and the
  request row lock.
- **L1:** a rotated refresh token whose re-seal fails is dropped, and the old token is kept.
- **L2:** the PKCE verifier stays in plain text forever.
- **L3:** no test checks the rotation function's owner, SECURITY DEFINER flag or search_path.

TenantInterceptor wraps every non-public handler in a single `withTenant` transaction. A handler
therefore cannot move network I/O out of that transaction.

## Decision drivers

- No network I/O inside a database transaction. The poller already follows this rule (RQ-0190 S7, S8).
- Access checks stay central (ADR-0023: never ad hoc in controllers). There must be no gap in
  session or permission verification.
- A secret lives no longer than it is useful (RFC 7636; comparable systems, RQ-0190 S5).
- A lost rotated refresh token must be visible to an operator, because providers with reuse
  detection may revoke the grant (RQ-0190 S1, S2).
- Forward-only, additive migrations (the runner refuses DROP CONSTRAINT).

## Considered options

1. **`@OwnTransactions` route opt-in in TenantInterceptor (chosen).**
2. Mark the callback `@Public` and verify the session in the controller. Rejected: it duplicates
   and weakens the central checks (ADR-0023).
3. Use a second connection inside the request transaction. Rejected: the request connection
   would still be held, idle in transaction, for the whole provider call.
4. Seal the verifier instead of clearing it. Rejected: it adds a KMS round-trip to protect a value
   that is useless after one use (RQ-0190 F3).

## Decision outcome

1. **`@OwnTransactions()`** (handler-level, `apps/api/src/tenancy/own-transactions.decorator.ts`)
   works as follows:
   - TenantInterceptor runs every access check in its own tenant transaction and commits it.
     The checks are session/token verification, MFA, permission, step-up and the conditional
     step-up.
   - The handler then runs with **no transaction open**. `TenantTx.get()` throws on such a
     route.
   - `TenantTx.run(fn)` opens a fresh `withTenant` transaction. It **repeats every access check**
     and then runs `fn`. A session revoked or a role removed meanwhile is refused (401/403) and
     audited like any other refusal.
   - Allowed only on read-method routes without `@SoD`. The handler writes its own audit row,
     because the interceptor writes none for read methods. Any other use fails closed (500).
2. **The mailbox OAuth callback** uses this opt-in and runs in three steps:
   - It consumes the pre-authorization and clears the verifier in one statement and one
     transaction.
   - It exchanges the code with no transaction open.
   - It saves the mailbox and writes the audit row in a second transaction.

   A failed exchange leaves the request used up, as before.
3. **The verifier is write-once-to-NULL** (migration 0086; built as 0084):
   - `code_verifier` is nullable, and `verifier_cleared_at` is set exactly when it is NULL.
   - A guard trigger (for every role) refuses an INSERT without a verifier. It refuses any new
     value, and it refuses clearing the verifier of a live (unconsumed, unexpired) request.
   - The verifier is cleared on consume and on cancel. A sweep clears it on expiry: each start
     and each tenant inbox poll (every 5 minutes) runs `clearStaleMailboxOAuthVerifiers`.
4. **A failed re-seal is retried, then surfaced.**
   - Re-sealing a rotated refresh token (seal plus `app.rotate_bill_inbox_refresh_token`) is
     retried twice, after 100 ms and after 400 ms.
   - If it still fails, the poll stops before the access token is used. It sets
     `app.bill_inbox_mailbox.secret_rotation_failed_at` and returns `token_rotation_failed`,
     which the worker logs. The flag is visible as `secretRotationFailedAt` in the mailbox view.
   - The next good rotation clears the flag in the same transaction.
   - If the row is no longer an active OAuth mailbox, the poll is `skipped`.
5. **Catalog tests** pin the rotation function: owner `lf_migrator`, SECURITY DEFINER,
   `search_path=pg_catalog, pg_temp`, EXECUTE only for `lf_app` (plus its owner), not PUBLIC.
   They also pin the guard functions' search paths.

### Consequences

- Good:
  - A slow or hostile provider cannot tie up the API connection pool or hold locks.
  - The checks in each later transaction close the window between the first check and the
    save.
  - The verifier lives at most ~15 minutes after it stops being useful.
  - Rotation failures are no longer silent.
- Bad:
  - The callback does a few more queries, because it runs the access checks three times.
  - A request may already be consumed when the save is refused. The user then starts again.
  - Existing consumed rows keep their verifiers until the tenant's next poll sweep. FORCE RLS
    blocks a migration backfill.
- Follow-ups: none. Any other route that needs this mechanism must cite this ADR.

## Validation

- `packages/modules/ap/src/mailbox-oauth-hardening.db.test.ts`:
  - SS-PLAT-196: no `lf_app` transaction is open during the exchange, the request is already
    consumed and the verifier cleared, and the save and audit follow; a refused exchange saves
    nothing.
  - SS-PLAT-197: a transient KMS failure is retried; a lasting one sets the flag, makes no IMAP
    connection and keeps the old token; the next good rotation clears the flag.
  - SS-PLAT-198: the verifier is cleared on cancel and by the sweep; the guard trigger works; the
    function catalog is as described in rule 5.
- `apps/api/src/ap/bills-mailbox-oauth.db.test.ts`, SS-PLAT-196 over HTTP: no open `lf_app`
  transaction while the provider waits; a session revoked during the exchange gives 401 and
  saves nothing.
- The full `api-db` project covers the interceptor refactor.

## Links

RQ-0190, RQ-0187, ADR-0105, ADR-0023, ADR-0018, DL-0691, DL-0899, T-0243, T-0216.
