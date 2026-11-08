---
adr: 0044
title: "GST tax determination: party and product tax classes, an effective-dated determination matrix with code/confirm/manual outcomes, product-inherent classes first, no party-only GST-free default"
status: Accepted            # Proposed | Accepted | Rejected | Superseded by ADR-NNNN
date: 2026-11-08
author: claude
category: accounting
human_gate: yes             # accounting; accepted by claude under DL-0282 after accountant-reviewer persona re-review DL-0285 (no BLOCKER)
supersedes: none            # no earlier ADR; it supersedes the TAX_CODE_CONFLICT-only rule of DL-0260 (3) (decision-log entry, not an ADR)
superseded_by: none
---

# ADR-0044: GST tax determination by party tax class × product tax class

## Status

Accepted by claude under product-owner delegation (DL-0282) after accountant-reviewer persona re-review DL-0285 found no BLOCKER; W1–W9 applied; 2026-11-08

Re-review evidence: `.agent/evidence/T-0007/accounting-review-adr-0044-20261108.md`.

History: Proposed — human gate `accounting` (AGENTS.md §6). Under the owner's extended delegation
**DL-0282**, claude may accept this ADR **only after** the accountant-reviewer persona (DL-0248)
has re-reviewed this file and found no BLOCKER; the acceptance line must then read
"Accepted <date> by claude under owner delegation DL-0282 after persona re-review <evidence path>".
Until then no task that depends on it (T-0122, T-0123) may reach `done`.

## Context and problem statement

T-0039 resolves a document line's tax code as: explicit line code → the party-profile default or
the product default when only one is set or both are equal → refuse `TAX_CODE_CONFLICT` (both set
and different) or `NO_TAX_CODE` (DL-0260 (3), RQ-0097). DL-0260 left the precedence between
differing defaults open for the human/accountant.

The accountant-reviewer persona review of 2026-11-08
(`.agent/evidence/T-0007/accounting-review-20261108.md`, DL-0280) ruled:

- Keeping the refusal is **safe** (it never guesses) but **not sufficient**:
  (a) the "only one default set → use it" shortcut lets a party-only GST-free code through.
  With the shipped template, any product with no tax code of its own that is sold to an
  `OVERSEAS_CUSTOMER` becomes FRE silently, including services enjoyed in Australia, goods
  delivered in Australia and work on Australian real property. That under-collects 1A (MAJOR).
  (b) It forces manual coding of every overseas sale where defaults differ.
- A supply's GST status depends on **what** is supplied (Div 38 inherently GST-free; Div 40 input
  taxed; goods vs services vs Australian real property), on **who and where** the recipient is
  (s 38-190 items 2 and 3, the s 38-190(3) limit, GSTR 2025/1), and on **facts about the
  transaction** that only a person can confirm (s 38-185 goods exported within 60 days, with
  evidence).
- The single `FRE` code cannot separate exports of goods (BAS G2) from other GST-free sales (G3)
  (MAJOR; the template change is T-0121).

Neither "party wins" nor "product wins" is correct under the GST Act. This changes a tax treatment
and the data model, so design §10.6 requires an ADR, and AGENTS.md §6 puts it behind the human gate.

Source caveat: the persona could not open primary hosts (ato.gov.au, legislation.gov.au). The
s 38-185/38-190 wording and "G2 = goods only" are from search extracts and prior knowledge, and
are listed as unverified in the review's re-check list. This ADR fixes the **mechanism**: classes,
matrix, confirmations and precedence. The individual seed cells are template data and can be
corrected later by a new effective-dated row without another ADR.

## Decision drivers

- Never make a supply GST-free (or export) by guess. A party attribute alone cannot establish
  GST-free status (s 9-5, Div 38).
- Record keeping: a GST-free export claim needs a stored, attributable confirmation and an
  evidence reference (5-year retention).
- Data, not code (design principle 3): treatments are template rows, effective-dated, changeable
  without a release.
- Forward-only, additive migrations (ADR-0014): nothing is dropped or renamed. `default_tax_code`
  is deprecated, not removed.
- Reuse the T-0039 pure-resolver and refusal plumbing (DL-0261). The fast-check property style
  carries over.
- Keep common domestic sales zero-touch (`DOMESTIC` × `TAXABLE_*` → GST with no prompt).

## Considered options

1. **Keep DL-0260 as is** — refuse on conflict; single default wins.
2. **Fixed precedence** — party default wins, or product default wins.
3. **Determination matrix with confirmations** (party tax class × product tax class × direction,
   effective-dated, `code | confirm | manual` outcomes, product-inherent classes first). This is
   the reviewer's recommendation.
4. **External tax engine** (Avalara-style rules service).

### Option 1 — Keep DL-0260

- Good, because it is built and tested (T-0039) and never picks between two different codes.
- Bad, because the single-default shortcut lets a party-only FRE through (MAJOR above).
- Bad, because every overseas sale with differing defaults needs manual coding, and nothing
  records why a code was chosen.

### Option 2 — Fixed precedence

- Good, because it is trivial.
- Bad, because "party wins" taxes GST-free food or health supplies sold to a domestic customer
  wrongly, and "product wins" taxes exports. Each is wrong for a whole class of supplies.

### Option 3 — Determination matrix with confirmations

- Good, because GST status comes from both what is supplied and who the recipient is, as the
  Act requires, and conditions only a person can know become explicit confirmations with a trail.
- Good, because it is data: effective-dated rows that can be corrected without a code release.
- Good, because it reuses the T-0039 resolver structure and refusal codes.
- Bad, because it needs two new columns, one new tenant table and a document-line confirmation
  record (migration + RLS + cross-tenant tests).
- Bad, because tenants must classify parties and products. Template defaults and the wizard reduce
  that work, and an unclassified product refuses safely.

### Option 4 — External tax engine

- Good, because others maintain the rules.
- Bad, because it adds a new runtime dependency and an external integration for one country's
  GST, has a cost, and is out of MVP scope (design §7.1).

## Decision outcome

Chosen option: **Option 3**. It is the only option that never makes a supply GST-free without
either a product-inherent class or a stored confirmation, and it keeps treatments as data.

### Rules (checkable)

**R1 — Party tax class.** New column `app.party_posting_profile.tax_class text` (nullable on add,
backfilled from the template, then required for new rows by trigger).
- Customer classes: `DOMESTIC`, `NON_RESIDENT_OFFSHORE`.
- Supplier classes: `DOMESTIC_REGISTERED`, `DOMESTIC_UNREGISTERED`, `OVERSEAS`.
- A class must match `party_kind` (checked by constraint or trigger).
- `RELATED_PARTY` is **not** a tax class. If it is needed, it is a separate reporting tag.

**R2 — Product tax class.** New column `app.product_posting_profile.tax_class text` plus an
optional override `app.product.tax_class text` (the product override wins over its profile).
Values: `TAXABLE_SERVICE`, `TAXABLE_GOODS`, `TAXABLE_DIGITAL`, `AU_REAL_PROPERTY`,
`GST_FREE_INHERENT` (Div 38 food, health, education etc.), `INPUT_TAXED` (Div 40),
`CAPITAL_EQUIPMENT` (purchase side), `BAS_EXCLUDED`.

**R3 — Determination matrix.** New tenant-owned table `app.tax_determination`. It has `tenant_id`,
`company_id`, `direction` (`sale | purchase`), `party_tax_class` and `product_tax_class` (each a
class or `*` for any), `valid_from`, `valid_to` (nullable), `outcome` (`code | confirm | manual`),
`tax_code` (required for `code` and `confirm`; null for `manual`), `alt_tax_code` (required for
`confirm` only) and `confirmation_key` (required for `confirm` only, a stable key with a
human-readable condition text).
- RLS is `ENABLE` + `FORCE` and the table is in the cross-tenant suite.
- Rows are never updated in place for a treatment change. A change closes `valid_to` and inserts
  a new row (same effective-dating rule as `app.tax_code`, migration 0031).
- At most one row is valid for a given literal key (company, direction, party class, product class)
  on a date. When several rows match a line, the most specific wins, in this order: exact party and
  exact product; `*` party and exact product; exact party and `*` product; `*` and `*`. Product
  exactness ranks above party exactness because what is supplied decides GST status first.
- Guard, enforced by the database and by the template loader (not only by the seed): on direction
  `sale`, a `code` cell's `tax_code` and a `confirm` cell's `alt_tax_code` must be a code of kind
  `taxable`; a `confirm` cell's `tax_code` may be of kind `gst_free`. A `code` cell has null
  `alt_tax_code` and `confirmation_key`. Every referenced code must exist for the company and be
  valid on the row's `valid_from`.
- A new or replacing row records `created_by` and takes effect only when activated by a
  different user (design §6.5 rule 5, author ≠ activator; small-team mode as in §6.5).

**R4 — Line confirmation record.** A document line resolved through a `confirm` cell stores
`tax_confirmation_key`, `confirmed_by`, `confirmed_at` and `confirmation_evidence_ref` (free text),
or records that the condition was not confirmed. These are columns on the document line tables or
a line-confirmation table. The choice is made in T-0123 and is additive either way.

The confirmation record is append-only. It can be added or withdrawn while the document is a
draft and is frozen when the document posts; a later change is made only by an adjustment note or
credit note and, if needed, a new document (posted = immutable). It is retained with the
document for at least five years. It stores the `app.tax_determination` row id and the condition
text as confirmed. For `s38-185` the evidence reference may be blank at confirmation; the tax
report lists every posted `EXP` line that has no evidence reference, flagging those whose 60-day
period has passed, so that the user records the evidence or corrects the supply. Confirming
requires a distinct permission.

Every resolved document line also stores its resolution trace: the deciding step (explicit,
product-inherent, cell, refusal), the `app.tax_determination` row id if any, the party and product
tax classes used, and the tax date. Changes to a party's or product's `tax_class` are written to
the audit log; the classes are not effective-dated, so the trace is the historical record.

**R5 — Precedence** (the resolver evaluates in this order and stops at the first that applies):
1. **Explicit line code.** An explicit line code is one a user enters on the line; codes copied
   from Salesforce, templates, or product or party defaults are not explicit. The line must carry
   an override reason when the explicit code differs from the result of steps 2–4 **or when steps
   2–4 produce no code** (`manual`, `NO_TAX_RULE`, `NO_TAX_CLASS`); a missing reason is refused
   `TAX_OVERRIDE_REASON_REQUIRED`. An explicit export code (`EXP`, `EXS`) also needs the R4
   confirmation record for the matching key (`s38-185`, `s38-190`); without it the line is refused
   `TAX_CONFIRMATION_REQUIRED`.
2. **Product-inherent class** (party is irrelevant): `GST_FREE_INHERENT` → `FRE`, `INPUT_TAXED`
   → `INP`, `BAS_EXCLUDED` → `N-T`.
3. **Matrix cell** for (direction, party class, product class, document tax date):
   - `code` → that `tax_code`;
   - `confirm` → `tax_code` if the line has a stored confirmation for `confirmation_key`, else
     `alt_tax_code` (the safe, taxable code);
   - `manual` → refuse `TAX_CODE_REQUIRED` until the line carries an explicit code (step 1).
4. **No cell** → refuse `NO_TAX_RULE`, naming direction, party class, product class and date.
   An unclassified party or product refuses `NO_TAX_CLASS` (naming which).

The document tax date is the document date (invoice date, supplier bill date, or the receipt
date of an uninvoiced receipt). The returned code must be valid on that date, else
`NO_TAX_RULE`. A credit note, adjustment note or reversal never re-resolves: each of its lines
takes the tax code, confirmation and trace of the line it adjusts. A posted line is never
re-resolved. A draft is re-resolved at posting and any changed result is shown to the user
before posting. A matrix row with `valid_from` earlier than its creation date needs a reason.

**R6 — No party-only GST-free.** On direction `sale`, a party tax class or a party default alone
never yields `FRE`, `EXP`, `EXS` or any other GST-free, export, input-taxed or BAS-excluded code.
On direction `purchase`, the only party-driven non-taxable cell is `DOMESTIC_UNREGISTERED` × `*`
(R7), which records that the price contains no GST. `app.party_posting_profile.default_tax_code` is
**deprecated**: it gets a `COMMENT` saying so, it stays readable for one template version, and
the resolver no longer uses it for determination. Product-level default tax codes are likewise
superseded by the product tax class. The DL-0260 (3) steps "single/equal default" and
`TAX_CODE_CONFLICT` are **superseded** by R5. Their tests become `NO_TAX_RULE` / matrix tests and
are superseded, not deleted (ADR-0014).

**R7 — AU template seed** (company setup, effective from 2000-07-01 unless stated):

| Direction | Party class | Product class | Outcome | Code | Alt | Confirmation key / condition |
|---|---|---|---|---|---|---|
| sale | DOMESTIC | TAXABLE_SERVICE / TAXABLE_GOODS / TAXABLE_DIGITAL | code | GST | — | — |
| sale | NON_RESIDENT_OFFSHORE | TAXABLE_SERVICE | confirm | EXS | GST | `s38-190`: the recipient is a non-resident who is not in Australia when the thing supplied is done; the supply is not work physically performed on goods situated in Australia when the work is done and is not directly connected with real property situated in Australia; and the supply is not provided, and not required to be provided, to another entity in Australia (s 38-190(3), GSTR 2025/1). Other s 38-190 routes (e.g. item 2(b), item 3) are not automated: use an explicit code with a reason and this confirmation. |
| sale | NON_RESIDENT_OFFSHORE | TAXABLE_DIGITAL | confirm | EXS | GST | `s38-190` (as above) |
| sale | NON_RESIDENT_OFFSHORE | TAXABLE_GOODS | confirm | EXP | GST | `s38-185`: the supplier exports the goods from Australia within 60 days after the earlier of receiving any consideration or issuing an invoice (for instalments, the final instalment or its invoice), or within a period the ATO allows; export evidence is or will be held (see R4). |
| sale | * | AU_REAL_PROPERTY | code | GST | — | — |
| purchase | DOMESTIC_REGISTERED | TAXABLE_SERVICE / TAXABLE_GOODS / TAXABLE_DIGITAL | code | GST | — | — |
| purchase | DOMESTIC_REGISTERED | CAPITAL_EQUIPMENT | code | CAP | — | — |
| purchase | DOMESTIC_UNREGISTERED | * | code | FRE (no GST in the price, no credit) | — | — |
| purchase | OVERSEAS | TAXABLE_SERVICE / TAXABLE_DIGITAL | manual | — | — | Div 84 reverse charge applies only to recipients who are not fully creditable. That is out of MVP scope and flagged in the wizard. |

The `DOMESTIC_UNREGISTERED` × `*` → FRE cell is a purchase-side code. It is allowed by R6 because
it records that the price contains no GST, not that a supply is GST-free.

**R8 — Codes.** `EXP` (GST-free export of goods, s 38-185, BAS G1 + G2) and optional `EXS`
(export of services, s 38-190, G1 + G3) are added as effective-dated rows by T-0121. `FRE`
remains G1 + G3.

**R9 — Invariant (property-tested).** For every resolution, a GST-free or export code is returned
only if (a) the product tax class is `GST_FREE_INHERENT`, or (b) a `confirm` cell matched and the
line holds a stored confirmation for its key, or (c) it is an explicit line code with an override
reason (required when it differs from the determination or no code was determined) and, for an
export code, an R4 confirmation, or (d) it is the purchase-side `DOMESTIC_UNREGISTERED` cell.

On direction `sale` the same rule applies to codes of kind `input_taxed` and `bas_excluded`, with
(a) read as `INPUT_TAXED` or `BAS_EXCLUDED`. The property test generates arbitrary matrices that
satisfy the R3 guard, not only the R7 seed.

## Consequences

### Good

- No GST-free or export treatment without a product-inherent class or a recorded confirmation.
  This closes the OVERSEAS_CUSTOMER MAJOR.
- Domestic sales and purchases stay zero-touch. Overseas sales get a single confirmation instead
  of manual coding.
- Treatments are effective-dated data: a corrected cell is a new row, not a release.
- The confirmation trail supports ATO record keeping for export claims.

### Bad / accepted trade-offs

- Tenants must classify parties and products. Unclassified items refuse (`NO_TAX_CLASS`) rather
  than guess, so first-run friction moves to the wizard's gap step.
- More schema: two columns, an optional product override, a table and line confirmations.
- Div 84 reverse charge and other edge cases (Div 38 sub-items, mixed supplies) are `manual`
  rather than automated.
- The T-0039 conflict tests are superseded. Their history stays, and the behaviour changes.

### Follow-ups

- **T-0121**: template v2 adds `EXP`/`EXS` and removes OVERSEAS_CUSTOMER's FRE default (the
  interim fix before this ADR is built). It also carries the other template corrections.
- **T-0122**: migration and template seed (R1–R3, R7), with RLS and cross-tenant coverage.
- **T-0123**: resolver precedence R5/R6, confirmation record R4, and property R9. It supersedes
  the T-0039 tax-code step.
- Separate decision, **not** part of this ADR: the deposit `gst_supply_pattern` classification and
  the `GST_ATTRIBUTED_UNBILLED` system role (GP-012-B/GP-015-B, card T-0124 and T-0047). They need
  their own accounting decision under DL-0282.
- Re-check the s 38-185/38-190 wording and the ATO "G2 = goods only" instruction once primary
  sources are reachable (review re-check list items 1 and 3). If they differ, correct the cells
  with new rows.

## Compliance and verification

| Check | Where | Gate |
|---|---|---|
| R9: no GST-free/export code (and, on sales, no input-taxed or BAS-excluded code) without an inherent class, a stored confirmation, an explicit override with reason (plus an R4 confirmation for EXP/EXS), or the unregistered-supplier cell; fast-check over **arbitrary matrices generated to satisfy the R3 guard**, not only the R7 seed | `packages/modules/products/src/tax-determination.prop.test.ts` (T-0123) | verify.sh unit gate |
| R5 precedence and every refusal (`NO_TAX_RULE`, `NO_TAX_CLASS`, `TAX_CODE_REQUIRED`, `TAX_OVERRIDE_REASON_REQUIRED`, `TAX_CONFIRMATION_REQUIRED`) named; tax date validity; adjustments inherit the original line's code, confirmation and trace | `packages/modules/products/src/tax-determination.test.ts` (T-0123) | verify.sh unit gate |
| R7 every seed cell resolves as tabled | `packages/modules/products/src/tax-determination.template.test.ts` (T-0122) | verify.sh unit gate |
| R3 table has RLS ENABLE + FORCE, cross-tenant isolation, one valid row per literal key and date, specificity order (exact/exact > `*`/exact > exact/`*` > `*`/`*`), effective-dating instead of in-place update; the **R3 guard** in the database and the template loader (sale `code` and `alt` codes of kind `taxable`, `code` cells with null `alt_tax_code`/`confirmation_key`, referenced codes exist and are valid on `valid_from`); author ≠ activator activation | `packages/modules/products/src/tax-determination.db.test.ts` + cross-tenant RLS suite (T-0122) | verify.sh db gate |
| R6 party-only FRE refused: OVERSEAS/NON_RESIDENT party × unclassified or taxable product never returns FRE without confirmation | `tax-determination.test.ts` (T-0123) | verify.sh unit gate |
| Migration is additive (no DROP/RENAME), `default_tax_code` marked deprecated | migration review + `migration` skill checks | verify.sh migration gate |

## Links

- Design: §3.6 (tax codes), §4.4 (posting profiles and matrix), §10.6 (ADR triggers)
- Research: RQ-0097 (posting-profile resolution precedence), RQ-0094 (GST rounding)
- Decision log: DL-0260 (superseded in part by this ADR, rule (3)), DL-0280 (persona review),
  DL-0282 (delegation), DL-0283 (triage of the review majors), DL-0285 (re-review), DL-0286
  (acceptance)
- Related ADRs: ADR-0014 (no-delete, forward-only migrations), ADR-0035 (subledger)
- Review: `.agent/evidence/T-0007/accounting-review-20261108.md`, section "Tax-code ruling and data design"
- Re-review (acceptance basis): `.agent/evidence/T-0007/accounting-review-adr-0044-20261108.md` (DL-0285);
  acceptance DL-0286
- External sources (search extracts, 2026-11-08; primary pages not opened): ATO "Exports and GST"
  https://www.ato.gov.au/businesses-and-organisations/international-tax-for-business/australians-doing-business-overseas/exports-and-gst ;
  GSTR 2025/1 summary https://www.vatupdate.com/2025/07/23/gst-ruling-on-supplies-to-non-residents-provided-to-another-entity-in-australia
