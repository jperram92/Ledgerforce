---
id: RQ-0133
title: Reconcile gross ECL allowance and later GST-related release
status: resolved
opened: 2026-11-10
resolved: 2026-11-10
opened_by: codex
linked_tasks: [T-0166]
linked_adrs: [ADR-0051]
superseded_by:
---

# RQ-0133 — Gross ECL allowance reconciliation

## Question

How should the source GP-007-A gross allowance and subsequent release coexist with canonical GP-024/025 and the existing write-off service?

## Sources consulted

- AASB Interpretation 1031, paragraphs 8 and 24, opened 2026-11-10: https://standards.aasb.gov.au/int-1031-may-2019 . Receivables include GST.
- AASB 9 compilation February 2025, applying to annual periods beginning January–June 2026, opened 2026-11-10: https://standards.aasb.gov.au/sites/default/files/2026-03/AASB9_12-14_COMPfeb25_01-26.pdf . Paragraphs 5.5.8/5.5.15 address remeasurement through profit/loss and lifetime loss allowances for qualifying trade receivables. The example will use an annual reporting period starting 2026-01-01.
- Source 872c4fa: GP-007-A A1/A2/A4 uses 1,375.00 initial allowance, 1,250.00 write-off debit and 125.00 later release. A3 is an alternative, not an extra write-off of the same invoice.
- Canonical code: write-off.ts charges the net loss to the allowance up to its credit balance and attributes 125.00 GST; it does not release collective allowance automatically.
- GST Act compilation 96 (2026-01-01), primary PDF opened 2026-11-10: https://www.legislation.gov.au/C2004A00446/2026-01-01/2026-01-01/text/original/pdf/1 . Division 21 governs bad-debt adjustments for non-cash accounting. Source GSTR 2000/2 search extract agrees; direct ATO retrieval returned 403, so the Act is the primary source.

## Findings

Comparable system: [MYOB's official bad-debt workflow](https://www.myob.com/au/support/myob-business/sales/writing-off-bad-debts), opened 2026-11-10, supports an expense or provision account and distinguishes cash from accrual GST effects. Its customer-return/G1 presentation differs from canonical GST-ADJ/1B, so it corroborates the workflow distinction, not our exact BAS mapping or gross allowance measurement.

The write-off journal already agrees between the two lines; the difference is initial allowance measurement and explicit later remeasurement. Avoid changing the write-off into a gross debit plus a second GST refund. Do not automatically clear the company's allowance because it may cover other invoices.

## Conclusion

Adopt GP-038 as the canonical gross-allowance lifecycle for a 2026 calendar-year reporter, with a fully uncollectible GST-inclusive receivable, no customer recovery and no earlier GST adjustment. This is a scenario-specific accounting inference from gross receivable recognition, contractual cash shortfalls (AASB 9 B5.5.28), and separate statutory GST relief; it is not a rule that all receivables require a 100% allowance. Remeasure remaining allowance through impairment profit/loss (5.5.8). Preserve existing approved examples as history; supersede only their blanket ex-GST measurement wording by an additive note.

The existing write-off journal is retained. A later authorised allowance journal releases 125.00 only when the whole-portfolio assessment supports that release. No automatic company-wide allowance sweep is introduced. Source GP-007-A A3 is already covered by canonical GP-024's short-allowance variant.

## Confidence

High for primary-text principles and journal arithmetic; the treatment of separate GST relief is explicitly the scenario inference adopted in ADR-0051. Golden and real-DB tests must verify the exact lifecycle and BAS behavior.

## Follow-up

Single-supply GST-UB remains separate. No claim is made that this completes source T-0047, PDF or Salesforce work.
