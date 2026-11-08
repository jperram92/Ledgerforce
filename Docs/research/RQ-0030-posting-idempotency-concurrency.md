---
id: RQ-0030
title: How does the posting engine make "same idempotency key posts once" hold under concurrency?
status: resolved
opened: 2026-10-25
resolved: 2026-10-25
opened_by: claude
linked_tasks: [T-0025]
linked_adrs: [ADR-0004]
superseded_by:
---

# RQ-0030 — Posting idempotency under concurrency

## Question

SS-PLAT-14: a posting command submitted twice with the same idempotency key must post once and
the second call must return the first result — including when the two calls run at the same
time in two transactions.

- Q1. Is a schema change needed, or does migration 0007 already guard the key?
- Q2. What happens in PostgreSQL when two transactions insert the same key concurrently?
- Q3. How can the second caller *return the first result* instead of failing?
- Q4. Does this depend on the caller's isolation level?

## Why it matters

Design §3.9 step 1 ("command arrives … with an idempotency key"), §5.6 (connectors redeliver:
Salesforce events, Stripe webhooks). Guessing wrong either double-posts (two entries for one
event) or turns a harmless retry into an error the connector then retries forever.

## Sources consulted

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S1 | `packages/db/migrations/0007_ledger_journal.sql` | 2026-10-25 | source code | `UNIQUE (tenant_id, company_id, idempotency_key)` on `app.journal_entry`; key length 1..200. |
| S2 | `packages/db/migrations/0018_ledger_periods.sql` | 2026-10-25 | source code | Existing transaction advisory locks use `hashtextextended('lf.<namespace>:' \|\| id, 0)` keys (`lf.period:`, `lf.fiscal_calendar:`). |
| S3 | PostgreSQL 17 manual — 13.2.1 Read Committed Isolation Level, https://www.postgresql.org/docs/17/transaction-iso.html | not reachable from this session (DNS blocked); cited from prior reading, confirmed by S5 | primary | In Read Committed each statement sees data committed before that statement began; Repeatable Read sees a snapshot from the first statement of the transaction. |
| S4 | PostgreSQL 17 manual — 13.3.5 Advisory Locks and 9.27.10 Advisory Lock Functions, https://www.postgresql.org/docs/17/explicit-locking.html | as S3 | primary | `pg_advisory_xact_lock(bigint)` waits for the lock and releases it automatically at the end of the transaction. |
| S5 | Experiment: `scratchpad/t0025/exp.ts` on a throw-away PostgreSQL 16.15 cluster started with the repo's own harness (`startTestDatabase`, local mode) | 2026-10-25 | experiment | E1–E5 below. |

S5 results (verbatim summary of the run output):

- **E1** A takes `pg_advisory_xact_lock(hashtextextended('lf.posting_idem:x',0))`, inserts `x`,
  holds; B (Read Committed) blocks on the same lock; after A commits, B's next SELECT sees `x`
  (count 1).
- **E2** Without the lock, B's INSERT of the same unique key *waits* for A and then fails with
  `23505` naming the unique constraint once A commits.
- **E3** Same as E1 but B is REPEATABLE READ and ran a query before taking the lock: after the
  lock B still sees count 0 (its snapshot predates A's commit).
- **E4** In Read Committed, after `23505` inside `SAVEPOINT s`, `ROLLBACK TO SAVEPOINT s` keeps
  the transaction usable and a following SELECT sees A's row.
- **E5** The posting-key namespace string gives a different 64-bit key from the period namespace
  for the same suffix (different strings; collisions would only cost a wait, never correctness).

## Findings

1. The database already refuses a second entry with the same (tenant, company, key) (S1). No
   migration is needed for T-0025. *(fact)*
2. A plain "look up the key, else insert" is racy: both transactions miss the key, the second
   insert then waits and fails with 23505 (S5 E2). The unique constraint prevents a double post,
   but the second caller gets an error instead of the first result. *(fact)*
3. A transaction advisory lock on the key taken *before* the lookup serialises the two calls;
   in Read Committed the second caller's lookup, being a new statement after the lock, sees the
   committed first entry and can return it (S3, S4, S5 E1). *(fact)*
4. In Repeatable Read / Serializable, a snapshot taken before the lock hides the winner (S5 E3);
   the insert would then hit 23505. *(fact)* Inference: the engine must still catch that case
   and report it as a typed error rather than a raw database error; the caller can retry in a new
   transaction, which then replays.
5. A savepoint around the write lets the engine recover from 23505 in Read Committed and read
   the winner (S5 E4). *(fact)* This is a fallback only: with the lock it does not occur unless
   something inserted the key without the engine.

## Conclusion / decision

- No schema change. Use the existing unique key as the last line of defence.
- `post()`: after the pure in-memory checks, take
  `pg_advisory_xact_lock(hashtextextended('lf.posting_idem:' || tenant || ':' || company || ':' || key, 0))`,
  then look up the key; found → return the stored entry as the result (`replayed: true`) without
  validating or writing again. Not found → validate, build, write inside `SAVEPOINT`.
- On 23505 from the idempotency constraint: roll back to the savepoint, look the key up again;
  found → return it; not found (non-Read-Committed snapshot) → typed `IDEMPOTENCY_RACE` error.
- A replay whose stored `source_type`/`source_id` differ from the command's is a key reused
  for another document → typed `IDEMPOTENCY_CONFLICT`, nothing written.
- Document that `post()` expects Read Committed (the PostgreSQL default, and what `withTenant`
  uses).

## Confidence

`high` — executed experiment on PostgreSQL 16 (S5) plus the schema (S1). The manual pages (S3,
S4) could not be re-fetched in this session; the experiment covers every behaviour relied on.

## Follow-ups

- A full payload fingerprint (same key, different lines → conflict) needs a stored hash of the
  command; not in T-0025 (no column exists; additive migration later if the product owner wants
  it). Recorded in DL-0136.
- Re-run S5 on PostgreSQL 17 when CI has it (DL-0007).

**Affects:** packages/ledger posting engine (T-0025), connectors' retry handling (T-0030+).
