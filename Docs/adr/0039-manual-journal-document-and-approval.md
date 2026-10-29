---
adr: 0039
title: "Manual journals as approvable documents posted only through the engine; control accounts closed to them"
status: Proposed
date: 2026-10-26
author: claude
category: security
human_gate: yes
supersedes: none
superseded_by: none
---

# ADR-0039: Manual journal document, approval rule and control-account refusal

## Status

Proposed — security category (segregation of duties, design §6.5), with an accounting
interpretation (which accounts are "tax" accounts) and a new public API; waiting for the
product owner. T-0029 is built to this proposal so it can be judged on working, tested code.
Research: [RQ-0043](../research/RQ-0043-manual-journals-approval-and-control-accounts.md).
Decisions: DL-0208 … DL-0212.

## Context and problem statement

Design §6.5 rule 4: "Manual journals: approval required above $5,000 or on any control, tax or
equity account." §6.4: Accountants post manual journals, Approvers approve them and cannot
create what they approve, AR Clerks cannot post them. §3.2: control accounts (AR, AP, payroll
clearing) accept postings only from their subledger, never from manual journals; §11.3 item 3
asks for that "in every flow, including imports and custom rules". There is no golden posting
for manual journals (the lines are the user's), and the posting engine (T-0025) already refuses
non-subledger source types on control accounts (DL-0136).

## Decision drivers

- The journal itself must still be written only by the posting engine (ADR-0004).
- The approval must be enforced where it cannot be skipped: API SoD engine (ADR-0026) *and*
  the database.
- No accounting treatment beyond what the user wrote (golden postings are Draft).
- Small teams must be able to work (small-team exception, §6.5).

## Considered options

1. **A document table (`app.manual_journal`) with a guarded workflow; post through `post()`**
   (chosen).
2. **Draft journal entries in `journal_entry` (status `draft`)** — the design's `journal_entry`
   has a `draft` status, but lf_app has no UPDATE on ledger tables (ADR-0004), so a draft could
   never become posted without an UPDATE path on the ledger; rejected.
3. **No document: approve by API call carrying the lines** — nothing to approve between two
   people, no record of the rejected attempt; rejected.

## Decision outcome

Chosen option 1.

- `app.manual_journal` (migration 0029, module `@ledgerforce/journals`): `draft → submitted →
  (approved) → posted`, `submitted → draft` on rejection. Lines are posting-command lines
  (jsonb), checked by the engine's `checkCommand` when saved and by `preview()` at submit (so a
  control-account line is refused with `CONTROL_ACCOUNT` before it can be approved).
- **Approval rule**: required when Σdebit (base) is strictly above the tenant's
  `journal_approval` threshold (default 5,000.0000, a §11.2 placeholder) or any line touches a
  control account, an equity account, an account bound to GST_COLLECTED, GST_PAID or
  PAYG_WITHHOLDING, or carries a tax code/amount. Frozen at submit; re-evaluated at posting
  with the current settings (fail closed).
- **SoD**: submit is the step `manual_journal.post`, approve is `manual_journal.approve`
  (rule `SOD_JOURNAL_SELF_APPROVAL`, existing). The database repeats preparer ≠ approver at
  commit unless small-team mode is on and the exception row exists.
- **Posting**: `post()` with key `manual_journal:<id>`, `source_id` = document id,
  `created_by` = poster, `approved_by` = approver (new optional command field). A posted
  document never changes and must name the engine's entry for it.
- **API**: `/manual-journals` routes with `gl.journal.post` / `gl.journal.approve`; no step-up
  (§6.2 lists none for journals); create needs an `Idempotency-Key`.
- **Control accounts**: no new logic. The engine's rule covers manual journals, CSV imports
  (which create manual journals) and rule journals without a subledger document; SS-PLAT-07
  proves it exhaustively at the engine boundary, through the document and through the API.

### Consequences

- Good: approval cannot be skipped by calling the module or SQL directly; the approver is in
  the hash-chained entry; the engine stays the only journal writer.
- Bad: the API does not yet pass an outbox to the engine, so manual-journal posts emit no
  `ledger.entry.posted` event until the API gets a pg-boss handle (follow-up).
- Neutral: imports and custom rules have no own source types; adding them is a catalogue change
  (SS-PLAT-06) and a control-mapping decision for the product owner (DL-0136, DL-0210).

## Open questions for the product owner

1. Is "tax account" = GST collected, GST paid, PAYG withholding, plus any line with a tax code?
2. Should CSV imports and custom-rule journals get their own source types (and journal
   numbering series) instead of `manual_journal`?
3. The threshold (5,000) is a placeholder (§11.2).
