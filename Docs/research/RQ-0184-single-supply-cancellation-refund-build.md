---
id: RQ-0184
title: Single-supply cancellation and refund as built (GP-044a-d) - inputs, cash basis and nothing-attributed cases, the 44d refund path and SoD, adjustment-note particulars, the record, and the T-0217 split
status: answered
opened: 2026-11-23
resolved: 2026-11-23
opened_by: claude
linked_tasks: [T-0217, T-0231, T-0232, T-0218]
linked_adrs: [ADR-0089, ADR-0074]
superseded_by:
---

# RQ-0184 — Single-supply cancellation and refund (GP-044) as built

## Question

T-0217 AC-2 and AC-10 (rest) ask that cancelling an open single-supply contract posts GP-044a
(refund agreed) or GP-044c (refund undecided), that the refund posts GP-044b through the customer
refund approval path (ADR-0074) or GP-044d with its own adjustment note, that forfeiture is
refused by name and that the contract becomes cancelled. GP-044 (Approved, DL-0755) and ADR-0089
addendum A settle the journals for the worked example. They leave these build questions open:

- **Q1** What does the caller state at cancellation, and how is forfeiture refused?
- **Q2** What is posted when a contract is cancelled on the **cash basis**, or on accruals with
  **no receipt yet** (nothing attributed)?
- **Q3** GP-044a/c are given for one receipt. How do the lines generalise to any number of
  receipts and to a fully received contract?
- **Q4** GP-044b goes "through the refund approval path (ADR-0074) allocated to that credit". Does
  the existing customer refund (GP-006) do that? And GP-044d, whose journal credits the bank from
  CUSTOMER_PREPAYMENTS (not AR): which path, and how is maker-checker kept?
- **Q5** Which adjustment-note particulars do the 44a, 44c and 44d documents carry, and are they
  numbered documents?
- **Q6** Where are the cancellation and the 44d refund recorded?
- **Q7** The card is several times the ~400-line split threshold. What is built in this slice and
  what moves to new cards?
- **Q8** Can the primary law be read from the build environment now?

## Sources

1. GP-044 (Approved, DL-0755), GP-006, GP-020, GP-022, GP-029, GP-040, GP-045 —
   `Docs/accounting/postings.md`.
2. ADR-0089 R7, R8 and addendum A; ADR-0074 (customer refund maker-checker); RQ-0171 + addendum
   A; RQ-0178 (Q4 particulars, Q5 split).
3. Independent accounting review of T-0168 (`.agent/evidence/T-0168/accounting-review-20261116.md`)
   findings 9, 10, 13 and proposed journals GP-043a/b (adopted as GP-044a/b). The review worked
   from ATO web-search extracts: "when to make adjustments" (accruals: the adjustment is attributed
   to the period in which you become aware of it, s 29-20(1)); "adjustment notes" (a note is needed
   before claiming a decreasing adjustment unless the GST is $75 or less, s 29-20(3)/s 29-80;
   particulars: a statement that it is an adjustment note, the supplier's identity and ABN, date
   of issue, reason, amount of the adjustment and its GST, the earlier document it adjusts); the
   ATO concert example (decreasing adjustment of 1/11 of a refund).
4. Existing code: `packages/modules/ar/src/refunds.ts` (createCustomerRefund → approveCustomerRefund
   → payCustomerRefund; GP-006 Dr AR / Cr bank, the refund item allocated to the party's credit
   items oldest first; SOD_REFUND_SELF_APPROVAL is checked by the API guard),
   `single-supply.ts`, `single-supply-final.ts` (adjustment-note particulars of 45c).
5. How comparable systems handle cancelling a job paid in advance (public help documentation as
   known to the builder; outside hosts are blocked by the environment's proxy, so not re-fetched):
   - Xero: a prepayment is refunded with "Refund" on the prepayment (cash out, the GST of the
     prepayment reversed on the cash refund); an invoice is voided or credited with a credit note,
     which is the adjustment note, and its refund is a separate cash-out applied to the credit.
   - MYOB Business: a customer deposit is refunded by settling the deposit/credit with a refund
     cheque; an invoice is reversed by a credit (adjustment note) and the credit refunded.
   - QuickBooks Online: a credit memo (adjustment) and a separate refund receipt or cheque applied
     to it; refund approval is a workflow on the payment.
   - Odoo: a credit note (adjustment) and a refund payment reconciled to it; payments can require
     approval before they are sent.
   In every system the adjustment document and the cash refund are separate steps when the
   customer is first put in credit, and one step when the deposit itself is refunded. Refund
   approval is a payment control, not part of the accounting entry.
6. Probe of primary sources on 2026-11-23: `.agent/evidence/T-0217/primary-source-probe.txt`.

## Findings

**Q1 — what the caller states.** GP-044 distinguishes two facts on the cancellation date: the
refund is agreed (44a), or undecided/disputed (44c). The scenario also names forfeiture
(retaining the part payment), which ADR-0089 R7 refuses until researched. A required enumerated
input `refund: 'agreed' | 'undecided' | 'forfeited'` makes the user state the fact (no default,
like the R1 classification), and lets `forfeited` be refused by name
(`FORFEITURE_NOT_SUPPORTED`) with nothing written. A reason (1–500 characters) is required: it is
the adjustment-note reason. An undecided cancellation can only later be resolved by the refund
(44d); there is no forfeiture path, so a decision to retain stays unrecorded until a golden exists.

**Q2 — cash basis and nothing attributed.** GP-044 states: "**Cash basis:** 44a/44c do not arise;
a refund of a GP-020 receipt follows 44d." On the cash basis GST is attributed only as cash is
received (s 29-5(2)), so cancelling attributes nothing back; the money held stays on
CUSTOMER_PREPAYMENTS (GP-020 coded) until refunded by the 44d shape, whose decreasing adjustment
is attributed to the refund period (review finding 13, ATO extract: cash-basis adjustments in the
period of payment). On accruals with no receipt nothing was attributed (GP-040a never posted) and
no money is held, so there is nothing to adjust or refund. In both cases the cancellation posts
**no entry**; the contract still becomes cancelled (receipts and the final invoice are refused).
On cash, the refund decision is recorded but either value leads to the 44d refund.

**Q3 — general lines.** Let N = known net, T = attributed GST, Rn/Rt/Rg = net/GST/gross received,
U = the contract's GST_ATTRIBUTED_UNBILLED balance (T − Rt). The CUSTOMER_PREPAYMENTS balance is
Cr Rn (T-0203). GP-044a generalises to: Dr CUSTOMER_PREPAYMENTS coded N (tax T) / Dr GST collected
T / Cr CUSTOMER_PREPAYMENTS uncoded (N − Rn) / Cr GST_ATTRIBUTED_UNBILLED U (its actual balance,
debit or credit, as GP-045) / Cr AR_CONTROL Rg. Balance: N + T = (N − Rn) + (T − Rt) + (Rn + Rt) ✓;
afterwards CUSTOMER_PREPAYMENTS and unbilled are 0, GST for the contract 0, AR credit Rg. GP-044c
generalises to: Dr CUSTOMER_PREPAYMENTS coded (N − Rn) (tax U) / Dr GST collected U / Cr
CUSTOMER_PREPAYMENTS uncoded (N − Rn) / Cr unbilled U; afterwards CUSTOMER_PREPAYMENTS Cr Rn,
GST collected Rt. GP-044d: Dr CUSTOMER_PREPAYMENTS coded Rn (tax Rt) / Dr GST collected Rt / Cr
bank Rg — also the cash-basis refund (CUSTOMER_PREPAYMENTS Cr Rn, GST Rt from GP-020). A zero line
is omitted, as in GP-040 and GP-045. A fully received contract has N = Rn and U = 0 (the receipt
that completes the total takes the remaining GST, T-0203 MINOR-2), so 44c posts nothing.
For the worked example (N 10,000.00, T 1,000.00, Rn 3,000.00, Rt 300.00, Rg 3,300.00) these give
exactly GP-044a/c/d. The refund is always the whole cash received: a partial refund means the rest
is retained, i.e. a partial forfeiture, which is refused (Q1).

**Q4 — refund paths.** GP-044b is exactly GP-006 (Dr AR control / Cr bank). The existing customer
refund records the request (credit available = the party's AR credit balance, which 44a creates),
requires another person's approval (ADR-0074; the database refuses an unapproved payment) and
pays by allocating the refund item to the party's credit items oldest first; with no older credit
it is allocated to the 44a item. So 44b is built by **reusing** createCustomerRefund /
approveCustomerRefund / payCustomerRefund with no change; the test proves the allocation. If the
customer holds an older credit, the oldest-first rule of GP-006 applies (it is the same customer's
money); that is the existing Approved behaviour and is not changed here.
GP-044d cannot use the customer refund: it debits CUSTOMER_PREPAYMENTS with a coded line (the
decreasing adjustment), not AR, and the money is never on AR. Comparable systems refund a deposit
in one step from the deposit itself (Xero "Refund" on a prepayment, MYOB deposit refund). The
ADR-0074 control (another person approves a refund before money leaves) is kept by requiring an
approver on the 44d request who is not its maker: `approvedBy` ≠ `createdBy`, refused
`SOD_REFUND_SELF_APPROVAL` in the module and by a CHECK in the database. The 44d entry is posted
on the refund date, which is also the date the refund is agreed (GP-044d: "agreed and paid
later"); a refund agreed on one date and paid on a later date has no golden (it would need an AR
credit at agreement, i.e. a later-dated 44a) and is not offered. Paying 44d refunds through the
supplier payment batch is not needed for the golden and is not built.

**Q5 — particulars.** The 45c particulars (RQ-0178 Q4) are reused: title "Adjustment note", the
reason, the decrease net / GST / gross, the earlier document it adjusts and whether the GST is
within the $75 threshold (s 29-80: the note is then optional but still carried, AC-10). 44a:
decrease N / T / N + T, adjusts the GST attribution (contract and attribution date). 44c: decrease
(N − Rn) / U — GP-042a carried particulars for the same journal and s 29-20(3) needs a note above
$75, so 44c carries them too. 44d: decrease Rn / Rt / Rg; adjusts the attribution (accruals) or
the GST on the receipts (cash). The supplier's identity and ABN are on the company and the date of
issue is the document date, as for 45c. The particulars are returned on the document view; no
separate number series is introduced (the ATO particulars in the extract do not include a
number; the contract reference and date identify the document). A numbered printable adjustment
note is a presentation feature for the document UI, not needed for the journal or the BAS.

**Q6 — record.** Two immutable tenant-owned tables (migration 0082, owner packages/modules/ar):
`app.single_supply_cancellation` (one per contract: date, refund decision, reason, the 44a/44c
entry or NULL, decrease net/GST, idempotency key, maker) and `app.single_supply_refund` (one per
contract: the 44d refund date, gross/net/GST, bank account, entry, reason, maker, approver,
CHECK approver ≠ maker, idempotency key). The contract status uses the existing
`app.single_supply_contract_status` row (status `cancelled`, the 44a/44c entry or NULL).

**Q7 — slice.** T-0217 holds seven criteria across four posting families. This slice (T-0217):
AC-2 and AC-10 (rest) — cancellation (44a/44c, cash and nothing-attributed cases), the 44b refund
through the existing approval path, the 44d refund with SoD and particulars, forfeiture refused,
contract cancelled, a property over the lifecycle. Moved with full text:
- **T-0231** — receipt reversal before finalisation and its refusal after (AC-3), the later-period
  error-correction label for BAS preparation (AC-9), the cash-basis final invoice by GP-022
  (ADR-0089 R8), the NOTHING_ATTRIBUTED decision, and the `ar.invoice.posted` delivery event of the
  final invoice.
- **T-0232** — the contract-variation document dated at agreement (AC-6 rest): research and
  candidate goldens GP-047 onwards approved under DL-0263, then the build, after which
  VARIATION_NOT_ON_INVOICE_DATE is lifted.
T-0218 (BAS preparation) depends on T-0217; it now also depends on T-0231 for the AC-9 label.

**Q8 — primary law.** On 2026-11-23 the proxy refused CONNECT to legislation.gov.au and
austlii.edu.au, and ato.gov.au answered 403 (probe file). The primary text of ss 19-10, 29-20,
29-75, 29-80, GSTR 2000/29 and the BAS instructions remains **unread**; nothing in this slice
claims it. The slice implements an Approved golden; the reading stays a T-0218 exit item.

## Conclusion

Q1 required `refund` ∈ {agreed, undecided, forfeited}, forfeited refused FORFEITURE_NOT_SUPPORTED;
reason required. Q2 cash basis or nothing attributed: no entry at cancellation, contract cancelled;
cash refunds by the 44d shape. Q3 general 44a/44c/44d lines as above; the refund is always the
whole cash received. Q4 44b reuses the customer refund (GP-006, ADR-0074) unchanged; 44d is a
contract refund with approver ≠ maker (module + CHECK), refused for an agreed accruals cancellation
(its money is an AR credit). Q5 particulars on 44a, 44c and 44d documents, $75 flag, unnumbered.
Q6 migration 0082, two immutable tables. Q7 slice and split as above. Q8 unread, recorded.

Decisions: DL-0900 (slice and split), DL-0901 (cancellation inputs and cash/nothing-attributed),
DL-0902 (44b reuse and 44d path with SoD), DL-0903 (particulars), DL-0904 (migration 0082),
DL-0905 (primary law status).

## Addendum A (2026-11-23) — rounding residue found by the property

The SS-PLAT-182 property found a counterexample to the Q3 claim that "a fully received contract
has U = 0": receipts are recorded gross and their GST part is rounded per receipt, so the net can
be fully received while GST is still unbilled (known net 0.05, GST 0.01, one receipt 0.05 with GST
0.00 → N − Rn = 0, U = 0.01), and several rounded-up receipts can leave U < 0 while net is still
unreceived. The engine refuses a zero-amount line and a coded line whose tax runs against its
side, so no GP-044c line can carry such a residue, and GP-044 has no example of it. Decision
(DL-0906): an undecided cancellation with a rounding-only residue (N − Rn ≤ 0 with U ≠ 0, or
U < 0) is refused `ROUNDING_RESIDUE_NOT_COVERED` with nothing written; cancelling with the refund
agreed (GP-044a, whose lines carry N and T and clear U by its actual balance) remains available.
The residue is at most a few cents and arises only when the contract is (almost) fully paid, so a
refund-agreed cancellation is the expected case anyway. A golden for the residue may be proposed
later if a real case needs it.
