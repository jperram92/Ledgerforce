---
id: RQ-0032
title: How is account_balance kept equal to the posted journal, in the posting transaction, without lost updates?
status: resolved
opened: 2026-10-25
resolved: 2026-10-25
opened_by: claude
linked_tasks: [T-0027]
linked_adrs: [ADR-0004, ADR-0005]
superseded_by:
---

# RQ-0032 — account_balance maintenance under concurrency

## Question

Design §3.3: `account_balance` (company, account, period, dimension_set, debit_total,
credit_total) is "updated in the posting transaction; reports read from here". T-0027 must
build it.

- Q1. What is the key? The design lists company, account, period and dimension set; the lead's
  brief for T-0027 adds currency.
- Q2. Where does the update run: an explicit call in the engine's write step, or the database?
  `lf_app` must have no direct write path to the table.
- Q3. How do two concurrent postings to the same account avoid a lost update?
- Q4. Can two concurrent postings deadlock on balance rows, and how is that avoided?
- Q5. Which lines count: draft entries, reversed entries, rows written outside a tenant context?

## Why it matters

Reports (TB, P&L, balance sheet; design §8.1) will read balances from this table. If it can
drift from the journal (lost update, double count, a missed path), every report is wrong while
the journal itself is still right — a silent misstatement.

## Sources consulted

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S1 | `Docs/solution-design/solution-design.md` §3.3, §3.7, §3.9 | 2026-10-25 | design | account_balance key fields; "Updated in the posting transaction; reports read from here"; documents in any currency with base amounts in company currency; step 5 writes journal, subledger, balance updates and outbox in one transaction. |
| S2 | `packages/db/migrations/0007`, `0008`, `0009`, `0018` | 2026-10-25 | source code | Lines carry `txn_currency`, `txn_amount` (unsigned), `fx_rate`, base `debit`/`credit`; posted lines are immutable; the hash chain locks a per-company head row at commit; `journal_entry.period_id` is set by the period trigger on INSERT. |
| S3 | PostgreSQL 16/17 manual — INSERT, "ON CONFLICT Clause", https://www.postgresql.org/docs/17/sql-insert.html | not reachable from this session (proxy policy 403); cited from prior reading, confirmed by S5 | primary | ON CONFLICT DO UPDATE guarantees an atomic insert-or-update outcome under concurrency; a command cannot affect the same row twice. |
| S4 | PostgreSQL 16/17 manual — CREATE TRIGGER, https://www.postgresql.org/docs/17/sql-createtrigger.html | as S3 | primary | AFTER … FOR EACH STATEMENT triggers may declare `REFERENCING NEW TABLE AS …` (transition relation); not allowed with a column list. |
| S5 | Experiment `scratchpad/t0027/exp.ts` on PostgreSQL 16.15 started by the repo harness (`startTestDatabase`, local mode); output `scratchpad/t0027/exp.out` | 2026-10-25 | experiment | E1–E6 below. |

S5 results (verbatim summary of the run output):

- **E1** Two transactions run `INSERT … ON CONFLICT (k) DO UPDATE SET d = b.d + excluded.d` on
  an existing row (+10, +5): B waits for A, then adds to A's committed value → 15.0000.
- **E1b** Same on a key that does not exist yet: B's speculative insert waits, then updates → 15.0000, no error.
- **E2** Naive read-then-write in Read Committed (both read 0, write 0+10 and 0+5) → 5.0000: one
  update lost.
- **E3** The same key twice in one upsert statement fails: `21000 ON CONFLICT DO UPDATE command
  cannot affect row a second time` → lines must be grouped per key first.
- **E4** An AFTER INSERT FOR EACH STATEMENT trigger with `REFERENCING NEW TABLE` aggregates a
  multi-row insert correctly (s = 1 + 2). With a column list (`UPDATE OF status`) a transition
  table is refused (`0A000`).
- **E5** Two transactions upserting keys x,y in opposite order: `40P01 deadlock detected` for
  one. Each upserting both keys in one statement with `ORDER BY k`: no deadlock, B waits and succeeds.
- **E6** A SECURITY DEFINER function owned by a non-superuser, called by a role with SELECT
  only, sees only the session tenant's rows under FORCE RLS; the caller's own INSERT is
  `42501 permission denied`.

## Findings

1. Lines carry a transaction currency and an unsigned `txn_amount` beside the base amounts (S2).
   A per-currency balance (foreign-currency balance of a bank or AR account) is what the
   period-end revaluation (§3.7, Phase 1) and multi-currency reports need; base totals alone
   cannot give it back. *(fact for the data; inference for the need)*
2. `INSERT … ON CONFLICT DO UPDATE SET total = total + excluded.total` adds atomically under
   concurrency, both for an existing and a new key (S3, S5 E1/E1b). A read-then-write loses
   updates (S5 E2). *(fact)*
3. Keys must be unique within one upsert statement (S5 E3), so lines are summed per key first. *(fact)*
4. Row locks taken in a consistent (sorted) order within one statement do not deadlock (S5 E5).
   Entries posted in one call are one INSERT of lines (the engine inserts all lines in one
   statement), so one sorted statement per entry. Two caller transactions each posting several
   entries can still lock in different orders across statements; PostgreSQL then detects the
   deadlock and aborts one (40P01) — the posting is rolled back, never half-written. *(fact + inference)*
5. A statement-level AFTER INSERT trigger on `journal_line` sees exactly the rows of that
   statement (S4, S5 E4) and runs inside the writer's transaction. As SECURITY DEFINER owned by
   `lf_migrator` it can write a table on which `lf_app` has SELECT only, and FORCE RLS still
   scopes it to the caller's tenant (S5 E6). *(fact)*
6. The database (trigger) is the stronger place: it cannot be forgotten by a future write path,
   it counts every line exactly once at insertion, and posted lines never change afterwards
   (0008), so the balance stays equal to the sum of posted lines by construction. An explicit
   engine call to a SECURITY DEFINER function would also be callable by any `lf_app` code path
   and would need its own "applied once" guard. *(inference)*
7. Draft lines must not count until the entry leaves draft; posted → reversed changes nothing
   (the reversal is its own entry with mirrored lines, 0008). A draft → posted/reversed change
   (owner only today; the engine posts directly) must add the entry's lines then. A row-level
   AFTER UPDATE OF status trigger handles it (no transition table needed, E4). *(inference from S2)*
8. Under FORCE RLS a SECURITY DEFINER function sees nothing when no tenant is set (superuser
   writes, the cross-tenant suite's `session_replication_role = replica` seeding, which skips
   triggers anyway). Rows of another tenant cannot be inserted by `lf_app` (RLS WITH CHECK runs
   before AFTER triggers). *(fact)*

9. Observed while testing (SS-PLAT-67 and its mutation check): gapless numbering (0010) locks
   one counter row per (company, series) until commit, so postings of the *same* source type in a
   company already run one at a time; a read-then-write balance mutant survived a test that used
   one series. Balance rows are still contended by postings of different source types (one
   series each) and by any future writer, so the atomic upsert remains necessary; the concurrency
   test uses eight series. With eight series the read-then-write mutant loses updates (and the
   accumulate-only guard also refuses its stale writes as decreases), and a mutant that orders
   rows by side instead of key deadlocks (40P01). *(fact, from the run)*

## Conclusion / decision

- Key (Q1): (tenant, company, account, period, dimension set, **transaction currency**). Base
  `debit_total`/`credit_total` are the design's columns; `txn_debit_total`/`txn_credit_total`
  add the per-currency amounts (Σ `txn_amount` on the debit / credit side). Summing a company's
  rows over currencies gives the design's base balance per (account, period, dimension set).
  Amounts NUMERIC(19,4) (ADR-0005), all ≥ 0.
- Where (Q2): migration 0023 creates the table (lf_app: SELECT only) and an AFTER INSERT FOR EACH
  STATEMENT trigger on `journal_line` (`REFERENCING NEW TABLE`), SECURITY DEFINER owned by
  `lf_migrator`, that sums the inserted lines of non-draft entries per key and upserts them —
  in the engine's write savepoint, so a failed post leaves no balance change. The engine's write
  step is unchanged apart from documenting this; no new engine code path writes the table.
- Concurrency (Q3, Q4): `ON CONFLICT … DO UPDATE SET x = account_balance.x + EXCLUDED.x`, rows
  grouped and `ORDER BY` key. Proven with a real concurrent DB test (SS-PLAT-67).
- Lines (Q5): non-draft entries only; an AFTER UPDATE OF status row trigger adds an entry's lines
  when it leaves draft. Rows outside the session tenant are skipped (rule from the cross-tenant
  protocol); `accountBalanceDrift()` (packages/ledger, a read-only SQL query) reports any key where the table
  differs from the sum of posted lines, for audits and the property test.
- Guard: UPDATE may only increase totals with the key unchanged; DELETE and TRUNCATE are refused
  (binds the owner too).
- Overflow: a total above NUMERIC(19,4) (≈ 10^15) makes the posting fail loudly (22003); not a
  realistic SMB balance; recorded, not handled.
