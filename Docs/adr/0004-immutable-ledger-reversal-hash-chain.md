---
adr: 0004
title: "Immutable append-only ledger, corrections by reversal, per-company SHA-256 hash chain"
status: Proposed
date: 2026-10-24
author: claude
category: accounting
human_gate: yes
supersedes: none
superseded_by: none
---

# ADR-0004: Immutable append-only ledger, corrections by reversal, per-company SHA-256 hash chain

## Status

Proposed — **Design-committed; awaiting product-owner acceptance.** Committed in design D2,
design principles 1–2 and §3.3; accounting category, so the human gate applies (`adr:accounting`).

## Context and problem statement

The general ledger is the financial system of record (§1). Tax law and auditors expect that
posted transactions cannot be silently altered — e.g. "back-dated edit after BAS lodgement" is
in the threat model (§6.1), and Australian record-keeping obligations run 5–7 years (§6.8).
Every serious ERP corrects posted entries by reversal rather than edit (D2). Because the code
is agent-written, the "plausible but wrong accounting logic" risk (§11.1) means the invariants
must be enforced **in the database**, where an agent cannot accidentally bypass them (§3.3).

We must decide how posted journal data may change (if at all), how corrections are made, and
how tampering is made evident.

## Decision drivers

- Design principle 2: nothing posted is ever edited or deleted.
- Design principle 1: every posting balances or nothing is written — enforced in the DB.
- Auditability: an auditor must be able to verify history has not been altered (§3.3 inv. 4,
  §6.8).
- Simplicity for SMB reporting: reports read balances directly (`account_balance`, §3.3), not
  by replaying an event store.
- Agent safety: the app role must be unable to disable the protections.

## Considered options

1. **Mutable journal rows with an audit-log table** (edit in place, record before/after).
2. **Full event sourcing** (events are the source of truth; journal and balances are projections).
3. **Append-only journal + corrections by reversal + DB triggers + per-company hash chain.**

### Option 1 — Mutable with audit

- Good, because simplest CRUD and easy "fix a typo".
- Bad, because the ledger's current state no longer equals the sum of what was posted;
  period totals reported to the ATO can change after lodgement.
- Bad, because the audit log is only as trustworthy as the code that writes it; an agent bug
  can update without auditing.

### Option 2 — Event sourcing

- Good, because complete history by construction and temporal queries.
- Bad, because every report becomes a projection to maintain; projection bugs are a new class of
  accounting error; harder for agents and for self-hosters to operate and debug.
- Bad, because it adds infrastructure and concepts beyond "boring technology" (principle 6),
  while the journal itself already *is* an append-only log of business events.

### Option 3 — Append-only + reversal + hash chain

- Good, because the journal is the event log: posted rows are facts, corrections are new
  facts (a reversal entry with `reversal_of_id`, then a corrected entry).
- Good, because DB triggers make UPDATE/DELETE of posted rows impossible for `lf_app`, and a
  deferred constraint trigger rejects unbalanced entries at commit.
- Good, because a per-company SHA-256 chain (`prev_hash`, `hash`) makes after-the-fact tampering
  (even by a DBA) detectable by a verification report.
- Bad, because the hash chain serialises posting per company (each entry needs the previous
  hash) — acceptable at SMB volumes; must be designed with a row lock on the chain head.
- Bad, because "fixing a typo" in a memo also needs a reversal (UI must make this painless).

## Decision outcome

Chosen option (design-committed): **Option 3**.

Rules:

1. `journal_entry.status` ∈ {draft, posted, reversed}. Once `posted`, the row and its
   `journal_line`s are immutable; the only permitted change is the transition to `reversed`
   recorded by the posting engine when a reversal entry referencing it is posted (to be
   specified exactly in the posting-engine task; any further exception needs a new ADR).
2. Triggers raise on UPDATE/DELETE of posted rows; `lf_app` has no privilege to disable
   triggers or alter tables (ADR-0003 roles).
3. A deferred constraint trigger rejects commit if Σdebit ≠ Σcredit (base currency) for any entry.
4. Corrections: void = full reversal entry (`reversal_of_id`), credit = credit note; dated in an
   open period per §3.5.
5. Each posted entry stores `hash = SHA-256(canonical serialisation of entry + lines + prev_hash)`
   and `prev_hash` of the previous posted entry for the same company; a verification report
   recomputes the chain.
6. Only the posting engine (`packages/ledger`) writes ledger tables (§4.6).

## Consequences

### Good

- Period totals can never change silently; audit and BAS figures are reproducible.
- Strong, DB-level protection against agent mistakes.

### Bad / accepted trade-offs

- Per-company posting serialisation on the chain head.
- Canonical serialisation for hashing must be specified precisely and versioned (a change is a
  new ADR) — e.g. decimal formatting of NUMERIC values.
- Storage grows monotonically (by design; retention 7+ years).

### Follow-ups

- Research: canonical serialisation format for hashing (decimal/ordering/encoding) — RQ to be
  opened by the ledger task.
- Golden postings: reversal of each §3.8 event restores prior balances.

## Compliance and verification

| Check | Where | Gate |
|---|---|---|
| UPDATE/DELETE on a posted `journal_entry`/`journal_line` as `lf_app` raises | `packages/ledger/test/immutability.spec.ts` (backlog) | §10.8 gate 2 |
| Unbalanced entry fails at COMMIT (deferred trigger) | `packages/ledger/test/balance-trigger.spec.ts` | gate 2 |
| `lf_app` cannot `ALTER TABLE … DISABLE TRIGGER` | role privilege test | gate 2/5 |
| Property test: reversing any random posted entry restores prior balances; trial balance nets to zero | fast-check invariant suite (ADR-0012) | gate 3 |
| Hash-chain verification passes on a clean DB and fails after a direct superuser tamper | `hash-chain.spec.ts` | gate 2 |
| Golden postings for each §3.8 event and its reversal | `Docs/accounting/postings.md` + golden test | gate 4 |

## Links

- Design: D2, principles 1–2, §3.3, §3.5, §3.9, §6.1, §6.8, §11.3 item 2
- Decision log: DL-0004 (no-delete, consistent principle)
- Related ADRs: ADR-0003, ADR-0005, ADR-0012, ADR-0014
- External: PostgreSQL CREATE TRIGGER (constraint triggers, `DEFERRABLE INITIALLY DEFERRED`) —
  https://www.postgresql.org/docs/17/sql-createtrigger.html
