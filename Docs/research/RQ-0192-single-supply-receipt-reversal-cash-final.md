---
id: RQ-0192
title: Single-supply receipt reversal (which golden, order, re-attribution, refusals, the later-period error-correction label), cash-basis final invoice by GP-022, the nothing-attributed final invoice and the final invoice's delivery event
status: answered
opened: 2026-11-23
resolved: 2026-11-23
opened_by: claude
linked_tasks: [T-0231, T-0249, T-0218]
linked_adrs: [ADR-0089]
superseded_by:
---

# RQ-0192 — Single-supply receipt reversal, cash-basis final invoice and delivery

## Question

T-0231 carries the last T-0204 criteria for single supplies (RQ-0184 Q7):

- **Q1** Does reversing a single-supply receipt (GP-040a, GP-040b, or a cash-basis GP-020
  receipt) need its own golden, or is the engine's mechanical reversal of the posted entry enough?
- **Q2** In which order may receipts be reversed, and what happens to the contract's attribution
  when the receipt that attributed the whole GST (GP-040a) is reversed?
- **Q3** When is a receipt reversal refused (after finalisation, after cancellation, others)?
- **Q4** How is a reversal in a later BAS period recorded so BAS preparation (T-0218) labels it
  an error correction and not a Div 19 adjustment (review MINOR-4, T-0204 AC-9)? What is "the
  same period"?
- **Q5** Is the GP-022 application of GP-020 receipts on a single supply (cash-basis final
  invoice, ADR-0089 R8) covered by GP-022 as Approved, or does it need a candidate golden?
- **Q6** A final invoice on an accruals contract with no receipt (today NOTHING_ATTRIBUTED): an
  ordinary invoice that finalises the contract?
- **Q7** The final invoice publishes no `ar.invoice.posted` event: add it as `approveInvoice` does?
- **Q8** Slice: what is built in T-0231 and what moves to a new card?
- **Q9** Can the primary law be read now?

## Sources

1. `Docs/accounting/postings.md` (Approved): GP-019 (reversal = a new entry mirroring every line,
   same accounts, tax codes, parties and dimensions; BAS: same period nets to 0, later period
   reported negative in the reversal period), Open question Q11 (void only when unallocated,
   otherwise credit note; material errors in reported periods via prior-period adjustment),
   GP-020 (fields: `supply_type` includes `single`), GP-022 (22a ordinary final invoice + 22b
   application of the GP-020 prepayment), GP-040 (Tax/BAS: "**Cash basis:** this shape is not
   used — each receipt posts the GP-020 journal (GST on the amount received) and the final invoice
   applies it by GP-022 (s 29-5(2))"), GP-044 (cancellation), GP-045 (accruals final invoice).
2. ADR-0089 R2, R5, R8, R11 and addendum A; RQ-0171 + addendum A; RQ-0178 (Q5: "A final invoice
   on an accruals contract that has no receipt ... has no golden; it is refused by name until one
   exists (an ordinary invoice is the alternative)"); RQ-0184 (Q2, Q7).
3. Independent accounting review of T-0168, `.agent/evidence/T-0168/accounting-review-20261116.md`
   row 12: "Same-period reversal — PASS, CONFIRMED (ATO extract: no adjustment is needed if the
   sale is not yet reported). Reversing 40a in a later period corrects an error ('correcting GST
   errors'), not a Div 19 adjustment. BAS-prep should label it that way (MINOR-4)." Row 13: cash
   basis uses GP-020/022, confirmed.
4. Code: `packages/ledger/src/reversal.ts` (`reverse`: mirror, refuses allocated documents —
   Q11 —, refuses a reversal of a reversal and a second reversal, period rules on the reversal's
   own date, marks the original `reversed`); `packages/modules/ar/src/single-supply*.ts`;
   migrations 0076 (attribution PRIMARY KEY (tenant_id, contract_id)), 0078, 0082;
   `packages/modules/ar/src/invoices.ts` (`approveInvoice` publishes `ar.invoice.posted` with the
   active Billing To e-mail addresses, refuses NO_BILLING_TO);
   `packages/modules/tax/src/tax-settings.ts` (GST basis and BAS frequency per company,
   effective-dated; monthly | quarterly | annual).
5. How comparable systems undo a customer payment received before an invoice (public help
   documentation as known to the builder; outside hosts are blocked by the proxy, not re-fetched):
   - Xero: a prepayment (receive money) is removed by "Remove & Redo" / void when unallocated;
     an allocated prepayment must first be unallocated. The GST of the voided prepayment leaves
     the BAS of its own period; if that BAS was already filed, Xero shows the change in the
     next BAS as an adjustment of an earlier period ("prior period" difference).
   - MYOB Business: "Reverse" creates a mirror transaction dated today; the original stays.
     Reversals are refused for transactions in a locked period.
   - QuickBooks Online: a payment is voided or deleted; it must be unapplied first.
   - Odoo: a posted entry is reversed by a reversal move (mirror), never edited; reconciled
     entries must be unreconciled first.
   All four reverse by a mirror, refuse (or require undoing) an applied payment, and leave the
   original visible; none needs a separate "reversal" accounting rule per transaction type.
6. Probe of primary sources on 2026-11-23: `.agent/evidence/T-0231/primary-source-probe.txt`.

## Findings

**Q1 — no new golden.** GP-019 (Approved) and postings.md Q11 define a reversal for every posted
entry: a new entry mirroring every line (accounts, tax codes and amounts, parties, dimension
sets) with debit and credit swapped, allowed only while nothing is allocated. The engine's
`reverse` implements exactly that and is already golden- and invariant-tested for GP-019. GP-040a,
GP-040b and GP-020 receipts have no AR/AP open items, so the Q11 allocation rule never blocks them;
the mirror restores every account balance including the contract's dimension balances on
CUSTOMER_PREPAYMENTS and GST_ATTRIBUTED_UNBILLED and the GST collected (the INV-reversal
invariant). A per-type golden would only restate the mirror. Comparable systems (source 5) also
undo a payment by one generic mirror. **Conclusion: engine reversal of the posted receipt entry;
no candidate golden (GP-047..049 unused).**

**Q2 — order and re-attribution.** Later receipts (GP-040b) post against the attribution made by
the first receipt (GP-040a): they clear GST_ATTRIBUTED_UNBILLED and carry no GST. Reversing 40a
while a 40b stands would leave a 40b credit on the unbilled asset with no attribution behind it,
i.e. a contract state no golden describes. The rule that keeps every intermediate state equal to
a state reachable without reversals is **last in, first out**: only the latest receipt not yet
reversed may be reversed (refused NOT_LATEST_RECEIPT otherwise; the user reverses the later ones
first). After a 40a reversal the contract is exactly a contract with no receipt: nothing
attributed. The next receipt is then the first receipt of the contract and attributes the whole
GST again (GP-040a) on its own date — s 29-5(1) attributes to the period in which any of the
consideration is first received, and a reversed (erroneous or dishonoured) receipt was never
consideration received. Migration 0076 allows one attribution row per contract (PRIMARY KEY), so a
renewed attribution needs an additive table: `app.single_supply_attribution_renewal`, one row per
reversal of an attributing receipt (UNIQUE on that reversal), the database backstop for "one
active attribution" under concurrency alongside the contract advisory lock. The contract view
takes the attribution whose entry is not reversed.

**Q3 — refusals.** After finalisation the receipts are part of the final invoice (GP-045: the
cash received is an AR credit allocated to the invoice; GP-022: applied to it), so Q11 applies:
refused (`REVERSAL_AFTER_FINALISATION`), correct by a credit note. After cancellation the
cancellation already adjusted the GST on the receipts (GP-044a/c) or a refund follows (44d) — a
reversal would remove GST twice: refused (`REVERSAL_AFTER_CANCELLATION`). Also refused: a receipt
already reversed (`ALREADY_REVERSED`), not the latest (`NOT_LATEST_RECEIPT`), a reversal date
before the receipt, a reason not 1–500 characters, and a basis in force on the reversal date that
differs from the contract's (`BASIS_CHANGED`, ADR-0089 R8: no document dated after a basis change
on an open contract). The engine's own refusals (locked period, already reversed) remain.

**Q4 — the error-correction label.** A reversal in the same BAS period as the receipt nets that
period to zero; nothing was reported, so it is neither an error correction nor an adjustment
(review row 12, ATO extract). A reversal in a later period corrects GST already reported in an
earlier period: the receipt never was consideration, so there is no adjustment event under Div 19
(that needs a change to a supply that happened); the ATO treats it as **correcting a GST error**
(review row 12, ATO "correcting GST errors" extract; primary text unread, Q9). GP-019 already
reports a later-period reversal in the reversal period; BAS preparation must label it. The
reversal record stores `bas_treatment` ∈ {`same_period`, `error_correction`} and the original
period's bounds, decided at reversal time from the BAS frequency in force on the receipt date
(`app.tax_settings`): monthly = the calendar month; quarterly = the calendar quarter (the ATO
quarters end 30 Sep, 31 Dec, 31 Mar, 30 Jun); annual = the Australian financial year 1 Jul–30 Jun.
`error_correction` ⇔ the reversal date is after the original period's end. Whether a correction
may be made in a later BAS (time and value limits of the ATO correction guidance) or needs a
revised BAS is a BAS-preparation presentation question for T-0218 (it already owns AC-9
presentation and AC-11 primary law); the ledger always reverses in the reversal period, never
back-dated (GP-019 period rule). The label applies on both bases (a cash-basis GP-020 receipt
reversed in a later period is the same kind of correction).

**Q5 — cash-basis final invoice: covered by GP-022.** GP-040 (Approved) states that on the cash
basis each receipt posts GP-020 "and the final invoice applies it by GP-022 (s 29-5(2))"; GP-020
lists `single` as a supply type; the review (row 13) confirmed. GP-022 is Approved with 22a (ordinary
invoice, GST on the final price) and 22b (Dr CUSTOMER_PREPAYMENTS coded with negative tax / Dr GST
collected / Cr AR, allocated). Applied to a single supply the receivable item is the whole tax
invoice and the application removes the GST already reported on the receipts, so the contract's
GST equals the GST on the final price. **No candidate golden is needed.** Build detail for T-0249:
the two GP-022 entries (22a source `ar_invoice`, 22b source `ar_prepayment_application`) on the
invoice date, the 22b AR credit allocated to the 22a item, the contract's dimension on the
CUSTOMER_PREPAYMENTS line, receipts' net and GST from the contract's (non-reversed) receipts.

**Q6 — nothing attributed: an ordinary invoice that finalises the contract.** On accruals with
no receipt nothing was attributed; the final invoice is the first invoice for the supply, so the
whole GST is attributable to the invoice's period (s 29-5(1), as for any invoice). The journal is
GP-022a (= the GP-001 shape): Dr AR (whole invoice) / Cr revenue coded (GST) / Cr GST collected.
No unbilled asset, no prepayment to apply, nothing to adjust: a final price that differs from the
contract total is simply the price, and no adjustment-note particulars arise (no GST was attributed
earlier). Comparable systems (source 5; RQ-0178 source 5) issue such a document as a normal
invoice. Making it finalise the contract keeps one document per contract (later receipts are
then ordinary AR receipts GP-002 against the invoice, and contract receipts are refused as for any
finalised contract). **Decision: issue it as an ordinary GP-022a invoice and finalise the
contract; covered by Approved GP-022a/GP-001, no candidate golden.** Build in T-0249 (with Q5,
same code path minus 22b).

**Q7 — delivery event.** `approveInvoice` publishes `ar.invoice.posted` (aggregate
`sales_invoice`, payload invoice id/no, entry id, party, gross, Billing To recipients) in the
posting transaction and refuses NO_BILLING_TO. The single-supply final invoice is a register
invoice (RQ-0178 Q1) and must be delivered the same way; the e-mail handler reads the register.
It needs an outbox dependency the function does not take today. Build in T-0249 together with the
cash and nothing-attributed invoices, so every final-invoice path gains the event in one change
and one test suite.

**Q8 — slice.** T-0231 slice 1: Q1–Q4 (AC-3 and AC-9 recording) with migration 0087 — the
reversal record and the attribution renewal —, the contract view excluding reversed receipts, and
a property over random receipt/reversal sequences. Moved with full text to **T-0249**: the
cash-basis final invoice (GP-022), the nothing-attributed final invoice (Q6 decision) and the
`ar.invoice.posted` event for every final invoice. T-0218 keeps the BAS presentation of the label.

**Q9 — primary law.** On 2026-11-23 the proxy refused CONNECT to legislation.gov.au and
austlii.edu.au and ato.gov.au answered 403 (probe file). The GST Act ss 29-5, 29-20, Div 19 and
the ATO error-correction guidance remain **unread**; Q4 rests on the T-0168 review's ATO extract
and Approved GP-019; nothing here claims the primary text. T-0218 AC-11 still owns the reading.

## Conclusion

Q1 engine reversal (GP-019, Q11), no new golden. Q2 LIFO; a 40a reversal returns the contract to
nothing attributed and the next receipt re-attributes (renewal table). Q3 refused after
finalisation, after cancellation, already reversed, not latest, bad date or reason, basis changed.
Q4 `bas_treatment` same_period | error_correction from the BAS period (frequency in force on the
receipt date) stored on the reversal record. Q5 GP-022 covers the cash-basis final invoice. Q6
nothing attributed → ordinary GP-022a invoice that finalises the contract. Q7 publish
`ar.invoice.posted` as approveInvoice does. Q8 slice 1 = Q1–Q4; T-0249 = Q5–Q7. Q9 unread,
recorded.

Decisions: DL-0980 (no new golden, engine reversal), DL-0981 (LIFO and re-attribution),
DL-0982 (refusals), DL-0983 (BAS label and period rule), DL-0984 (migration 0087), DL-0985 (cash
final by GP-022), DL-0986 (nothing-attributed decision), DL-0987 (slice and T-0249), DL-0988
(primary law status).
