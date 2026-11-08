---
id: RQ-0035
title: How does preview return exactly what post() would write, and how do we prove it changed nothing?
status: resolved
opened: 2026-10-25
resolved: 2026-10-25
opened_by: claude
linked_tasks: [T-0026]
linked_adrs: [ADR-0004]
superseded_by:
---

# RQ-0035 — Posting preview: parity with post() and a proof that nothing changed

## Question

T-0026 (design §3.9: "A preview mode runs steps 1–4 and returns the journal without writing it").
T-0025 already shipped `preview()` (SS-PLAT-65 proved "no journal rows" with a five-value
snapshot inside a READ ONLY transaction). Since then, posting also maintains `account_balance`
by trigger (T-0027), writes outbox events and pg-boss jobs (T-0030) and records period overrides.

- Q1. Where can `preview()` and `post()` disagree for the same command (preview accepts what post
  refuses, or returns a journal post would not write)?
- Q2. What must the "writes nothing" proof cover so that it holds for every table and counter,
  including ones added later?
- Q3. Can preview use a "write then roll back" approach (savepoint) to reuse the database checks?
- Q4. Should preview force its transaction READ ONLY?
- Q5. What does preview return when the idempotency key has already posted?

## Why it matters

The "show me the journal" button and the rule tester (design §3.9, §4.5) show users what will be
posted. If preview accepts a command that post later refuses, or shows lines that differ from
what is stored, users approve something other than what is booked. If preview writes anything
(a number, a dimension set, an audit row, a sequence value), it breaks gapless numbering (§3.4)
or the audit trail.

## Sources consulted

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S1 | `packages/ledger/src/posting-engine.ts` (base 658a793) | 2026-10-25 | source code | `preview()` runs checkCommand → validateAndBuild → checkBuilt; `post()` additionally takes the idempotency lock, looks up the key (replay / IDEMPOTENCY_CONFLICT) and runs `write()`: period override insert, `next_document_number`, entry + dimension sets + lines, `dimension_set_missing_required`, outbox hook. |
| S2 | `packages/db/migrations/0007_ledger_journal.sql` | 2026-10-25 | source code | `FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user`; `tax_code_id` and `party_id` have no FK yet (T-0034, T-0036). |
| S3 | `packages/db/migrations/0018_ledger_periods.sql` `period_override_check()` | 2026-10-25 | source code | BEFORE INSERT on `period_override`: refuses (42501) unless `app.user_has_period_permission(tenant, granted_by, 'period.lock.override')`; writes an `audit.audit_log` row. |
| S4 | `packages/db/migrations/0003_audit_log.sql`, `0024_outbox.sql`, `0009_ledger_hash_chain.sql`, `0010_ledger_number_series.sql`, `0023_ledger_account_balance.sql` | 2026-10-25 | source code | Write targets of a post: audit_log (identity sequence), outbox_event + pgboss.job, journal_chain_head, number_series counter, account_balance. |
| S5 | PostgreSQL 17 manual §9.17 Sequence Manipulation Functions, https://www.postgresql.org/docs/17/functions-sequence.html | cited from prior reading (network to postgresql.org not used) and confirmed by S7 E1 | primary | "nextval … operations are never rolled back … a sequence object cannot be used if 'gapless' assignment of sequence numbers is needed." |
| S6 | PostgreSQL 17 manual — SET TRANSACTION, https://www.postgresql.org/docs/17/sql-set-transaction.html | as S5, confirmed by S7 E3/E5 | primary | A read-only transaction refuses INSERT/UPDATE/DELETE on non-temporary tables; the transaction can be switched to read-only after it has run queries, but not back. |
| S7 | Experiment: spike vitest file (kept outside the repo in the task scratchpad, `t0026/zz-rq0035-spike.db.test.ts`) on the repo's local test cluster (PostgreSQL 16) | 2026-10-25 | experiment | E1–E6 below. |

S7 results:

- **E1** `BEGIN; SELECT nextval('audit.audit_log_id_seq'); ROLLBACK;` — `pg_sequences.last_value`
  goes from `null` to `1` and stays there after the rollback.
- **E3** In a READ ONLY transaction, an INSERT as lf_app fails with SQLSTATE `25006`.
- **E4** `pg_advisory_xact_lock` works in a READ ONLY transaction as lf_app.
- **E5** `SET TRANSACTION READ ONLY` after a `SELECT 1` in the same transaction is accepted.
- **E6** `count(*)` plus `md5(string_agg(md5(t::text) ORDER BY …))` over `app.number_series`
  changes after `next_document_number` advanced a counter while the row count stayed 1.

## Findings

1. Preview and post share validate/build/check, so lines, accounts, rounding, dimensions,
   parties, currency, period and lock-date redirect are already identical. *(fact, S1)*
2. Gaps where post refuses but preview (at base) accepts *(fact, S1–S3)*:
   - a. `createdBy` that is not a user of the tenant: post fails on the `created_by` foreign key
     (raw 23503); preview passes.
   - b. `periodOverride` from a user without `period.lock.override`: post fails in the
     `period_override_check` trigger (raw 42501); preview passes.
   - c. Idempotency key already posted for another document: post throws
     `IDEMPOTENCY_CONFLICT`; preview builds a journal.
   - d. Key already posted for the same document: post writes nothing and replays the first
     result; preview shows a journal that will never be written.
3. The database-side required-dimension check in `write()` (`dimension_set_missing_required`)
   uses the same rule as the in-memory check (account `required_dimensions` codes vs. the codes
   of the set's values), so it is defence in depth, not a gap. *(inference from S1 and migration
   0006; tested by the parity property)*
4. A savepoint "write then roll back" preview would still consume sequence values (audit_log
   identity, any pg-boss sequence) because `nextval` is never rolled back, and it would take the
   number-series row lock and the hash-chain head lock, serialising previews with real posts.
   *(fact S5, S7 E1; inference for locks from S4)* So Q3: no.
5. Forcing READ ONLY inside preview would make the caller's whole transaction read-only (S6, E5),
   which breaks "preview, then post in the same transaction". So Q4: no; the tests run preview in
   a READ ONLY transaction as an extra proof, and the engine stays read-only by construction.
6. A complete proof must compare, before and after, every table in every non-system schema
   (row count and an order-independent content hash, which also catches UPDATEs, E6) and every
   sequence's `last_value` (E1). Enumerating tables from the catalogue makes it cover tables that
   future tasks add (subledger_entry, allocation) without editing the test. *(inference from S4,
   S7)*

## Conclusion / decision

- Close gaps 2a–2b in the shared validate step so post and preview refuse them the same way,
  with typed errors before any write: `UNKNOWN_USER` (createdBy not a user of the tenant) and
  `OVERRIDE_NOT_PERMITTED` (message names `period.lock.override`). The database checks stay.
- Gaps 2c–2d: preview looks the key up (no lock — it writes nothing, so it needs none). A key
  used by another document → `IDEMPOTENCY_CONFLICT` (as post). A key already posted for this
  document → `ALREADY_POSTED` carrying the existing entry id and number: post would write
  nothing, so there is no journal to show; the caller shows the stored entry instead.
- No migration, no savepoint, no READ ONLY switch inside preview.
- Prove SS-PLAT-15 with a whole-database fingerprint (all tables in non-system schemas: count +
  content hash; all sequences: last_value) taken by the superuser before and after preview, on
  a database with pg-boss installed (packages/outbox test), and with a fast-check property that
  preview equals what post stores for random valid commands and that both agree on the outcome
  for random commands that may be invalid.

## Confidence

high — source code read and an executed experiment for each database behaviour relied on.

## Follow-ups

- When subledger entries (AR/AP tasks) and posting rules (T-0028/T-0029) land in `write()` or
  `validateAndBuild()`, the fingerprint and parity tests cover them without changes; any new
  database-only check in `write()` must get an in-memory twin (or preview will diverge).

**Affects:** packages/ledger posting engine (T-0026), design §3.9, ADR-0004.
