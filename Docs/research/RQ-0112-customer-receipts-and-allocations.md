---
id: RQ-0112
title: What does a customer receipt record and post, how is it allocated, and how are partial, over- and un-allocation handled?
status: answered
opened: 2026-11-08
resolved: 2026-11-08
opened_by: claude
linked_tasks: [T-0046, T-0047, T-0130]
linked_adrs: [ADR-0035]
superseded_by:
---

# RQ-0112 — Customer receipts and allocations (T-0046)

## Question

- **Q1.** Which journal does a bank-transfer / cheque / cash receipt produce, into which account
  (bank or undeposited funds), with which source type, and how does the cash-basis BAS see it?
- **Q2.** How is a receipt allocated to one or many invoices, on which date, and how is the
  invoice's status (Paid / Partially paid) derived?
- **Q3.** What happens to an over-payment (receipt larger than the invoices it is allocated to),
  and to a receipt recorded with no invoice at all (RQ-0095 Q7)?
- **Q4.** How is an allocation undone ("unallocate"), given posted rows are immutable?
- **Q5.** Does a receipt need its own document table, and is it ever updated?

## Why it matters

T-0046 must produce the Approved golden GP-002 from product code, keep AR subledger = AR control
(design §10.8 item 3), and feed the cash-basis BAS (T-0035, RQ-0102), which attributes an
invoice's GST to the period of the settlement allocation. Guessing the overpayment or
no-invoice treatment would collide with RQ-0095 Q7 (prepayment GST) and the T-0047 prepayment
path.

## Sources consulted

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S1 | `Docs/solution-design/solution-design.md` §3.8 row 2, §3.2 (allocation table), §4.3 (credit note "allocated to an invoice or held as credit"), §6 AR Clerk role | 2026-11-08 | primary (design) | Customer receipt: Dr bank or undeposited funds / Cr AR control. Allocation `from_entry, to_entry, amount, fx_difference` is "receipt-to-invoice matching". |
| S2 | `Docs/accounting/postings.md` GP-002 (Approved, DL-0253) | 2026-11-08 | primary (golden) | Dr bank:OPERATING 1,375.00 / Cr AR_CONTROL 1,375.00 (party Acme); variant: undeposited funds (1110) before banking; subledger: receipt open item −1,375.00, allocation receipt→INV-000123 1,375.00, both open 0.00 → invoice Paid; cash basis G1/1A in the receipt period, proportional to the amount received. |
| S3 | `Docs/research/RQ-0095-golden-posting-open-questions.md` Q1, Q7 | 2026-11-08 | primary (accepted research) | Q1: card receipts are Stripe (GP-003), not this path. Q7: a receipt that arrives with **no invoice** is an unsolicited prepayment (Option B, GP-012) — not an AR credit. |
| S4 | `packages/ledger/src/subledger.ts`, migration 0028 | 2026-11-08 | source code | allocate() pairs a + and a − open item of the same control account, party, currency; amount ≤ both open amounts; date ≥ both documents; reverseAllocation() appends a negative row restoring both items exactly; allocations are append-only. |
| S5 | `packages/modules/tax/src/bas-report.ts`, `bas-compute.ts` CASH_ATTRIBUTION, RQ-0102 finding 3 | 2026-11-08 | source code | Cash basis: `ar_receipt` is a *settlement*; an `ar_invoice` is reported in the period of each settlement allocation, by base released / original. A reversal of an allocation is a negative release in its own period. |
| S6 | A New Tax System (Goods and Services Tax) Act 1999 s 29-5(2), s 9-15 — https://www.legislation.gov.au/C2004A00446/latest/text | 2026-11-08 | primary (legislation) | Cash basis: GST on a taxable supply is attributable to a period "to the extent that you receive consideration for the supply" in that period. An amount paid beyond the price of the supplies invoiced is not consideration for those supplies (inference). |
| S7 | `packages/ledger/src/period-matrix.ts` SOURCE_TYPES; migration 0018 | 2026-11-08 | source code | `ar.receipt` (stored `ar_receipt`) is an accepted source type of class `ar`. |
| S8 | `packages/db/migrations/0013_bank_accounts_statements.sql` | 2026-11-08 | source code | app.bank_account binds a company bank account to one GL account of type asset, subtype bank; status active/archived. |

## Findings

1. **Journal (S1, S2, S7).** One entry, source type `ar_receipt`: line 1 Dr the deposit account
   for the full amount received, line 2 Cr AR control (party = customer) for the same amount; no
   tax code on either line. The deposit account is the GL account of a company bank account
   (S8) — `bank:OPERATING` in GP-002 — or the `UNDEPOSITED_FUNDS` system role (GP-002 variant).
   The engine opens the receipt's AR open item (−amount).
2. **Allocation (S2, S4).** Each allocation pairs the receipt's open item (credit) with an
   invoice's AR open item (debit) through `allocate()` in the posting transaction. Inference:
   the allocation date of allocations made when recording is the receipt date — that is the date
   the cash-basis BAS attributes the GST to (S2 "in the period of 2026-11-15", S5).
3. **Status (S2).** An invoice's payment status is derived from its AR open item, never stored:
   open = original → *Unpaid*; 0 < open < original → *Partially paid*; open = 0 → *Paid*. Nothing
   on the invoice row changes, so posted invoices stay immutable (migration 0037 guard).
4. **Over-payment (S1, S2, S6; inference).** The journal of a receipt is always the full amount
   received (the money is in the bank). The part not allocated stays as the receipt's credit open
   item on AR control — an unallocated customer credit, allocatable to a later invoice or
   refundable (GP-006). It carries no GST: it is not consideration for an invoiced supply (S6), and
   the cash-basis BAS only releases GST through allocations to invoices (S5), so it is reported
   when, and to the extent, it is allocated.
5. **No invoice at all (S3).** A receipt with no allocation at recording is an unsolicited
   prepayment under RQ-0095 Q7 and must take the GP-012 path (T-0047), not GP-002. Inference:
   refuse it here with a clear reason rather than guess.
6. **Unallocate (S4).** Undoing an allocation appends the reversing allocation dated on or after
   it; the receipt's credit and the invoice's open amount are restored, and the cash-basis BAS
   sees a negative release in the reversal's period (S5). The receipt journal is untouched; a
   wrong receipt is voided by reversing its journal (T-0032), which is out of this task.
7. **Document (S1, S7).** A receipt document row is needed to name the receipt (source_id of the
   entry, party, method, deposit target, reference). Because the receipt posts at once (no
   draft/approval in UC-03 A1), the row can be written after post() in the same transaction and
   never updated: SELECT/INSERT only, like a ledger table, with a guard that its journal entry is
   the engine's `ar_receipt` posting of it.

## Conclusion / decision

- Record a receipt in one transaction: validate → resolve the deposit account (bank account's GL
  account, or `{ role: 'UNDEPOSITED_FUNDS' }`) → build `Dr deposit / Cr AR_CONTROL` → post()
  with key `ar_receipt:<receipt id>` → insert `app.ar_receipt` (immutable) → allocate() each
  requested invoice with the receipt date. Any refusal rolls the whole receipt back.
- Require at least one allocation when recording (Q7 prepayment path otherwise). Σ allocations
  ≤ amount; the remainder is an unallocated credit.
- Allocate an existing receipt's credit later with `allocateReceipt` (explicit date); unallocate
  with `unallocateReceipt` → reverseAllocation only.
- `previewReceipt` runs the engine's preview plus the allocation plan; it writes nothing.
- Derive invoice status from the AR open item (`invoicePaymentStatus`).
- Migration 0039 `ar_receipt` (tenant_id, RLS ENABLE + FORCE, SELECT/INSERT only, guard
  trigger). Decisions DL-0310..DL-0313.

## Confidence

`high` for findings 1–3, 6, 7 (Approved golden + engine source). `medium` for 4 (inference from
s 29-5(2) and the BAS attribution code; the accountant-reviewer persona review of the Approved
postings — DL-0248 — should look at it; no golden line changes either way, the journal is GP-002's
shape). `high` that 5 must not post GP-002 (RQ-0095 Q7).

## Follow-ups

- T-0130: bank deposit of undeposited funds (Dr bank / Cr UNDEPOSITED_FUNDS, GP-002 variant).
- T-0047 owns the no-invoice (prepayment) receipt.
- T-0085 owns the allocation screen (SS-UC03-10); this task delivers the API it calls.

**Affects:** packages/modules/ar (receipts.ts), migration 0039, cash-basis BAS (T-0035).
