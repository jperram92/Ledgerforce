---
adr: 0089
title: "Single-supply GST attribution on accruals: whole-supply coded line with contra, GST_ATTRIBUTED_UNBILLED asset, code-driven BAS unchanged"
status: Accepted
date: 2026-11-16
author: claude
category: accounting
human_gate: yes             # accounting; accepted under the standing delegation DL-0263 (AGENTS.md §6) with RQ-0171
supersedes: none            # canonical line; reconciles source 872c4fa ADR-0045 (not present on this line)
superseded_by: none
---

# ADR-0089: Single-supply GST attribution on the canonical engine

## Status

Accepted 2026-11-16 by claude under the owner's standing accounting delegation (DL-0263; brief
instruction DL-0691), backed by research RQ-0171, recorded in DL-0750…DL-0754, covered by golden
entries GP-040…GP-042 and the SS-PLAT-135 DB proof. Self-review as accountant-reviewer:
`.agent/evidence/T-0168/accounting-self-review.md`. An independent cross-provider review follows
and may supersede this ADR; this acceptance is not that review.

Qualified provenance: source 872c4fa ADR-0045 ("source ADR-0045") R1–R9 and its Drafts GP-012-B /
GP-015-B. Those IDs mean nothing on this line; this ADR is their canonical successor.

## Context and problem statement

On the accruals basis GST on a single (non-Div 156) supply is attributable in full to the period
of the first receipt or invoice (GST Act s 29-5(1); RQ-0171 finding 1). Canonical code supports
progressive/unknown-total prepayments (GP-020, GST on the amount received) and the whole-supply
advance tax invoice (GP-021), and refuses an uninvoiced single-supply receipt. GP-021 recognises a
receivable for the whole price, which AASB 15 permits only when the right to consideration is
unconditional (Q13: non-cancellable contracts). A cancellable single-supply job paid partly in
advance has no supported path, and a deposit invoice (GP-014) for a single supply under-reports.

Source ADR-0045 solved it with a new tax code `GST-UB` whose G1 is `tax × (1 + rate) / rate`
(lossy under rounding — RQ-0171), a role-aware engine guard, and a new BAS mapping model the
canonical `bas.ts` does not have. Its cash-basis rule (R4) depended on a per-company ledger shape
the canonical BAS API does not know.

## Decision drivers

- Correct accruals BAS for single supplies; no change to the default progressive path.
- BAS purely code-driven through the existing `bas.ts` rules (T-0035), lossless G1.
- Balance sheet: contract liability equals GST-exclusive consideration received; GST paid ahead of
  billing is an asset, not offset against the liability (AASB 101 offsetting; AASB 15 ¶108 —
  no receivable for a conditional right).
- Additive, forward-only schema using the canonical extended-role mechanism (ADR-0061).
- Immutable posting; corrections by reversal or adjustment.

## Considered options

1. **Source ADR-0045 port** — `GST-UB` code with `tax_grossed` G1. Rejected: lossy G1, new BAS
   model, extra tax code that can be mis-used.
2. **Additive `journal_line.tax_base_amount`.** Rejected: changes the core ledger row and hash
   chain for one use case.
3. **Gross-up** — Dr unbilled consideration 7,700 / Cr CUSTOMER_PREPAYMENTS 10,000 coded.
   Rejected: recognises an asset and liability for a cancellable executory contract.
4. **GP-021 only, refuse the rest.** Rejected as the only path: blocks a common, lawful case.
5. **Chosen — whole-supply coded line with uncoded contra on CUSTOMER_PREPAYMENTS and the GST not
   yet received from the customer on a `GST_ATTRIBUTED_UNBILLED` asset.**

## Decision outcome

Chosen option 5, alongside GP-021 (still preferred for non-cancellable contracts). Rules:

- **R1 — classification.** Prepayment receipts (and later deposit invoices) record a supply
  pattern ∈ {`progressive_periodic`, `unknown_total`, `single_supply`, `gst_free`,
  `security_deposit`} with who confirmed it and when; no default; posted documents are immutable.
  Canonical value names are kept (`progressive_periodic`, not source `progressive_div156`).
- **R2 — contract record.** `single_supply` requires a contract (supply) record: party, known
  GST-exclusive total, one taxable GST code, attributed GST, attribution date, GST basis in force,
  status (open / finalised / cancelled). Unknown or mixed totals are refused (`unknown_total`
  remains available).
- **R3 — role.** New extended system role `GST_ATTRIBUTED_UNBILLED`: asset, not control, postable;
  bound in `app.account_system_role_ext` by widening `system_role_is_extended` and
  `system_role_allows` (ADR-0061 pattern). AU services template account 1230 "GST attributed on
  unbilled supplies" (other current asset; outside trade receivables and the ECL base).
- **R4 — first receipt, accruals (GP-040a).** Whole-supply GST fixed by the total invoice rule
  on the known total (half-up to cents). Journal: Dr bank (received) / Dr GST_ATTRIBUTED_UNBILLED
  (whole GST − GST in the receipt) / Dr CUSTOMER_PREPAYMENTS uncoded (known net − received net) /
  Cr CUSTOMER_PREPAYMENTS coded GST with the whole net and whole GST / Cr GST collected (whole
  GST). GST in the receipt = receipt × rate / (1 + rate), half-up.
- **R5 — later receipts (GP-040b).** No GST: Dr bank / Cr CUSTOMER_PREPAYMENTS (net) /
  Cr GST_ATTRIBUTED_UNBILLED (GST part). Refused if the receipts would exceed the contract total.
- **R6 — final invoice (GP-041).** A tax invoice showing the fixed GST (distributed to lines by the
  GP-023a residual method). Journal: Dr AR_CONTROL (total − received) / Dr CUSTOMER_PREPAYMENTS
  (received net) / Cr revenue uncoded (known net) / Cr GST_ATTRIBUTED_UNBILLED (its balance).
  A price change adds a coded revenue line with its own GST (increase GP-041b, decrease GP-041c)
  presented by the company's `credit_note_bas` setting as GP-029 (default netted into G1/1A); a
  decrease carries adjustment-note particulars.
- **R7 — cancellation (GP-042a).** Before the final invoice: Dr CUSTOMER_PREPAYMENTS coded GST
  (unbilled net, tax = unbilled GST) / Dr GST collected / Cr CUSTOMER_PREPAYMENTS uncoded /
  Cr GST_ATTRIBUTED_UNBILLED (balance), with adjustment-note particulars. Refund of the part paid
  (GP-042b): Dr CUSTOMER_PREPAYMENTS coded GST (negative) / Dr GST collected / Cr bank.
  Forfeiture of a part payment is refused until researched.
- **R8 — cash basis.** If the GST basis in force on the receipt date is cash, `single_supply`
  receipts post the GP-020 shape and apply by GP-022 (s 29-5(2)); no contra, no unbilled asset.
  A contract never changes shape: documents dated after a basis change are refused for an open
  contract until researched.
- **R9 — deposit invoice.** A `single_supply` deposit invoice on accruals is refused with the
  advice to use GP-021 or the receipt path, until a golden for the invoice form exists.
- **R10 — BAS.** No change to the label rules. BAS-preparation (T-0204) lists each contributing
  prepayment's pattern and every contract whose GST_ATTRIBUTED_UNBILLED balance is non-zero and
  older than 90 days; the BAS query refuses or flags a basis that differs from the basis in force.
- **R11 — invariants.** Per contract: Σ GST_ATTRIBUTED_UNBILLED = attributed GST − GST received −
  GST cleared; it is zero once finalised or cancelled; GST reported on the contract = GST on the
  final consideration. Property tests in T-0203/T-0204.
- **R12 — refusal until built.** Until T-0203 is done `single_supply` stays refused exactly as
  today (`INVALID_PREPAYMENT`, nothing written).

## Consequences

Good: lossless, code-driven BAS (proven by SS-PLAT-135 on the unchanged query); no new tax code;
clean balance sheet; reuses GP-029 presentation. Bad: journals show a gross line and contra on the
same account (documented in each golden); one new role and template account; users must make the
legal classification. Neutral: other packages report only GST on the amount received; the BAS
preparation report explains the difference.

## Compliance and verification

| Check | Where |
|---|---|
| GP-040…042 tables balance and are parsed as Approved | `packages/ledger/src/golden/golden-postings.golden.test.ts` |
| Engine replay pinned PENDING on the unbound role, owner T-0203 | `packages/ledger/src/golden/golden-engine.db.test.ts` |
| Goldens give their Tax/BAS lines through the unchanged BAS query | `packages/modules/tax/src/single-supply-attribution.db.test.ts` (SS-PLAT-135) |
| Role, receipt posting, refusals, idempotency, concurrency, RLS | T-0203 |
| Finalisation, price change, cancellation, refund, reports, basis guard | T-0204 |

## Links

RQ-0171 (resolves RQ-0134), RQ-0095/RQ-0096 (Q7, Q13), ADR-0061, ADR-0071; GP-014, GP-020…GP-023,
GP-029, GP-040…GP-042; DL-0263, DL-0320, DL-0750…DL-0754.
