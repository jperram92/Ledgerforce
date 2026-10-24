---
name: golden-posting
description: Use before writing or changing any LedgerForce code that creates, previews, reverses or allocates a journal entry (invoices, receipts, credit notes, bills, payments, payroll journals, Stripe settlements, bad debts, prepayments, custom rules), and when a golden posting is missing, Draft or looks wrong. Golden postings in Docs/accounting/postings.md are human-owned; agents only propose them via PR with label golden_postings.
---
# Skill: golden-posting

`Docs/accounting/postings.md` holds the expected journal for every standard event (design §3.8),
identified as `GP-NNN`. It is **human-owned** (human gate `golden_postings`). Agents may
*propose* new or changed postings; they may never edit an **Approved** one.

## A. Using a golden posting (normal case)

1. Find the event: `grep -n "GP-" Docs/accounting/postings.md` and read the section.
2. Check its status line. Only **Approved** postings may be implemented. `Draft`/proposed ones
   may have their tests written but the criterion stays blocked for `done`.
3. Write the golden test (skill `tdd-cycle` step 1) in
   `packages/ledger/test/golden/<event>.golden.spec.ts` (or the module's `test/golden/`),
   named `GP-NNN <event> [T-NNNN]`, asserting **exactly** the posting's lines: account (system
   role or profile-resolved account), debit, credit, tax code, party, in base currency, as
   decimal strings — and that the entry balances.
4. Never "fix" a golden test by changing its expectation to match code.

## B. Missing, Draft or suspected-wrong posting (propose, never decide)

1. Research the treatment (skill `research`) — ATO guidance, design §3.8, existing GP entries;
   cite sources in the RQ.
2. On the task branch, add the proposal in `Docs/accounting/postings.md`:
   - **new** posting → new `GP-NNN` section with status `Draft (proposed by <claude|codex>,
     T-NNNN)`, the worked example (amounts, lines, accounts, tax) and the RQ link;
   - **change to an Approved** posting → do **not** edit it; add the corrected version as a new
     `GP-NNN` `Draft` section that says `Proposes to supersede GP-MMM` and explain why. List any
     doubt under the file's *Open questions for accountant* section.
3. Log the proposal (skill `log-decision`, status `proposed (awaiting human)`).
4. Record the human gate (`Docs/process/human-gates.md`): HANDOVER *Open questions for human*
   naming the GP ids; label the PR `golden_postings`
   (`gh pr edit <number> --add-label golden_postings`); the dependent criteria are `blocked`.
5. Commit with `docs(accounting): propose GP-NNN <event> [T-NNNN]`; continue with other criteria
   or hand over. Only the product owner changes a status to **Approved**.
