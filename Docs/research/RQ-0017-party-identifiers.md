---
id: RQ-0017
title: Party identifiers — ABN checksum, Peppol participant ID for an ABN, Salesforce 15/18-character Ids
status: answered
opened: 2026-10-24
resolved: 2026-10-24
opened_by: claude
linked_tasks: [T-0036]
linked_adrs: []
---

# RQ-0017 — Party identifiers

## Question

1. Q1 — How is an Australian Business Number validated beyond "11 digits"?
2. Q2 — When a party's delivery preference is Peppol, what is its participant identifier?
3. Q3 — A Salesforce Account Id arrives as 15 (case-sensitive) or 18 (case-safe) characters.
   How do we store one canonical external Id?

## Why it matters

Design §4.2: Party carries ABN/tax ID, delivery preference "Peppol (ABN as participant ID)"
and "Salesforce Account Id (external ID)". A mistyped ABN on a tax invoice is a compliance
defect; a wrong Peppol ID misroutes an e-invoice; 15- vs 18-character Ids for the same
Account would create duplicate parties during sync (§5).

## Sources consulted

| # | Source | Accessed | Kind | What it says |
|---|---|---|---|---|
| S1 | https://abr.business.gov.au/Help/AbnFormat (ABR, "Format of the ABN"), via search result text; direct fetch failed with DNS in the sandbox | 2026-10-24 | primary | 9-digit identifier with 2 leading check digits; subtract 1 from the first digit; weights 10,1,3,5,7,9,11,13,15,17,19; sum mod 89 = 0; example 51 824 753 556 → 534 = 6 × 89 |
| S2 | https://en.wikipedia.org/wiki/Australian_Business_Number | 2026-10-24 | secondary | same algorithm |
| S3 | https://www.ato.gov.au/businesses-and-organisations/einvoicing/peppol/identifying-australian-entities-registered-on-the-peppol-network | 2026-10-24 | primary | ATO's own participant ID `iso6523-actorid-upis::0151:51824753556`; 0151 is the ICD for the ABN; most AU businesses use their ABN |
| S4 | https://www.tickstar.com/article/peppol-bis-iso6523-codes | 2026-10-24 | secondary | 0151 added to the Peppol code list in Nov 2019 |
| S5 | https://github.com/Carburetor/salesforce_id (README) and https://npmjs.com/package/sfid | 2026-10-24 | source code | 18-char suffix is a checksum of capitalisation; vector 003G000001SUbc4 → 003G000001SUbc4IAD |
| S6 | Experiment E1 (node, 2026-10-24) | 2026-10-24 | experiment | implemented both algorithms: S5's vector reproduced; S1's example ABN valid, the same ABN +1 invalid; `74625118903` (used in a T-0018 test company) invalid |

## Findings

1. ABN validity: subtract 1 from the first digit, weight the 11 digits by
   10,1,3,5,7,9,11,13,15,17,19, sum, valid iff the sum mod 89 is 0 (S1, S2; reproduced in E1).
2. Peppol participant ID for an Australian party identified by ABN: scheme `iso6523-actorid-upis`,
   ICD `0151`, value = the 11-digit ABN, written `0151:<ABN>` (S3, S4). Inference: Peppol
   delivery requires a valid ABN, unless another ICD is recorded (out of MVP scope).
3. Salesforce 18-char Id = 15-char Id + 3 characters. Each suffix character encodes, for one
   5-character chunk, a bit per uppercase letter (bit i for position i), mapped to
   `ABCDEFGHIJKLMNOPQRSTUVWXYZ012345` (S5; reproduced in E1). The 18-char form is unique
   case-insensitively; the 15-char form is not.
4. Side finding (E1): `app.company.abn` checks only `^[0-9]{11}$`; a test fixture uses an ABN
   that fails the checksum.

## Conclusion / decision

- Add `app.abn_is_valid(text)` (IMMUTABLE SQL) and a TypeScript twin; `app.party.abn` must
  pass it. Store ABNs as 11 digits without spaces; the service strips spaces.
- Delivery preference `peppol` requires a valid ABN. The participant ID is derived as
  `0151:<abn>`, not stored separately.
- Store `salesforce_account_id` only in 18-character form (CHECK `^[a-zA-Z0-9]{18}$`, unique
  per company). The service converts 15 → 18 with the S5 algorithm and rejects an 18-char Id
  whose suffix does not match its first 15 characters.
- Follow-up (new card): company ABN checksum and fixture correction. Not in T-0036's scope.

## Confidence

`high` for Q1 and Q3 (primary rule plus executed vectors); `high` for Q2 (ATO page).

## Follow-ups

- Card: validate `app.company.abn` with `app.abn_is_valid` (additive CHECK NOT VALID → validate)
  and fix the T-0018 test fixture ABN.
- Non-ABN Peppol schemes (NZBN 0088, GLN 0088 …) when a second market is chosen (§11.2).

**Affects:** T-0036, packages/modules (parties), Salesforce connector (T-0063+), Peppol (Phase 1).
