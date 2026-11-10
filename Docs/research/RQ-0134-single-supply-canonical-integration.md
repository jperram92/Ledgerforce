---
id: RQ-0134
title: Integrate single-supply GST attribution with canonical storage and BAS
status: open
opened: 2026-11-10
resolved:
opened_by: codex
linked_tasks: [T-0168]
linked_adrs: []
superseded_by:
---

# RQ-0134 — Single-supply canonical integration

## Question

How can source ADR-0045 R1–R9 be implemented on the owner-selected canonical line without
reusing task/migration/accounting IDs or changing approved historical journals?

## Sources actually inspected

- Source 872c4fa `Docs/adr/0045-gst-supply-pattern-and-attributed-unbilled-gst.md`, read in full
  2026-11-10. It specifies classification, a dedicated unbilled GST asset/code, whole-supply
  attribution, basis-specific BAS, later finalisation/price changes/cancellation and aged balances.
- [GST Act compilation 96, 1 January 2026, section 29-5](https://www.legislation.gov.au/C2004A00446/2026-01-01/2026-01-01/text/original/pdf/1),
  primary PDF opened 2026-11-10. Section 29-5 attributes GST at the first consideration or earlier
  invoice; cash accounting attributes only the consideration received. Special rules require
  separate checking before selecting progressive or security-deposit treatment.
- Canonical `prepayments.ts`: explicit receipt types; rejects `single` with advice to issue a
  whole-supply advance invoice. `invoices.ts` deposit kind lacks supply classification.
- Canonical `bas.ts`: tax code kind/labels and account type drive BAS; it has no source
  `tax_grossed` mapping model. Adjustment-code tax lines use their debit/credit directly.
- `0005_gl_chart_of_accounts.sql`: fixed role CHECK; adding source role cannot be done by
  pretending it already exists. Canonical ECL uses an AR setting/account binding instead.
- `migrate.ts`: requires contiguous unique migration versions; later canonical branches reserve
  slots absent from this checkout. Inventory must precede schema allocation.
- [GST Act volume 2, section 156-5](https://www.legislation.gov.au/C2004A00446/2026-01-01/2026-01-01/text/original/pdf/2),
  primary PDF opened 2026-11-10: progressive treatment requires both progressive/periodic supply
  and progressive/periodic consideration. A staged payment alone does not establish it.
- Volume 1 section 99-5, directly inspected 2026-11-10: genuine security deposits are not
  consideration until forfeited or applied. Preserve the distinction from ordinary advance payments.

## Findings so far

Inventory found nine distinct canonical migrations competing for slots 0049–0053. The source
blob/commit evidence is saved under T-0168. DL-0314 reserves a consolidated order in
`.agent/CANONICAL-MIGRATION-MAP-2026-11-10.md`; it is not applied yet and does not certify upgrade
of databases already migrated from divergent feature branches. No placeholder slots or checksum
rewrites are acceptable.

GP-021's full advance-invoice route remains a valid supported alternative. It does not implement
the source's uninvoiced single-supply receipt. Copying source patches would silently mismatch
the canonical tax engine, role constraints and migration history.

Proposed investigation: retain the economic dedicated-asset treatment while evaluating canonical
settings bindings versus an additive role registry. Keep GST-UB restricted to its configured
account, separate accrual attribution from cash receipts, and carry contract identity through
finalisation/cancellation. No production design is selected or approved yet.

## Unresolved before build

1. Reconcile the canonical migration union and any duplicate later numbers without deleting history.
2. Choose additive account/code mapping storage and template upgrade behavior.
3. Confirm primary Division 156/99 and adjustment-note requirements; specify price-change and
   cancellation journals, including cash-basis tracking and repeated payments.
4. Record a canonical accounting ADR and fresh golden IDs, then split implementation/tests.

Additional implementation issue: the canonical BAS API accepts either basis for the same ledger.
Source R3 posts full GST up front and clears the unbilled asset without tax on the final invoice.
Simply excluding GST-UB on cash reports would lose later cash GST on the final settlement. Resolve
basis-specific attribution metadata or an explicit report-basis policy before implementation;
test the second receipt, not just the initial 3,300.00. Do not approve the complete lifecycle while
this is unresolved. The existing unknown-total receipt category also needs its own authority;
do not silently treat unknown totals as qualifying Division 156 supplies.

Confidence: high for the inspected section 29-5 and code differences; incomplete for the complete
lifecycle and schema integration. Status stays open; this file does not authorize guessed code.
