---
id: RQ-0108
status: answered   # open | answered | answered-pending-human | superseded
opened: 2026-11-02
opened_by: claude
task: T-0060
---
# RQ-0108 — Bank matching: what "exact match" means, how bank rules work, how an unmatched line becomes a transaction

## Question
UC-08 steps 2–4 (design §8.2): "exact matches (amount, reference) auto-match, rule matches are
suggested, and the remainder can be created as transactions". The design does not define (a) which
book transactions are candidates and what makes a match exact, (b) what a bank rule can express and
whether it needs the CEL evaluator (AGENTS.md stack: "CEL for rules"), (c) how a created
transaction posts (golden posting? which source type? which controls?).

## Findings
1. **Exact matching in comparable systems.** Oracle NetSuite's system matching rules match an
   imported bank line to an account transaction when the transaction number and the amount are
   exact matches and the transaction is dated on or before the bank line; when a rule finds two or
   more possible transactions it does **not** match and the user matches manually; a separate
   system rule compares the numeric value of the number (prefixes, leading zeros ignored); user
   rules are ordered and per account. Sources: Oracle NetSuite Help "Matching Bank Data"
   (https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4843222719.html),
   "System Reconciliation Rules" (section_160374863744), "Creating User Transaction Matching
   Rules" (section_160002098350), "Intelligent Transaction Matching for Bank Data" (section_N1551275).
2. **Bank rules in comparable systems.** Xero bank rules: each condition looks at a field of the
   bank line with *equals*, *contains* or *starts with*; the rule needs *all* or *any* of its
   conditions; a matching rule **suggests** a coding the user confirms with OK; rules suit
   recurring items (fees, direct debits), not invoice matching. Sources: AAT Comment "Getting the
   most out of bank rules on Xero" (https://www.aatcomment.org.uk/?p=11594), Insightful
   Accountant "Xero in on Xero bank rules"
   (https://insightfulaccountant.com/accounting-tech/general-ledger/xero-in-on-xero-bank-rules-tips-tricks/),
   Xero product ideas "Bank Rule – Does not criteria"
   (https://productideas.xero.com/forums/967136-banking-chart-of-accounts/suggestions/45116875-bank-rule-does-not-criteria).
3. **CEL in the design.** Design §4.5 and packages/rules/AGENTS.md place CEL in *custom journal
   rules* (rule-generated postings, two-person activation, test cases that must balance). No CEL
   evaluator exists in the repository yet (packages/rules holds only AGENTS.md); adding one is a
   runtime dependency (ADR). Bank rules as found above need only field/operator/value conditions.
4. **What the book side offers.** Customer receipts (T-0046, `app.customer_receipt`: amount,
   reference, receipt no, deposit account) and confirmed supplier payment batches (T-0057,
   `app.payment_batch_confirmation` + `app.payment_batch`: batch no, optional bank reference,
   total, pay-from account) are the bank movements LedgerForce creates in the MVP; GP-009 posts one
   bank credit per batch, which is how the statement shows a batch (RQ-0096 Q6).
5. **Created transactions.** UC-08 security: "created transactions follow manual-journal /
   control-account rules". T-0029 manual journals post exactly the user's lines through the engine
   (source type `manual_journal`, period class journal), refuse control accounts and apply the
   §6.5 rule 4 approval threshold; manual journals have no golden posting by design (the engine
   posts the lines as given). GST on bank fees: financial supplies are input-taxed — no GST in the
   price and no credit (ATO "Financial supplies",
   https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/when-to-charge-gst-and-when-not-to/input-taxed-sales/financial-supplies;
   GSTR 2002/2); the AU chart already defaults 6110 Bank fees to tax code INP. Tax on a created
   transaction is the user's line data, as on any manual journal.

## Conclusion
- **Exact match** = same signed amount to the cent (Money, no floats), a book reference (receipt
  reference or number; batch number or bank reference) found in the line's reference or
  description as whole alphanumeric tokens (case/punctuation-insensitive, at least 4 characters),
  dates at most 14 days apart (receipts are often entered from the statement, so on-or-before is
  too strict here), and the pairing unique both ways. Only then the system matches by itself
  (`auto_exact`). Two or more qualifying candidates (or two lines for one candidate) → each becomes
  an open suggestion, as NetSuite refuses to auto-match ambiguity.
- **Bank rules** are declarative data, not CEL: conditions on description / reference / either
  ("text") with contains / equals / starts_with, all/any, optional direction (in/out) and absolute
  amount bounds, a priority, an optional bank account and the suggested GL account. Only the first
  matching rule by priority suggests, and a rule suggestion is never applied without a person.
  No new runtime dependency and no ADR; CEL stays for design §4.5 custom journal rules.
- **Create transaction** = a manual journal (T-0029) built from the line: the bank line on the
  bank account's GL account (debit for money in, credit for money out) plus the user's counter
  lines (or the accepted rule's account for the full amount), created, submitted and posted through
  `@ledgerforce/journals` → posting engine. Manual-journal rules apply unchanged (control accounts
  refused, approval above the threshold / for control, tax or equity lines, period checks); no new
  golden posting is needed (T-0029 precedent). The line is then matched to the posted entry; the
  database re-checks that the entry moves the bank GL account by exactly the line amount.
- Out of scope here (follow-ups): one-to-many / many-to-one matches (split CAMT entries, deposits of
  several receipts), foreign-currency bank lines (created transactions are refused unless the line
  is in base currency), unmatch and the reconciliation report (T-0061), screens (T-0088), API routes
  and the Reconcile permission wiring (with T-0088).
