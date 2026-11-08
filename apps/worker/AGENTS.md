# apps/worker — outbox consumer, sync and scheduled jobs

> Local rules for this directory. They **add to** the root [`AGENTS.md`](../../AGENTS.md) and
> never contradict it; if they seem to, the root file wins. `CLAUDE.md` here only imports this file.

## What lives here
pg-boss workers (design §7.1, ADR-0008): outbox consumer, Salesforce write-back, email, batch
billing, nightly reconciliation, scheduled jobs.

## Local rules
- Consume the **transactional outbox**; each outbox event produces exactly one downstream
  effect, and handlers are **idempotent** (safe to replay any message — design principle 4).
- Never write ledger tables; to post, call the posting API in `packages/ledger`.
- Retries: exponential backoff from 1 min to 6 h, then a **Sync issues** inbox entry with error,
  payload and one-click retry (design §5.6).
- Respect the Salesforce `/limits` throttle (default 25 % of the daily API allocation).
- A Salesforce outage never blocks accounting: postings continue, write-backs queue.
- Every job sets `app.tenant_id` for its transaction; no cross-tenant batch without explicit
  per-tenant transactions.
- No `sleep`-based waits in tests; drive time with fake timers or job-queue test helpers.

## Tests
- Colocated `apps/worker/src/**/*.test.ts` and `apps/worker/src/**/*.db.test.ts`: replay produces no
  duplicate effect; retry schedule; terminal failure → sync issue.
