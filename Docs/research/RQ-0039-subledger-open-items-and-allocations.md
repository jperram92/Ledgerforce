---
id: RQ-0039
title: How are AR/AP open items and allocations stored, kept equal to the control accounts, and protected from over-allocation under concurrency?
status: resolved
opened: 2026-10-26
resolved: 2026-10-26
opened_by: claude
linked_tasks: [T-0028]
linked_adrs: [ADR-0004, ADR-0005, ADR-0035]
superseded_by:
---

# RQ-0039 — subledger open items and allocations

## Question

Design §3.3 lists `subledger_entry` (party_id, document_id, due_date, original_amount,
open_amount, currency — "AR/AP open items for ageing and allocation") and `allocation`
(from_entry, to_entry, amount, fx_difference — "receipt-to-invoice and payment-to-bill
matching"). T-0028 builds the mechanics.

- Q1. Which posted lines create an open item, and what sign does an item carry?
- Q2. In which currency are `original_amount` / `open_amount`, and how does the subledger stay
  comparable with the control account, which is in base currency?
- Q3. What is `fx_difference`, and may it be posted now?
- Q4. How are open amounts maintained when `lf_app` has only SELECT/INSERT on ledger tables
  and posted data is immutable?
- Q5. How do two concurrent allocations against one open item avoid over-allocation?
- Q6. How is an allocation undone?
- Q7. What does "AR/AP subledger = control" (design §10.8 item 3, SS-UC10-08) compare?

## Why it matters

The subledger is the source for ageing, statements and allocation; the control account is the
GL. If they drift, the balance sheet and the ageing disagree with no way to tell which is
right. Over-allocation would show an invoice as paid twice.

## Sources consulted

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S1 | `Docs/solution-design/solution-design.md` §3.2, §3.3, §3.7, §3.9, §10.8 | 2026-10-26 | design | Control accounts "accept postings only from their subledger … so subledger and GL can't drift"; subledger_entry and allocation fields; "Realised FX gain/loss posts at allocation"; step 5 writes journal, subledger entries, balances and outbox in one transaction; invariant "AR subledger = AR control; AP subledger = AP control". |
| S2 | `Docs/accounting/postings.md` | 2026-10-26 | golden postings | Every golden posting is Draft, including the realised FX posting at allocation. |
| S3 | `packages/db/migrations/0005`, `0007`, `0008`, `0023`; DL-0136 | 2026-10-26 | source code | AR_CONTROL / AP_CONTROL accounts carry `is_control`; lines hold base debit/credit plus `txn_currency`, unsigned `txn_amount`, `fx_rate`; posted lines immutable; lf_app SELECT/INSERT only; account_balance is maintained by SECURITY DEFINER triggers; control accounts accept only their subledger's source types. |
| S4 | PostgreSQL 17 manual — SELECT, "The Locking Clause", https://www.postgresql.org/docs/17/sql-select.html#SQL-FOR-UPDATE-SHARE | not reachable from this session (proxy policy, as RQ-0032 S3); cited from prior reading, confirmed by S8 E2 | primary | FOR UPDATE requires UPDATE privilege on the table. |
| S5 | PostgreSQL 17 manual — 13.2.1 Read Committed, https://www.postgresql.org/docs/17/transaction-iso.html#XACT-READ-COMMITTED | as S4; confirmed by S8 E4 | primary | An UPDATE / FOR UPDATE that waits for a concurrent writer re-evaluates its row against the committed version. |
| S6 | PostgreSQL 17 manual — 9.28 Trigger functions / `pg_trigger_depth()`, https://www.postgresql.org/docs/17/functions-info.html | as S4; confirmed by S8 E3 | primary | `pg_trigger_depth()` is the current nesting level of triggers (0 outside a trigger). |
| S7 | PostgreSQL 17 manual — CREATE POLICY, https://www.postgresql.org/docs/17/sql-createpolicy.html | as S4; confirmed by S8 E1 | primary | WITH CHECK expressions are enforced on the row as it will be stored, i.e. after BEFORE ROW triggers; the experiment shows the RLS check fails before table CHECK constraints. |
| S8 | Experiment `scratchpad/t0028/exp-rq0039.db.test.ts` on the repo harness (PostgreSQL 17.11); output `scratchpad/t0028/exp-rq0039.out` | 2026-10-26 | experiment | E1–E5 below. |

S8 results (verbatim from the run output):

- **E1** `other-tenant row that also violates a CHECK -> 42501`: RLS WITH CHECK fails before
  the table's CHECK constraint, so a generated foreign row is refused as a privilege error.
- **E2** `lf_app SELECT ... FOR UPDATE with SELECT/INSERT only -> 42501 permission denied`:
  the engine cannot lock open-item rows itself; an advisory lock or a SECURITY DEFINER
  function owned by `lf_migrator` must do it.
- **E3** `depth seen by an UPDATE trigger (direct, then from an AFTER INSERT trigger):
  ["depth 1","depth 2"]`: a guard on the open-item table can tell an UPDATE made by the
  allocation trigger (depth ≥ 2) from a direct UPDATE (depth 1), even by the owner.
- **E4** Two transactions each insert an allocation of 70 against an item open 100 through a
  SECURITY DEFINER trigger that locks the item `FOR UPDATE` and subtracts: the second waits,
  re-reads 30 and fails `23514` on `CHECK (open >= 0)`; the item ends at 30.
- **E5** `round(0.00005,4)=0.0001 round(-0.00005,4)=-0.0001`: numeric `round` is half away
  from zero, i.e. half-up on magnitudes.

## Findings

1. **Q1 — which lines.** Every posted line on an account bound to `AR_CONTROL` or
   `AP_CONTROL` becomes one open item (one per line: S1 "control accounts accept postings only
   from their subledger"; S3 DL-0136 already restricts those lines to AR / AP source types).
   PAYROLL_CLEARING is a control account but not an AR/AP open-item ledger (S1 §3.3 "AR/AP
   open items"), so it gets none in T-0028.
2. **Sign.** An item carries the GL sign of its line: debit positive, credit negative. An AR
   invoice is +, a receipt or credit note −; an AP bill −, a payment +. Then the sum of items
   on a control account equals the account's debit-minus-credit balance by construction, and
   an allocation always pairs one + item with one − item and moves both towards zero, so it
   leaves the sum unchanged (in the transaction currency). "Never negative beyond the document
   sign": `open_amount` stays between 0 and `original_amount`, on the original's side.
3. **Q2 — currency.** The design's `original_amount` / `open_amount` / `currency` are the
   transaction currency (S1 §3.7: documents in any currency). The control account is base
   currency, so each item also stores `base_original_amount` / `base_open_amount` (line base
   debit − credit). An allocation of a transaction amount releases base from each item in
   proportion (`round(base_open × amount / |open|, 4)`, half-up, E5), and the whole remaining
   base when it closes the item, so a closed item never keeps a base residue.
4. **Q3 — fx_difference.** When the two items were booked at different rates, the base
   released from them differs. `fx_difference = base released from the credit item − base
   released from the debit item` is exactly the base-currency debit to the control account
   that the realised FX journal would have to post (positive: Dr control / Cr FX_REALISED, a
   gain; negative: a loss). S1 says realised FX "posts at allocation", but that is a posting
   behaviour and its golden posting is Draft (S2), so T-0028 stores `fx_difference` as data
   and posts no FX journal. Consequence: `Σ base_open = control balance + Σ fx_difference`
   until the FX posting exists; the reconciliation reports the FX term separately.
5. **Q4 — maintenance.** `lf_app` keeps SELECT/INSERT only. Open amounts are changed by a
   SECURITY DEFINER trigger on `allocation` INSERT (owner `lf_migrator`, as account_balance in
   RQ-0032), and a guard on `subledger_entry` refuses every UPDATE except an open-amount change
   made from inside that trigger (`pg_trigger_depth() > 1`, E3) and refuses DELETE/TRUNCATE.
   The item's other columns are filled by the database from its journal line, so an item can
   never disagree with the line it stands for.
6. **Q5 — concurrency.** The engine takes transaction advisory locks on both items (sorted
   ids, so no deadlock) before it reads and checks them (E2: it cannot `FOR UPDATE`). The
   database trigger locks both items `FOR UPDATE` in id order and re-checks; under Read
   Committed a waiting writer sees the committed open amount (S5, E4), and the CHECK
   constraints (`0 ≤ |open| ≤ |original|`, same side) refuse any over-allocation that gets past
   both (E4: 23514).
7. **Q6 — undo.** Allocations are append-only. A reversal is a new allocation row with
   `reversal_of_id`, the negated amount and the original's base releases and fx_difference
   negated, which restores both items exactly. One reversal per allocation (unique key); a
   reversal cannot itself be reversed.
8. **Q7 — reconciliation.** Per control role: control = Σ(debit − credit) of posted lines on
   the role's accounts (bound now or carrying items); subledger = Σ items' base open amount
   (as at a date: base original of items dated ≤ D minus base released by allocations dated
   ≤ D); unposted FX = Σ fx_difference of those allocations; reconciled when
   subledger = control + unposted FX.

## Conclusion

Build `subledger_entry` (one per AR/AP control line, database-filled from the line, signed
like the GL, transaction and base amounts) and append-only `allocation` (amount, base
releases, fx_difference, reversal_of_id) in migration 0028, with SECURITY DEFINER triggers that
lock, check and maintain open amounts, a guard that keeps everything else immutable, and
`lf_app` SELECT/INSERT only. The engine creates items in its write savepoint (preview returns
them and writes nothing), exposes `allocate` / `reverseAllocation` with advisory locks and
idempotency keys, and a `subledgerReconciliation` read API. No FX journal is posted
(golden posting Draft); the sign convention and the fx_difference definition are put to the
product owner in ADR-0035 (accounting, Proposed).

## Follow-ups

- Realised FX journal at allocation once its golden posting is Approved (adds a link from the
  allocation to the FX entry; the reconciliation's FX term then counts only unposted rows).
- Whether a party should be required on every AR/AP control line (open question; the engine
  currently allows an item without a party, as existing tests post such lines).
- Ageing and statements (AR/AP module tasks) read `subledger_entry`.
