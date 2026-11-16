---
id: RQ-0171
title: Single-supply GST attribution on the canonical engine — law, comparable systems, journal and BAS contract
status: resolved
opened: 2026-11-16
resolved: 2026-11-16
opened_by: claude
linked_tasks: [T-0168, T-0203, T-0204]
linked_adrs: [ADR-0089]
supersedes_questions_of: RQ-0134
superseded_by:
---

# RQ-0171 — Single-supply GST attribution: contract for the canonical engine

## Question

RQ-0134 left four items open before any single-supply code: (1) migration integration, (2) account
binding storage, (3) primary-law confirmation of the lifecycle (first payment, later receipts,
final invoice, price change, cancellation, cash basis, reversal), (4) an accounting ADR and fresh
golden IDs. It also flagged two defects in source 872c4fa ADR-0045 R6: the `tax_grossed` G1
derivation and the cash-basis loss of later GST. This record answers all of them for the canonical
line (base b0adde3, migrations 0001–0071).

## Access log (honest)

| Source | Result 2026-11-16 |
|---|---|
| ATO legal database (`ato.gov.au/law/view/...`, GSTR 2000/29, 2000/34, 2001/8) | HTTP 403 (CDN "Access Denied" to the build environment). Not read today. |
| legislation.gov.au, austlii.edu.au | Egress proxy refused CONNECT. Not read today. |
| github raw (frappe/erpnext `develop`) | Read: `erpnext/controllers/taxes_and_totals.py`, `erpnext/accounts/doctype/payment_entry/payment_entry.py`. |
| Repository records | Read in full: RQ-0134 (primary GST Act PDFs, compilation 1 Jan 2026, opened 2026-11-10: s 29-5, s 99-5, s 156-5), research notes `Docs/research/research_notes/AASB alignment…/gst_accounting.md` and `…/AASB decisions confirmed by law/gst_decisions.md` (ATO/vendor extracts with URLs), source 872c4fa ADR-0045, canonical `bas.ts`, `prepayments.ts`, `0032_tax_codes.sql`, `0042_ar_prepayments_deposits.sql`, `0062_gl_period_end_system_roles.sql`, `0067_tax_ar_wizard_settings.sql`. |

Statements below are tagged **[primary, read 2026-11-10 in RQ-0134]**, **[extract, recorded in repo
notes]**, **[code read today]** or **[prior knowledge — unverified]**. Nothing tagged unverified is
load-bearing for a journal line without a second, verified support.

## Findings — law

1. **Attribution of the whole GST on a single supply.** s 29-5(1): GST payable on a taxable supply
   is attributable to the tax period in which any of the consideration is received or, if earlier,
   an invoice is issued **[primary, read 2026-11-10 in RQ-0134]**. The rule attributes "the GST
   payable on the supply", not a proportion. GSTR 2000/29 restates it ("the whole or part of the
   GST payable … to the tax period in which you receive … any part of the consideration or an
   invoice is issued") **[extract]**; an ATO edited private ruling citing GSTR 2000/35 says "the
   first instalment paid will trigger attribution for the total consideration (excluding the
   deposit amount) under section 29-5" **[extract; persuasive only]**; GSTR 2006/2 says a part
   payment is consideration when paid and the GST on the supply is attributed to that period
   **[extract]**. Conclusion: on the accruals basis a part payment on a single supply with a known
   price attributes the supply's full GST to the receipt period. Confidence high.
2. **Invoice first.** Under s 29-5(1)(b) an *invoice* issued before payment also attributes the
   whole GST **[primary]**; "invoice" (s 195-1) is a document notifying an obligation to pay
   **[prior knowledge — unverified]**. Consequence: a canonical *deposit invoice* (GP-014, 30%)
   for a single supply under-reports on accruals exactly like an untaxed prepayment. The canonical
   deposit invoice carries no supply classification today — a latent risk T-0203 closes by refusal.
3. **Cash basis.** s 29-5(2): GST is attributable to the extent consideration is received
   **[primary]**. A single supply on the cash basis needs no special journal: GST on each receipt
   (GP-020 shape) is correct, and the canonical cash BAS (allocation-proportional) already
   attributes a later invoice's remaining GST on settlement.
4. **Progressive/periodic supplies.** s 156-5 requires *both* progressive/periodic supply and
   progressive/periodic consideration; a staged payment alone does not make a supply progressive
   **[primary]**. The classification is therefore a recorded user judgement, never inferred from
   the payment pattern; the conservative choice when in doubt on accruals is `single_supply`.
5. **Security deposits.** s 99-5: a genuine security deposit is not consideration until forfeited
   or applied **[primary]**. Unchanged canonical `security_deposit` path.
6. **Unknown total.** The Commissioner's particular attribution rules attribute only to the extent
   consideration is ascertainable when the total is not known **[extract; instrument number
   unconfirmed]**. Canonical `unknown_total` keeps GP-020; `single_supply` requires a known total.
7. **Mixed vs composite supply (GSTR 2001/8).** A *mixed* supply has separately identifiable
   taxable and non-taxable parts and its consideration is apportioned; a *composite* supply has
   integral/ancillary parts and is treated as one supply **[prior knowledge — unverified; ATO site
   blocked]**. Consequence for design only (no journal relies on it): the attributed GST is GST on
   the taxable part of the known total. MVP accepts one taxable GST code per contract and refuses a
   mixed contract with a named error until a researched golden exists (T-0203).
8. **Price change and cancellation.** A change in consideration or cancellation after attribution
   is an adjustment event (Div 19; s 19-10) giving an increasing or decreasing adjustment in the
   period the supplier becomes aware **[extract in repo notes, consistent with canonical GP-029 /
   Q4 resolution]**. Canonical already presents sales adjustments by company setting: default nets
   into G1/1A of the adjustment period, `credit_note_bas = ato_adjustment` uses GST-ADJ → 1A/1B
   (GP-029). The single-supply lifecycle reuses that presentation; no new BAS rule.
9. **Adjustment notes.** A decreasing adjustment on a taxable sale requires adjustment-note
   particulars (s 29-75) **[prior knowledge — exact trigger wording unverified]**. Conservative
   rule: the finalisation document with a price decrease and the cancellation document always
   carry adjustment-note particulars (T-0204).
10. **Rounding.** ATO allows the total invoice rule or the taxable supply rule, and supplier and
    recipient may differ **[extract, ATO "Tax invoices" page, recorded in repo]**; statutory
    rounding origin s 9-90 with the EM example **[extract]**. The brief named GSTR 2000/34 as the
    invoice-level rounding authority; the repository's earlier search summary associates GSTR
    2000/34 with the low-value tax-invoice threshold instead. Not readable today, so **no decision
    relies on GSTR 2000/34**. Design consequence: whole-supply GST is fixed once, at attribution,
    by the ATO total invoice rule on the known GST-exclusive total (half-up to cents, canonical
    `computeTax`), and the final tax invoice shows that fixed amount, distributing it over lines
    with the GP-023a largest-line residual method. A rounding-only residual therefore cannot arise
    between attribution and finalisation; only a genuine price change produces an adjustment.

## Findings — comparable systems

- **ERPNext** **[code read today]**: `taxes_and_totals.calculate_taxes` accumulates unrounded tax
  per item and rounds once per tax row (document level) unless the `round_row_wise_tax` flag is
  set (row-wise rounding). Advance payments (`payment_entry.calculate_taxes`) charge advance tax
  `On Paid Amount` (proportional to the amount received) or a user-entered `Actual` amount; there
  is no single-supply whole-GST concept.
- **Xero** **[extract]**: GST per line rounded to cents; a "Prepayment" carries a tax rate on the
  amount received; "Overpayment" carries none. No single-supply whole-GST rule.
- **MYOB AccountRight** **[extract]**: running-total line GST; customer deposits proportional
  [MYOB deposit handling unverified].
- **QuickBooks Online AU** **[extract]**: taxable supply rule (per line).
- Conclusion: mainstream SMB packages attribute GST on the amount received only. That is right
  for Div 156 and cash basis, and understates accruals GST for single supplies. LedgerForce keeps
  the proportional path for those cases and adds an explicit single-supply path; differences
  against other packages must be explained in the BAS-preparation report (R7).

## Findings — canonical engine (resolves RQ-0134 items 1, 2 and the R6 defects)

- **BAS stays code-driven without change.** `bas.ts` treats a coded line on a liability or revenue
  account as a sale (net = credit − debit, G1 += net + tax, 1A += tax). If the receipt journal
  carries the *whole supply* as a coded credit on CUSTOMER_PREPAYMENTS (10,000.00, tax 1,000.00)
  and an uncoded contra debit on the same account for the consideration not yet received
  (7,000.00), the accruals BAS gives exactly G1 11,000.00 / 1A 1,000.00, the contract liability
  balance is exactly the GST-exclusive cash received (3,000.00), and the GST collected not yet
  received from the customer (700.00) sits on a dedicated asset. No `tax_grossed` derivation, no
  lossy G1, no new tax code, no BAS kind, no `journal_line` column. Proven by SS-PLAT-135
  (`packages/modules/tax/src/single-supply-attribution.db.test.ts`) through the unchanged query.
- **Account binding.** Canonical ADR-0061 provides additive extended roles
  (`app.system_role_is_extended`, `app.system_role_allows` widened by CREATE OR REPLACE, binding
  table `app.account_system_role_ext`, view `app.account_role_binding`). New role
  `GST_ATTRIBUTED_UNBILLED` (asset, not control, postable) fits that mechanism; no DROP of the 0005
  CHECK. Template account: AU services SMB code 1230 "GST attributed on unbilled supplies" (free).
- **Migration numbering.** The DL-0320 map is historical: the canonical line now integrates 0049–0071
  contiguously (verified with `git ls-tree claude/loving-lovelace-nozqpk packages/db/migrations/`,
  2026-11-16). This round's coordinator reserved 0072–0076 for parallel cards and **0077** for this
  task. A 0077 file on this branch would leave a 0072–0076 gap that the migrator refuses, so no
  migration is added here; T-0203 takes the next free number after the round is merged.
- **Cash basis.** The attributed-unbilled shape is accruals-only and is chosen by the GST basis in
  force at the attribution date (`app.tax_settings`, ADR-0071). On the cash basis a single supply
  uses the GP-020/GP-022 shapes. The canonical BAS function accepts either basis for any ledger;
  a cash-basis what-if over an accruals ledger would count the GP-040a entry at once. T-0204 makes
  the BAS function refuse a basis that differs from the basis in force for the period, or flag it.
  A change of GST basis while a contract has an unbilled attribution is refused for that contract's
  documents with a named error until researched (the ATO transitional rules were not read).

## Conclusion

1. Keep GP-021 (whole-supply advance tax invoice) as the preferred path for non-cancellable
   contracts; it is already exact on both bases.
2. Add a single-supply receipt path for accruals (GP-040), its final invoice without duplicate GST
   and with price-change adjustments (GP-041), and cancellation/refund (GP-042), using the
   whole-supply coded line + contra + `GST_ATTRIBUTED_UNBILLED` asset. Cash basis uses GP-020/022.
3. Refuse until built: `single_supply` deposit invoices on accruals, mixed contracts, unknown
   totals, basis changes mid-contract, forfeiture of a part payment.
4. Decision recorded in ADR-0089 (accounting, accepted under the DL-0263 standing delegation),
   DL-0750…DL-0754. Implementation is split into T-0203 (schema, binding, receipt posting) and
   T-0204 (finalisation, cancellation, reports).

Confidence: high for findings 1, 3–5 and the engine contract (primary text plus a passing DB
proof); medium for 2, 6, 8, 10 (extracts); low/unverified for 7 and 9, which only add refusals or
extra document particulars, never a journal line.

## Addendum A — independent accounting review (2026-11-16)

An independent AI accounting review (same provider, separate instance; not the cross-provider
gate) returned **PASS WITH MAJORS, no BLOCKER**: `.agent/evidence/T-0168/accounting-review-20261116.md`.
Its sources are ATO web-search extracts; it could not reach legislation.gov.au or ato.gov.au
either. Conclusions taken:

1. **Cancellation timing (finding 9/10, MAJOR) — accepted.** On the accruals basis an adjustment
   is attributed to the period the supplier becomes aware of it (s 29-20(1), ATO "when to make
   adjustments" extract). When the refund is agreed at cancellation the corrected consideration
   is nil, so the whole 1,000.00 is a decreasing adjustment of the cancellation period, with one
   adjustment note (needed before claiming a decrease above $75, s 29-20(3)/s 29-80 extract), and
   the received 3,300.00 becomes a refund obligation (customer credit), no longer a contract
   liability (AASB 15 ¶106 extract: no remaining performance obligation). GP-042 split it 700/300
   across periods and is superseded by **GP-044**. The 700/300 split survives only as a variant
   for a refund that is undecided or disputed, because until then the money received may still
   be retained as consideration; its later 300.00 decrease needs its own adjustment note.
2. **Final invoice shape (finding 17) — changed.** Canonical GP-022 puts the whole invoice on AR
   and allocates the prepayment; the AR original then equals the tax invoice and the receipts are
   visible in the invoice's allocation history (customer statements, Salesforce paid amounts).
   GP-041 posted only the 4,400.00 due. **GP-045** supersedes it with a one-entry shape: AR debit
   for the tax invoice, AR credit for the cash received, allocated at once (engine accepts both
   items and the allocation — SS-PLAT-135). GP-015's net shape stays right for deposit
   *invoices*, whose receipts already sit on AR.
3. **Variation timing (finding 7, MAJOR)** — the delta belongs to the period the variation is
   agreed; GP-045b/c are stated for a variation agreed on the invoice date, other dates are a
   T-0204 variation document, refused until built.
4. **Negative G1 (finding 11, MAJOR)** — ATO BAS instructions (extract) say not to report negative
   figures; BAS preparation must present a netted negative as G18/1B (T-0204). The BAS query's
   raw labels may be negative; SS-PLAT-135 asserts raw query output only.
5. **Tax invoice requested on an open contract (finding 14, s 29-70)** and **final price below
   cash received (finding 15)** — new acceptance criteria on T-0203/T-0204 with the reviewer's
   journal as a candidate golden.
6. **Minors** — contract id on lines, last-receipt rounding residue, reversal labelling, 1230
   recoverability disclosure: carried to T-0203/T-0204 (DL-0757).
7. **Citation** — GSTR 2019/1 concerns supplies connected with the indirect tax zone, not single
   vs progressive supply; it is not relied on. Mixed/composite: GSTR 2001/8 (unverified text).

**Primary sources still unread.** legislation.gov.au, ato.gov.au (legal database and guidance) and
the AASB site were unreachable from the build environment on 2026-11-10 (partly) and 2026-11-16.
GST Act s 29-5, 29-20, 29-70, 29-75, 29-80, 19-10, 19-45, GSTR 2000/29, GSTR 2001/8, the current
BAS instructions, AASB Interpretation 1031 and AASB 101 ¶32 **must be read directly before T-0204
closes** (T-0204 AC-11); any difference is handled by superseding goldens, never by editing them.
