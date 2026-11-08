---
id: RQ-0104
title: How does a sales invoice become the GP-001 / GP-018 journal, who may approve it, and what does T-0040 own versus T-0042/T-0069/T-0083?
status: answered
opened: 2026-11-08
resolved: 2026-11-08
opened_by: claude
linked_tasks: [T-0040, T-0042, T-0069, T-0083, T-0116, T-0117]
linked_adrs: []
superseded_by:
---

# RQ-0104 — Sales invoice lifecycle: journal shape, approval, numbering, notification

## Question

- **Q1.** How are invoice lines turned into journal lines so that GP-001 (two products → two
  revenue lines) and GP-018 (three lines of one product → **one** revenue line of 9.15) both hold?
  In what order do lines appear, where does the per-document residue go, which lines carry the
  party and the tax code/amount?
- **Q2.** Which number is "INV-…": the journal entry number or a document number, and when is
  it taken?
- **Q3.** "Approval is checked against SoD": which SoD rule guards an invoice approval?
- **Q4.** What does the card's "emails" (SS-UC01-03) mean inside T-0040, given T-0042 is the
  SMTP sender and T-0041 the PDF?
- **Q5.** Where is the auto-approve setting stored, and what does the credit-hold hook check?

## Why it matters

T-0040 is the first event posting rule (DL-0246: until now golden journals were replayed raw).
A wrong grouping or line order fails the Approved goldens; inventing an SoD rule changes the
security model (human gate, AGENTS.md §6).

## Sources consulted

| # | Source | Accessed | Kind | What it says |
|---|---|---|---|---|
| S1 | `Docs/accounting/postings.md` GP-001, GP-018 (Approved, DL-0253) | 2026-11-08 | primary (human-owned golden) | GP-001: line 1 AR debit 1,375.00 party Acme; lines 2–3 revenue per product with "GST (tax 100.00)" / "(tax 25.00)" and party Acme; line 4 `tax:GST.collected` credit 125.00, code GST, no tax amount, no party. GP-018: three $3.35 inclusive lines of one product → one revenue line 9.15; 18b adds `system:ROUNDING` debit 0.01 as line **2** (after AR, before the credits); revenue line carries "(tax 0.91 doc-level)". Subledger: AR open item, due date = date + terms. |
| S2 | `packages/ledger/src/golden/command.ts`, `compare.ts` | 2026-11-08 | code | The comparator checks line number, account, debit, credit, tax code id, tax amount and party of every line. |
| S3 | `packages/modules/tax/src/gst.engine.ts` (T-0034) | 2026-11-08 | code | `calculateTax`: per-line or per-document; per-document inclusive returns `residue` = Σnet + Σtax − total, "positive → debit ROUNDING"; line tax under per_document is the code's tax allocated by largest remainder. |
| S4 | `packages/modules/products/src/profile-resolution.ts` (T-0039, DL-0260) | 2026-11-08 | code | `resolvePartyProductPosting` → account, control role, tax code; refuses PROFILE_GAP, TAX_CODE_CONFLICT (both defaults set and differ), NO_TAX_CODE; an explicit line code always wins. |
| S5 | design §3.4, §4.2, §4.3, §6.4, §6.5; UC-01 main flow 6, A1, A6 | 2026-11-08 | primary (spec) | §3.4 numbering series per document type, gapless; §4.2 "an invoice cannot be approved for a customer with no Billing To contact"; UC-01: auto-approve when on, total ≤ threshold and party not on credit hold, then "approved, posted (GP-001 shape), numbered, PDF rendered and emailed"; A6 above threshold stays Draft "awaiting AR Clerk/Approver"; credit hold is Phase 1. §6.5 lists six SoD rules — bills, journals, batches, bank details, rules/tax codes, period reopen — **none for sales invoices**; §6.4 AR Clerk "create and send invoices". |
| S6 | `packages/shared/src/sod/rules.ts`, migration 0021 `app.sod_step_known` | 2026-11-08 | code | SoD subjects are a closed list (bill, credit_note, payment_batch, net_pay_batch, bank_detail_change, manual_journal, posting_rule, tax_code, period_reopen_request); the database refuses unknown steps. |
| S7 | `.agent/backlog/T-0042.md`, `T-0069.md`, `T-0083.md` | 2026-11-08 | backlog | T-0042 owns the outbox-driven SMTP sender and recipient resolution (and lists SS-UC01-03 too); T-0069 creates drafts from Closed Won with auto-approve; T-0083 is the UI/API. |

## Findings

1. **Q1 — journal shape.** Lines group by (revenue account, tax code version) in order of first
   appearance; each group credits Σnet and carries Σline-tax as its tax amount (per-document:
   the allocated shares, which sum to the code's document tax — 0.91 in 18b). Then one credit per
   tax code with tax > 0 to the code's collected account, tax code set, no tax amount, no party.
   The AR control line (role from the party profile, party set, due date) is line 1. A positive
   residue is a ROUNDING debit right after AR (18b line 2); a negative one a ROUNDING credit as
   the last line. All amounts are non-negative; the side gives the direction (RQ-0095 F-notes).
   This reproduces S1 exactly and keeps GP-001's two products on two lines.
2. **Q2 — numbering.** The invoice number is a document number from series `ar_invoice`
   (prefix `INV-`) taken inside the posting transaction (design §3.4), separate from the
   journal entry number (`je_ar_invoice`, DL-0135). A rollback returns both.
3. **Q3 — SoD.** The design defines **no** SoD rule for sales-invoice approval (S5, S6), and the
   SoD subject list is closed in code and in the database. Adding `invoice.create/approve` would
   change the security model → `security` ADR (human gate). T-0040 therefore: runs approval only
   through the explicit rules the design does state (Billing To, posting profile resolvable,
   credit-hold hook, auto-approve threshold), records the approver (`approved_by`, also on the
   journal entry), checks the approver is an active user of the tenant, and leaves "may the
   creator approve" to follow-up **T-0117** (proposed rule + ADR for the owner).
4. **Q4 — email.** T-0040 emits, inside the posting transaction, exactly one
   `ar.invoice.posted` notification addressed to the Billing To contact through an
   `InvoiceNotifier` port (production: the transactional outbox, ADR-0008). Sending the mail
   (PDF, SMTP sink) is T-0042, which also lists SS-UC01-03. The register row records both halves.
5. **Q5 — settings.** Auto-approve (on/off, threshold) is a per-company, insert-only history
   table (latest row wins, set_by + reason), like `app.sod_settings`. Which role may change it
   (Finance Admin, audited) is enforced at the API (T-0083). Credit hold is Phase 1: T-0040
   exposes a `creditHold` hook that, when it returns a reason, blocks auto-approval only.

## Conclusion

Build T-0040 as: tables `app.sales_invoice`, `app.sales_invoice_line`, `app.ar_invoice_settings`
(migration 0037); a pure journal builder implementing finding 1; draft → approved → posted with
Billing To / profile / tax-code refusals at approval; numbering at post; posting only through
`post()`; `preview()` for "show me the journal"; immutability enforced by a database guard.
Follow-ups: T-0116 (API routes + Finance-Admin-only setting change), T-0117 (invoice SoD rule,
security ADR, human gate).

## Confidence

High for Q1/Q2/Q4/Q5 (read from the Approved goldens and code). Q3 is a **gap in the design**,
reported, not decided.
