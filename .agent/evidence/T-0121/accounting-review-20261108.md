# Accounting review — AU templates v2 (T-0121: chart, posting profiles, au-gst EXS) — 2026-11-08

> **Honesty statement.** This is an AI persona modelled on the knowledge and professional standards
> of an Australian Chartered Accountant / CPA who is also a registered tax agent. It is **not** a
> registered practitioner, holds no TPB registration, carries no professional indemnity insurance
> and cannot sign or lodge anything. The product owner chose this persona instead of paid external
> review (DL-0248). Its findings are the best available technical review, not professional advice.

Reviewer: accountant-reviewer (claude persona, DL-0282 pattern) · Branch `feat/T-0121-au-templates-v2`
at 059b6ea · Scope: the v2 diff only:
`packages/modules/gl/templates/au-services-smb.v2.json`,
`packages/modules/products/templates/au-services-smb-profiles.v2.json`, the EXS rows in
`packages/modules/tax/templates/au-tax-codes.json`, and DL-0340…DL-0342. These were checked
against my earlier ruling (`.agent/evidence/T-0007/accounting-review-20261108.md`, DL-0280 MAJORs
3–6 and the INP / W-code MINORs). Read-only. I edited nothing except this report.

**Independence note.** The builder and the persona are the same provider. I therefore re-derived
each default from the standard or the Act, not from my earlier wording. The BAS effect of each
default was traced through T-0035's label map (`bas-compute.ts`, DL-0277) and the T-0039 resolver
(`matrix.ts`), so that each finding is about what the code will actually report.

## Overall: **PASS** (0 BLOCKER · 0 MAJOR · 5 MINOR · 11 CONFIRMED)

Every template MAJOR of DL-0280 that T-0121 carries is fixed as proposed. No v2 default misstates
the BAS form labels or the balance sheet. The one omitted item (worksheet labels G4/G14) does not
change any lodged label and is tracked as T-0145. The MINORs are notes for later cards.

| Item | Verdict | Severity | Standard / law | Finding | Proposed change |
|---|---|---|---|---|---|
| 1500 Office equipment → `CAP` | Fixed | CONFIRMED | BAS G10 (capital purchases) vs G11; AASB 116 ¶7 | Purchases coded to a fixed-asset account now default to G10 + 1B. Net GST is unchanged, and G10/G11 are now correct on the full BAS. Matches GP-008 (CAP). | — |
| `CAP` default when the supplier is not registered | Note | MINOR | GST Act s 11-5 (no creditable acquisition without a taxable supply) | A default of CAP at 10 % on a purchase from an unregistered seller would claim a credit that does not exist. That is a coding error on the bill, not a template error, and the same risk exists for `GST` on expense accounts. | Bill entry (T-0050 / T-0123) should show the supplier's GST registration next to the line code. No template change. |
| 1510 Accumulated depreciation, no code | Fixed | CONFIRMED | Depreciation is not a supply (BAS excluded) | Credit-normal contra asset with no default code. Depreciation journals carry no GST. | — |
| 1290 Allowance for expected credit losses | Added | CONFIRMED | AASB 9 ¶5.5.15 (simplified approach), ¶5.5.17; AASB 101 ¶54(h) | Contra receivable, credit normal, postable, not control and no tax code: an allowance movement is a measurement estimate, not a supply. GST is adjusted only at write-off (ADJ-BD, Div 21). Receivables are presented net of it. This is not prohibited offsetting, because the allowance is part of measuring the asset (AASB 101 ¶33). | — |
| 1290 in reports | Note | MINOR | AASB 101 ¶54(h); aged-receivables reconciliation | 1290 has subtype `receivable` but is not the AR control. The aged-receivables reconciliation must compare the subledger with 1200 only, and the balance sheet should show trade receivables net of 1290. | Note for T-0076 (balance sheet) and T-0077 (aged AR). |
| `ecl_allowance_account = 1290`; `bad_debts_account` stays 6500 | Added | CONFIRMED | AASB 9 ¶5.5.8 (impairment gain/loss in P&L) | The allowance and the impairment expense are separate settings, as GP-007-A (T-0124) needs: Dr 6500 / Cr 1290 on provisioning, Dr 1290 (+ ADJ-BD split) / Cr AR on write-off. | — |
| 4140 Hardware sales (`GST`) | Added | CONFIRMED | AASB 15 ¶114, B89 (disaggregation); s 9-5 | A product sale is revenue from contracts, not a cost recovery. 4190 stays for genuine recoveries (REIMBURSABLE_EXPENSE, FREIGHT). | — |
| HARDWARE: asset slot empty, cogs gap | Fixed | CONFIRMED | AASB 102 ¶6, ¶9 vs AASB 116 ¶6 | Resale hardware is no longer capitalised into PP&E by default. The empty slot forces the wizard to ask "inventory or expensed on purchase". An empty slot is safer than a wrong one. | — |
| Chart has no inventory / COGS accounts | Note | MINOR | AASB 102 | A tenant that answers "inventory" has no template account to map to. This is the existing "chart completeness" MINOR of DL-0280 and stays out of this card. | Later template version or wizard prompt (card note in T-0121). |
| EQUIPMENT (own use): asset 1500, purchase code CAP | Added | CONFIRMED | AASB 116 ¶7, ¶16; BAS G10 | Own-use equipment is capitalised on 1500 at cost excluding the recoverable GST. CAP sends the purchase to G10. Not mapped from Salesforce Product2.Family, which is correct because it is not a product that is sold. | — |
| EQUIPMENT appears in the sales gap list | Note | MINOR | — | The gap check will list EQUIPMENT × customer profiles (no revenue slot). A disposal of PP&E is not revenue (AASB 116 ¶68, ¶71: gain or loss on derecognition), so no revenue account should be mapped. This is noise in the wizard list, not a misstatement. | T-0080/T-0091: let the wizard mark a profile "not sold" (no template change). |
| OVERSEAS_CUSTOMER: no default code | Fixed | CONFIRMED | s 38-185, s 38-190, s 9-25 | A product without its own code sold to an overseas customer now refuses `NO_TAX_CODE`, and a person codes the line. With a product code of `GST` the sale defaults to GST. That can over-collect, but it never silently under-collects, which is the conservative, ATO-defensible interim until ADR-0044 (T-0122/T-0123). | — |
| EXS → G1 + G3 | Added | CONFIRMED (prior knowledge, primary source unverified) | s 38-190; ATO BAS instructions: G2 export sales, G3 other GST-free sales | Exports of services are GST-free under s 38-190 and are reported at G3. G2 is for exported goods (EXP, s 38-185). The ATO instructions page could not be fetched in this environment (same host block as DL-0280). | Re-check G2 wording when ato.gov.au is reachable (listed below). |
| EXP → G1 + G2; FRE → G1 + G3 (T-0035) | Re-checked | CONFIRMED | as above | Unchanged by T-0121. Consistent with EXS. | — |
| INP purchases → G11, never G13; INP sales → G1 | Re-checked | CONFIRMED | s 11-15(2)(a) (no credit for input-taxed supplies); BAS G11, G13 | Bank fees and other financial supplies received are non-capital purchases at G11. G13 (purchases for making input-taxed sales) is never produced, and a test pins that. G1 correctly includes input-taxed sales. | — |
| G4 / G14 not produced | Deferred | MINOR | GST calculation worksheet | G4 and G14 are worksheet labels and are not lodged. Their absence does not change G1, G10, G11, 1A or 1B. Deferral to T-0145 (DL-0341) is acceptable. | T-0145. |
| BAS-W1 / BAS-W2 at the pay-run date | Re-checked | CONFIRMED (conditional) | TAA 1953 Sch 1 s 16-5 ff; ATO W1/W2 "amounts paid / withheld in the period" | The map applies at the entry date and payroll is `immediate` on the cash basis, so W1/W2 follow the pay-run journal's date. That is correct **only if** T-0100 dates that journal at payday and never puts BAS-W1 on an accrual of unpaid wages. | Condition recorded for T-0100 (DL-0341). |
| v1 kept for companies set up with it | Process | CONFIRMED | AASB 108 ¶14 (policy changes are not applied silently) | No tenant rows are rewritten. Companies on v1 keep 1500 → GST and OVERSEAS → FRE until a person changes them. Before the first release, no production company exists on v1, provided the setup wizard (T-0080) loads v2 (DL-0340). | T-0080 must load `auServicesSmbV2`, `auTaxCodes` (v2) and `auServicesSmbProfilesV2`. |

## Proposed superseding entries
None. T-0121 changes template data only. GP-007-A (the allowance path using 1290) is drafted in
T-0124.

## Items to re-check when primary sources are reachable
- ATO BAS instructions, G2 vs G3 for exported services (supports EXS → G3).
- ATO full-BAS GST calculation worksheet G4/G13/G14 wording (for T-0145).
