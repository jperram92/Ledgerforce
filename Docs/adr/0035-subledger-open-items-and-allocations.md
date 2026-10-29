---
adr: 0035
title: "AR/AP open items signed like the GL, append-only allocations priced by the database, fx_difference recorded without an FX journal"
status: Proposed
date: 2026-10-26
author: claude
category: accounting
human_gate: yes
supersedes: none
superseded_by: none
---

# ADR-0035: Subledger open items and allocations

## Status

Proposed — accounting category, waiting for product-owner acceptance (label `adr:accounting`).
T-0028 is built to this proposal so it can be judged on working, tested code; it posts no
journal of its own. Research: [RQ-0039](../research/RQ-0039-subledger-open-items-and-allocations.md).

## Context and problem statement

Design §3.3 lists `subledger_entry` (party_id, document_id, due_date, original_amount,
open_amount, currency — "AR/AP open items for ageing and allocation") and `allocation`
(from_entry, to_entry, amount, fx_difference). §3.2 says control accounts accept postings only
from their subledger "so subledger and GL can't drift"; §10.8 requires the invariants "AR
subledger = AR control; AP subledger = AP control"; §3.7 says realised FX "posts at
allocation". The design does not say which sign an item carries, which currency its amounts
are in, how the base currency of an allocation is split, or what `fx_difference` measures. All
golden postings, including realised FX, are Draft.

## Decision drivers

- Subledger and control must be comparable by a query, not a spreadsheet (§10.8).
- Posted data is immutable; `lf_app` has SELECT/INSERT only on ledger tables (ADR-0004).
- No posting behaviour without an Approved golden posting (AGENTS.md §0, ledger rules).
- Concurrency must not over-allocate (two receipts against one invoice at once).

## Considered options

1. **GL-signed items, transaction + base amounts, database-priced append-only allocations** (chosen).
2. **Unsigned items with a side flag** — every sum needs a CASE; the "sum of items = control" identity is not visible in the data.
3. **Open amount computed on read (no stored open_amount)** — no update path at all, but every ageing/statement query aggregates all allocations, and over-allocation cannot be stopped by a CHECK.

### Option 1

- Good, because Σ items on a control account = its debit − credit balance by construction.
- Good, because the database fills items from their line and prices allocations, so code cannot write an inconsistent item, and CHECK constraints stop over-allocation even under concurrency.
- Bad, because open amounts are stored and change (only through the allocation trigger, guarded).

### Option 2

- Good, because amounts read as positive in screens.
- Bad, because every invariant and report needs sign handling; easy to get wrong.

### Option 3

- Good, because nothing ever updates.
- Bad, because concurrency control moves to locks only; ageing is slower; design §3.3 lists open_amount as a column.

## Decision outcome

Chosen option: **Option 1**.

1. Every posted line on an account bound to AR_CONTROL or AP_CONTROL creates exactly one open
   item, written by the posting engine in its write savepoint and filled by the database from
   the line. PAYROLL_CLEARING lines create none.
2. Amounts are signed like the GL: debit +, credit −. `original_amount` / `open_amount` /
   `currency` are the transaction currency; `base_original_amount` / `base_open_amount` are
   base currency (line debit − credit). `0 ≤ |open| ≤ |original|`, on the original's side.
3. An allocation pairs a + item with a − item of the same control account, party and currency
   and reduces both by `amount`. The base released from each item is its base open amount ×
   amount / open amount, rounded half-up to 4 decimals, or the whole remainder when the item
   closes.
4. `fx_difference` = base released from the credit item − base released from the debit item:
   the base-currency debit to the control account that a realised FX journal must post
   (positive = Dr control / Cr FX_REALISED). **No FX journal is posted** until its golden
   posting is Approved; until then the reconciliation is
   `Σ base_open = control balance + Σ fx_difference`.
5. Allocations are append-only; a reversal is a new allocation (`reversal_of_id`, negated
   amount, base releases and fx_difference), at most one per allocation, never of a reversal.
6. Allocations post no journal and are not subject to period locks (they move no GL balance).

## Consequences

### Good

- "AR/AP subledger = control" is a single query (`subledgerReconciliation`), usable by the
  close checklist (SS-UC10-08).
- Over-allocation is impossible even for a writer that bypasses the engine (trigger + CHECK).

### Bad / accepted trade-offs

- Until the FX golden posting is Approved, a cross-rate allocation leaves the control account
  different from Σ open items by the unposted FX difference (reported, not hidden).
- An AR/AP control line without a party creates an item with no party (existing tests post
  such lines); whether a party should be mandatory is an open question.

### Follow-ups

- Realised FX posting at allocation (needs its golden posting Approved).
- Decide whether AR/AP control lines must carry a party.
- Ageing and statements read `subledger_entry` (AR/AP module tasks).

## Compliance and verification

| Check | Where | Gate |
|---|---|---|
| Items written by the engine, preview parity, filled from the line, immutable | `packages/ledger/src/subledger.allocation.db.test.ts` (SS-PLAT-81) | verify.sh db tests |
| Allocation rules, reversal, FX difference, concurrency | same file (SS-PLAT-82) | verify.sh db tests |
| Σ open = control + unposted FX; no over-allocation over random ledgers | `packages/ledger/src/subledger.prop.db.test.ts` | verify.sh db tests |
| RLS and privileges | `packages/db/src/rls.db.test.ts` (cross-tenant suite) | verify.sh db tests |

## Links

- Design: §3.2, §3.3, §3.7, §3.9, §10.8
- Research: RQ-0039
- Decision log: DL-0185, DL-0186, DL-0187, DL-0188, DL-0189
- Related ADRs: ADR-0004 (immutable ledger), ADR-0005 (money)
