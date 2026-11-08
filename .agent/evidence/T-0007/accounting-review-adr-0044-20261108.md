# Accounting review — ADR-0044 (GST tax determination matrix) and cards T-0121…T-0124 — 2026-11-08

> **Honesty statement.** This is an AI persona modelled on the knowledge and professional standards
> of an Australian Chartered Accountant / CPA who is also a registered tax agent. It is **not** a
> registered practitioner, holds no TPB registration, carries no professional indemnity insurance
> and cannot sign or lodge anything. The product owner chose this persona instead of paid external
> review (DL-0248). Its findings are the best available technical review, not professional advice.

Reviewer: accountant-reviewer (claude persona) · Branch `claude/incomplete-features-build-wivsco`
at a94aadf · Scope: `Docs/adr/0044-gst-tax-determination-matrix.md` (Proposed) and
`.agent/backlog/T-0121.md`…`T-0124.md`, checked against my ruling in
`.agent/evidence/T-0007/accounting-review-20261108.md` (DL-0280). Read-only. I edited nothing except
this report and decision-log entry DL-0285.

**Independence note.** The ADR implements my own earlier ruling. That earlier ruling is not
authority for itself, so I re-derived each rule from the GST Act structure rather than checking
the ADR only against my earlier text. Design §4.4 and §6.5 were also read, along with
`packages/modules/tax/templates/au-tax-codes.json`,
`packages/modules/products/templates/au-services-smb-profiles.json` and migration
`0031_tax_codes.sql`, so that the findings are implementable.

## Overall: **PASS WITH MAJORS** (0 BLOCKER · 7 MAJOR · 15 MINOR · 15 CONFIRMED)

The mechanism is right. The precedence is right. It decides by what is supplied first, then by
who and where the recipient is, then by facts a person confirms, and refuses otherwise. With the R7
seed as tabled, no sale reaches a GST-free or export code from a party attribute alone. Every gap
I found fails **safe** under the seed data or can be fixed by wording before the build. None of
them misstates the BAS as the ADR stands, so there is **no BLOCKER**, and DL-0282 permits
acceptance.

I still require the wording changes in *Required ADR wording changes* to be applied **before** the
acceptance line is written. The six ADR MAJORs (M1–M5, M7) are defects in the rules that
T-0122/T-0123 will test "as tabled". If the text is left as it is, the tests would lock in the
gaps. M6 is a card-traceability MAJOR. It does not affect the ADR, but it must be fixed before
T-0047/T-0048 are claimed.

### Source confirmation (2026-11-08)

Primary hosts are still blocked. `curl` returns `CONNECT tunnel failed, response 403` for
`www.legislation.gov.au`, `www.austlii.edu.au`, `www.ato.gov.au` and `law.ato.gov.au`. New
search extracts this session:

| Claim | Status |
|---|---|
| s 38-185: goods GST-free if the supplier exports them within 60 days of the earlier of receiving payment or issuing an invoice; for instalments, the clock runs from the final instalment; the ATO can extend the period; GSTR 2002/6 covers items 1–4A of s 38-185(1) | Corroborated by extract (ATO "Exports and GST", Nexia). Section text **unverified**. |
| s 38-190 item 2 contains a limb excluding "work physically performed on goods situated in Australia when the work is done" (and real property); s 38-190(3) "provided to another entity in Australia" proviso (GSTR 2005/6, GSTR 2025/1) | Corroborated by extract (ATO Pine Gap contractor guidance, GSTR 2005/6 draft, GSTR 2007/2 draft). Exact item wording, including how limb (b) interacts with the exclusions, is **unverified**. |
| BAS G2 = exports of goods only; exported services at G3 | **Unverified** (prior knowledge only; no extract found). |
| s 9-30(3): a supply that is both GST-free and input taxed is GST-free | **Unverified** (prior knowledge). |

---

## Findings

| Item | Verdict | Severity | Standard / law | Finding | Proposed change |
|---|---|---|---|---|---|
| R5 precedence order (explicit → product-inherent → cell → refuse) | Confirmed | CONFIRMED | GST Act s 9-5, Div 38, Div 40, s 9-30 | GST status is first a property of the thing supplied (Div 38 inherently GST-free, Div 40 input taxed). Only then do the recipient and place (s 38-190) or facts about the transaction (s 38-185) matter. Putting product-inherent classes ahead of the party cell, and refusing rather than guessing, is the correct order. An explicit line code first is acceptable **with** the audit controls in M3. | — |
| R6/R7: no party-only GST-free on the sale side | Confirmed (seed) | CONFIRMED | s 9-5, s 38-185, s 38-190 | Every R7 sale cell for a taxable product class has outcome `code GST` or `confirm` with `alt GST`. The party class `NON_RESIDENT_OFFSHORE` alone yields GST until a person confirms. This closes DL-0280 MAJOR 5. | — (but see M2: this holds only for the seed) |
| R3 wildcard semantics | Inconsistent | **MAJOR (M1)** | — (mechanism) | R3 allows `*` only on `product_tax_class`, but R7 uses `*` for the **party** class (`sale \| * \| AU_REAL_PROPERTY`). There is no specificity order when both columns can be wildcards. If a tenant row `NON_RESIDENT_OFFSHORE × *` (e.g. confirm EXS) beat `* × AU_REAL_PROPERTY`, services on Australian land could become GST-free (1A under-collected). The "at most one valid row" rule also needs restating for overlapping wildcard rows. | Wording W1: allow `*` on both columns; specificity is exact+exact > `*` party + exact product > exact party + `*` product > `*`+`*` (product exactness ranks first). Uniqueness is per literal key. |
| R9 is a seed property, not a system property; matrix governance | Gap | **MAJOR (M2)** | s 9-5; design §6.5 rule 5 (author ≠ activator for posting rules and tax codes) | `app.tax_determination` is tenant data, and nothing stops a sale-side `code` cell from returning FRE/EXP/EXS/INP/N-T for a taxable product class. Nothing forces a `confirm` cell's `alt_tax_code` to be taxable ("the safe, taxable code" is prose only). A tenant edit would reintroduce party-driven GST-free sales with no confirmation. The R9 property test would still pass because it runs against the seed. The ADR is also silent on design §6.5 rule 5: tax rules need author ≠ activator. | Wording W2 (R3 guard in DB + loader; codes must exist and be valid; created_by and activation by a different user, small-team mode per §6.5) and W9 (R9 property over arbitrary guarded matrices, and covering `input_taxed`/`bas_excluded` kinds on sales). T-0122 AC-1 adds the guard and maker-checker. |
| R5 step 1: explicit line-code bypass | Gap | **MAJOR (M3)** | s 38-185/38-190 (record of basis for GST-free claim); TAA 1953 s 382-5 / GST record-keeping (5 years) | (a) "Differs from the result of steps 2–4" is undefined when steps 2–4 return **no** code (`manual`, `NO_TAX_RULE`, `NO_TAX_CLASS`). An implementer can read that as "no reason needed", which gives an unrecorded path to FRE/EXP/EXS on an unclassified product or a manual cell. (b) An explicit `EXP`/`EXS` with only a free-text reason gives a weaker export record than the `confirm` path. A user could bypass the confirmation by typing the code. (c) It does not say whether codes copied from Salesforce (`LF_Tax_Code__c`, DL-0266), templates or defaults are "explicit". If they are, the Salesforce field becomes a back door. | Wording W3: an explicit code is user-entered only; a reason is required when the code differs **or when no code was determined**; explicit export codes also need the R4 confirmation for the matching key (`TAX_CONFIRMATION_REQUIRED`). Update R9(c). |
| R7 `s38-190` confirmation text | Too broad | **MAJOR (M4)** | s 38-190(1) item 2 (goods-work and real-property limb), s 38-190(3); GSTR 2025/1; ATO Pine Gap guidance (extract) | The condition omits the item 2 exclusion for **work physically performed on goods situated in Australia when the work is done**. A user who repairs, tests or installs equipment in Australia for an offshore non-resident could truthfully confirm the stated text, and the supply would go EXS when it is taxable, which under-collects 1A. A confirmation narrower than the law only over-collects. One broader than the law under-collects, so the text must be at least as narrow as the law. Item 2(b) (non-resident business not registered) and items 3/4 are legitimate extra routes. Leaving them out is conservative. | Wording W4: add the goods-work exclusion; state that item 2(b) and other routes are not automated (explicit code + reason + confirmation per W3). Also tighten the `s38-185` text (supplier exports; 60 days from the earlier of consideration or invoice; final instalment; ATO extension). |
| R4 record keeping for `confirm` outcomes | Incomplete | **MAJOR (M5)** | s 38-185 (60-day condition is satisfied **after** invoicing); GST record-keeping (5 years); AASB 108 / posted = immutable | (a) At invoice time, the s 38-185 condition is usually a forward-looking statement: the goods have not yet left. Nothing follows up if export does not occur within 60 days, or if evidence is never filed. The supply would then have been taxable, and the BAS stays understated. (b) R4 does not say the record is frozen at posting, append-only and retained for ≥ 5 years. (c) R4 does not store **which** determination row or condition text was confirmed. Condition text can change through new effective-dated rows. (d) Party and product `tax_class` are current-state columns, not effective-dated, so after a reclassification nothing shows why a past line got its code. The ADR's own Context says "nothing records why a code was chosen" and R4/R5 do not fully close that gap. | Wording W5: append-only confirmation frozen at posting, corrections by adjustment/credit note; store the determination row id and condition text; s 38-185 evidence may follow, but the tax report lists posted EXP lines without evidence and those past 60 days; a resolution trace on every line (deciding step, row id, party/product class, tax date); tax_class changes go to the audit log. |
| T-0047/T-0048 do not carry DL-0280 MAJORs 1 and 2 | Not carried | **MAJOR (M6)** | s 29-5(1), Div 156, Div 99; AASB 9 ¶5.5.15 / ¶5.4.4 (para refs unverified) | T-0124 drafts GP-012-B/GP-015-B/GP-007-A. Its open question says the `gst_supply_pattern` classification and the `GST_ATTRIBUTED_UNBILLED` role go into "a small accounting ADR, or fold into T-0047's design". However, **T-0047 and T-0048 are unchanged**. No card owns (1) the classification, with a default and help text, stored on the deposit invoice or receipt; (2) the single-supply posting path; (3) showing the pattern on the BAS-prep report (my MAJOR 1 point 3, which is missing everywhere); or (4) the write-off against the ECL allowance and the `ar.ecl_provision` source. T-0047 can reach `done` treating every deposit as a Div 156 component, which is the very risk the MAJOR names (1A understated by 700 in the GP-012 example). The goldens would sit PENDING indefinitely. | Add ACs to T-0047: classification, GP-012-B/GP-015-B green (not PENDING), BAS-prep display. Until the single-supply path exists, a deposit classified `single_supply` must be refused rather than posted as Div 156. Add an AC to T-0048: GP-007-A green. Make the separate accounting decision (ADR or DL under DL-0282) a gate on T-0047. Keep T-0099's MVP gate dependent on both. |
| R5 step 3 tax date; adjustments | Undefined | **MAJOR (M7)** | s 29-20, Div 19, s 29-75 (adjustments follow the original supply); BAS 1A/1B consistency | "Document tax date" is not defined. More importantly, nothing says a credit note, adjustment note or reversal must take the **original** line's code and confirmation instead of re-resolving. Example: an export invoice is EXP, then a cell change or reclassification occurs, and the credit note re-resolves to GST. The result is a decreasing adjustment of GST that was never charged (1A/1B misstated, and G1/G2 inconsistent). The ADR also does not require the returned code to be valid on the tax date. | Wording W6: define the tax date; adjustments inherit the original line's code, confirmation and trace; posted lines are never re-resolved; drafts are re-resolved at posting, with any change shown; the returned code must be valid on the tax date, or `NO_TAX_RULE`. |
| R6 text vs the R7 purchase cell | Wording | MINOR | — | R6 says a party class "never yields FRE". R7 then has a party-only `DOMESTIC_UNREGISTERED × * → FRE`. The paragraph after R7 explains the cell, but R6 as written is contradicted, and a literal test of R6 would fail on the seed. | Wording W7: put the direction qualifier and the single purchase-side exception into R6 itself. |
| R7 "EXS (FRE until T-0121 ships EXS)" | Wording | MINOR | — | T-0122 `depends_on` T-0121, so EXS always exists when the seed loads. The conditional makes T-0122 AC-4 ("as tabled") ambiguous. | Wording W8: "EXS". |
| `AU_REAL_PROPERTY` class definition | Underdefined | MINOR | Div 40 Subdiv 40-B/40-C (residential), s 38-325 (going concern), s 38-480 (farmland), Div 75 (margin scheme) | `* × AU_REAL_PROPERTY → GST` is right for services directly connected with Australian land and for taxable sales of commercial or new residential premises. It is wrong for sales or leases of existing residential premises (input taxed), and for going concerns, farmland or margin-scheme sales. A tenant can classify "residential rent" as `AU_REAL_PROPERTY` and get GST. That over-collects, so it is conservative, but it is a wrong label. No purchase cell exists: a registered supplier × `AU_REAL_PROPERTY` gives `NO_TAX_RULE`, which is safe. | Wizard/help text: existing residential → `INPUT_TAXED`; going concern / farmland / margin scheme → explicit code. Add purchase `DOMESTIC_REGISTERED × AU_REAL_PROPERTY → GST` in a later seed row. |
| `GST_FREE_INHERENT` as a product class | Note | MINOR | Div 38 Subdivs 38-A (food), 38-B (health), 38-C (education) | Classifying a product as inherently GST-free asserts that **every** sale of it meets the Subdivision's conditions (e.g. a recognised professional for health, an accredited course for education). Where the conditions vary by sale, the product should be `TAXABLE_*`, with an explicit code + reason on qualifying sales. | Help text in the wizard (T-0080) and in the product UI. |
| INPUT_TAXED supplies to non-residents | Conservative | MINOR | s 9-30(3) (GST-free prevails over input taxed; unverified), s 38-190 | Step 2 makes `INPUT_TAXED` → INP regardless of party. A financial supply to an offshore non-resident may be GST-free instead. INP (G4) instead of FRE/EXS (G3) does not under-collect 1A. It costs the tenant input-tax credits and changes labels. | Note only. The override path is explicit code + reason + confirmation (W3). |
| Exported goods that are inherently GST-free, or sold to a DOMESTIC buyer and exported by the supplier | Conservative | MINOR | s 38-185 (the recipient need not be non-resident); BAS G2 vs G3 (unverified) | Inherently GST-free goods exported resolve to FRE (G3, not G2). `DOMESTIC × TAXABLE_GOODS` exported by the supplier resolves to GST, which over-collects. Both are safe. | Note only. The explicit EXP path with confirmation (W3) handles both. |
| Seed gaps (friction, safe) | Incomplete | MINOR | s 9-5 (disposal of capital assets is taxable); s 13-5 / IMP (import GST on the customs entry); s 38-355 (international transport) | (a) No sale cell for `CAPITAL_EQUIPMENT` (asset disposal → should be GST). (b) No purchase cell for `OVERSEAS × TAXABLE_GOODS / CAPITAL_EQUIPMENT`: the supplier invoice carries no GST, and import GST goes through IMP on the customs/ICS entry. (c) FREIGHT on an export of goods follows s 38-355, not the s 38-190 test. Each one refuses (`NO_TAX_RULE`) or uses the services confirmation, which is safe. | Later seed rows: `sale DOMESTIC × CAPITAL_EQUIPMENT → GST`; `purchase OVERSEAS × TAXABLE_GOODS/CAPITAL_EQUIPMENT → manual` with help text; T-0122 should classify FREIGHT deliberately and log the choice. |
| `DOMESTIC_UNREGISTERED × * → FRE` capital purchases | Label | MINOR | BAS G10/G11/G14 | A capital purchase with no GST in the price coded FRE loses the G10/G11 split unless T-0035 maps by account subtype. Net GST is unaffected. | T-0035: map no-GST purchases to G10 or G11 by account subtype (fixed asset → G10), plus G14. |
| Overseas supplier `manual` cell | Help text | MINOR | Div 84; standard vs simplified GST registration | An overseas supplier with **standard** GST registration that issues tax invoices belongs in `DOMESTIC_REGISTERED`. One under the simplified (offshore) regime should not charge a registered business, and its invoices carry no creditable GST. | Wizard help text on supplier classification. |
| Retrospective matrix rows | Control | MINOR | AASB 108 (corrections not by altering records) | A new row with `valid_from` in the past changes how drafts dated in a lodged period resolve. | Require a reason for back-dated rows. Lines in a lodged or locked period are never re-resolved (W6). |
| Gap check (design §4.4) | Incomplete | MINOR | — | The design's wizard and nightly gap check covers account slots only. Party-class × product-class combinations that can occur but have no cell should be listed too. | T-0122/T-0080 note. |
| Who may confirm | Control | MINOR | Record keeping, SoD | R4 stores `confirmed_by` but does not say who may confirm. | A distinct permission under the RBAC model (no maker-checker needed per line). |
| Design §4.4 says the party profile "decides … default tax code" | Doc drift | MINOR | — | ADR-0044 R6 deprecates this. The design text is now out of date. | Design change-log note when ADR-0044 is accepted (owner-owned document). |
| T-0122 AC-1 column rules | Incomplete | MINOR | — | It checks `confirm` and `manual` columns, but not that a `code` cell has a `tax_code` and a null `alt_tax_code`/`confirmation_key`. | Add to AC-1, together with the W2 guard. |
| Per-line confirmation friction | Usability | MINOR | — | A 30-line export invoice needs 30 confirmations. | Allow one document-level confirmation that is stored per line (same record, same key). |
| Exports: EXP → G1+G2; EXS/FRE → G1+G3 (R8, T-0121) | Confirmed (unverified source) | CONFIRMED | ATO BAS instructions (prior knowledge) | Matches my DL-0280 MAJOR 6 fix. | Re-check G2 = goods only when ato.gov.au is reachable. |
| R7 `NON_RESIDENT_OFFSHORE × TAXABLE_GOODS → confirm EXP / alt GST` | Confirmed | CONFIRMED | s 38-185 item 1 (60 days, corroborated by extract) | Right outcome and safe fallback. Condition text is tightened in W4. | W4 |
| R7 `NON_RESIDENT_OFFSHORE × TAXABLE_SERVICE / TAXABLE_DIGITAL → confirm EXS / alt GST` | Confirmed with M4 | CONFIRMED | s 38-190 item 2, s 38-190(3), GSTR 2025/1 | Right outcome and safe fallback once the condition text is complete. | W4 |
| R7 `DOMESTIC × TAXABLE_* → GST`; `* × AU_REAL_PROPERTY → GST` | Confirmed | CONFIRMED | s 9-5, s 9-70; s 38-190 item 2 (real property limb) | Correct. AU real-property services to non-residents are not GST-free. | — |
| R7 purchases: `DOMESTIC_REGISTERED × TAXABLE_* → GST`, `× CAPITAL_EQUIPMENT → CAP`, `DOMESTIC_UNREGISTERED × * → FRE`, `OVERSEAS × services/digital → manual` | Confirmed | CONFIRMED | s 11-5, s 29-10 (tax invoice before claiming), Div 84 | CAP gives G10 (closes DL-0280 MAJOR 3 on the determination side). An unregistered supplier's price has no GST and gives no credit. That cell is party-driven but cannot under-collect: the risk falls on the tenant, not the revenue. Reverse charge is correctly left manual. | — |
| Step 2: `INPUT_TAXED → INP`, `BAS_EXCLUDED → N-T` | Confirmed | CONFIRMED | Div 40; BAS-excluded items | Correct for both directions. Purchase INP → G11 + G14 (T-0121), sales INP → G4. | — |
| `confirm` without confirmation → `alt` (GST) | Confirmed | CONFIRMED | Conservative tax position (TPB Code: reasonable care) | Falling back to the taxable code only over-collects, and it can be corrected by an adjustment note. | — |
| Effective dating by close-and-insert, no in-place update | Confirmed | CONFIRMED | AASB 108; migration 0031 pattern | Same rule as `app.tax_code`. History is preserved. | W6 for tax-date and adjustment semantics. |
| Option analysis (1, 2, 4 rejected) | Confirmed | CONFIRMED | — | Fixed precedence is wrong for whole classes of supply (as stated). The external engine is out of MVP scope. | — |
| Deprecate `default_tax_code` (comment, readable one version, no drop) | Confirmed | CONFIRMED | ADR-0014 | Additive and consistent with the no-delete rule. | — |
| T-0121 carries DL-0280 MAJORs 3 (CAP), 4 (HARDWARE/EQUIPMENT/4140), 5 interim (no OVERSEAS FRE default), 6 (EXP/EXS), the 1290 part of MAJOR 2, and MINORs INP→G11+G14 and BAS-W1/W2 | Faithful | CONFIRMED | — | Matches my proposals line for line. AC-5 proves the interim fix. Template v1 is kept. | — |
| T-0122 / T-0123 carry R1–R9 | Faithful (subject to M1–M5, M7) | CONFIRMED | — | Precedence, refusals, alt fallback, the R9 property, superseding the T-0039 tests without `.skip`, and the gate on ADR acceptance all match. They need the additions under *Card changes* below. | See below. |
| T-0124 figures (GP-007-A, GP-012-B, GP-015-B) | Faithful | CONFIRMED | — | Re-derived: GP-012-B 4,000.00 = 4,000.00; GP-015-B 10,700.00 = 10,700.00; GP-007-A A2 1,375.00 = 1,375.00. No Approved entry is edited. | Build ownership: M6. |

---

## Required ADR wording changes (apply before the acceptance line is written)

**W1 — R3, wildcard and specificity (M1).** Replace "`party_tax_class`, `product_tax_class`
(a class or `*` for any)" with:

> `party_tax_class` and `product_tax_class` (each a class or `*` for any)

and replace the bullet "At most one row is valid … An exact product class beats `*`." with:

> At most one row is valid for a given literal key (company, direction, party class, product class)
> on a date. When several rows match a line, the most specific wins, in this order: exact party and
> exact product; `*` party and exact product; exact party and `*` product; `*` and `*`. Product
> exactness ranks above party exactness because what is supplied decides GST status first.

**W2 — R3, guard and governance (M2).** Add bullets:

> - Guard, enforced by the database and by the template loader (not only by the seed): on direction
>   `sale`, a `code` cell's `tax_code` and a `confirm` cell's `alt_tax_code` must be a code of kind
>   `taxable`; a `confirm` cell's `tax_code` may be of kind `gst_free`. A `code` cell has null
>   `alt_tax_code` and `confirmation_key`. Every referenced code must exist for the company and be
>   valid on the row's `valid_from`.
> - A new or replacing row records `created_by` and takes effect only when activated by a
>   different user (design §6.5 rule 5, author ≠ activator; small-team mode as in §6.5).

**W3 — R5 step 1, explicit line code (M3).** Replace step 1 with:

> 1. **Explicit line code.** An explicit line code is one a user enters on the line; codes copied
>    from Salesforce, templates, or product or party defaults are not explicit. The line must carry
>    an override reason when the explicit code differs from the result of steps 2–4 **or when steps
>    2–4 produce no code** (`manual`, `NO_TAX_RULE`, `NO_TAX_CLASS`); a missing reason is refused
>    `TAX_OVERRIDE_REASON_REQUIRED`. An explicit export code (`EXP`, `EXS`) also needs the R4
>    confirmation record for the matching key (`s38-185`, `s38-190`); without it the line is refused
>    `TAX_CONFIRMATION_REQUIRED`.

and in R9 replace "(c) it is an explicit line code with an override reason when it differs from
the determination" with:

> (c) it is an explicit line code with an override reason (required when it differs from the
> determination or no code was determined) and, for an export code, an R4 confirmation

**W4 — R7 condition texts (M4).** Replace the `s38-190` condition (both rows) with:

> `s38-190`: the recipient is a non-resident who is not in Australia when the thing supplied is
> done; the supply is not work physically performed on goods situated in Australia when the work
> is done and is not directly connected with real property situated in Australia; and the supply is
> not provided, and not required to be provided, to another entity in Australia (s 38-190(3),
> GSTR 2025/1). Other s 38-190 routes (e.g. item 2(b), item 3) are not automated: use an explicit
> code with a reason and this confirmation.

and the `s38-185` condition with:

> `s38-185`: the supplier exports the goods from Australia within 60 days after the earlier of
> receiving any consideration or issuing an invoice (for instalments, the final instalment or its
> invoice), or within a period the ATO allows; export evidence is or will be held (see R4).

**W5 — R4, record keeping (M5).** Append to R4:

> The confirmation record is append-only. It can be added or withdrawn while the document is a
> draft and is frozen when the document posts; a later change is made only by an adjustment note or
> credit note and, if needed, a new document (posted = immutable). It is retained with the
> document for at least five years. It stores the `app.tax_determination` row id and the condition
> text as confirmed. For `s38-185` the evidence reference may be blank at confirmation; the tax
> report lists every posted `EXP` line that has no evidence reference, flagging those whose 60-day
> period has passed, so that the user records the evidence or corrects the supply. Confirming
> requires a distinct permission.
>
> Every resolved document line also stores its resolution trace: the deciding step (explicit,
> product-inherent, cell, refusal), the `app.tax_determination` row id if any, the party and product
> tax classes used, and the tax date. Changes to a party's or product's `tax_class` are written to
> the audit log; the classes are not effective-dated, so the trace is the historical record.

**W6 — R5 step 3, tax date and adjustments (M7).** Add after step 4:

> The document tax date is the document date (invoice date, supplier bill date, or the receipt
> date of an uninvoiced receipt). The returned code must be valid on that date, else
> `NO_TAX_RULE`. A credit note, adjustment note or reversal never re-resolves: each of its lines
> takes the tax code, confirmation and trace of the line it adjusts. A posted line is never
> re-resolved. A draft is re-resolved at posting and any changed result is shown to the user
> before posting. A matrix row with `valid_from` earlier than its creation date needs a reason.

**W7 — R6 (MINOR).** Replace the first sentence of R6 with:

> On direction `sale`, a party tax class or a party default alone never yields `FRE`, `EXP`, `EXS`
> or any other GST-free, export, input-taxed or BAS-excluded code. On direction `purchase`, the
> only party-driven non-taxable cell is `DOMESTIC_UNREGISTERED` × `*` (R7), which records that the
> price contains no GST.

**W8 — R7 (MINOR).** In the two service/digital rows replace "EXS (FRE until T-0121 ships EXS)" and
"EXS (FRE until EXS ships)" with "EXS" (T-0122 depends on T-0121).

**W9 — R9 (M2).** Append to R9:

> On direction `sale` the same rule applies to codes of kind `input_taxed` and `bas_excluded`, with
> (a) read as `INPUT_TAXED` or `BAS_EXCLUDED`. The property test generates arbitrary matrices that
> satisfy the R3 guard, not only the R7 seed.

Also update the Compliance table row for R9 and R3 to name the guard and the arbitrary-matrix
generator.

## Card changes (no ADR wording; for the architect)

- **T-0122 AC-1:** add the W1 specificity, the W2 guard (kinds, `code` cell nulls, code exists and
  is valid) and the author ≠ activator activation; add tax-class pairs without a cell to the §4.4
  gap check; classify FREIGHT deliberately and log it.
- **T-0123:** add `TAX_CONFIRMATION_REQUIRED`; "no code determined → reason required"; the
  resolution trace (W5); adjustments inherit the original line (W6); arbitrary-matrix property (W9).
  The EXP-without-evidence / 60-day list belongs to T-0035's tax report. Add it there as an AC,
  or as a new card via `new-task-card`.
- **T-0047 / T-0048 (M6):** see the M6 row. Until `single_supply` is built, a deposit classified
  `single_supply` must be refused, never posted as Div 156.

## Proposed superseding entries

None. This review covers an ADR and cards, and does not cover journals. The T-0124 figures were
re-derived and balance (see the findings table).

## Items to re-check when primary sources are reachable

Allow `www.ato.gov.au`, `law.ato.gov.au`, `www.legislation.gov.au` and `www.austlii.edu.au`, then
check:

1. s 38-190(1) item 2 exact wording: the goods-work and real-property limbs, and whether limb (b)
   removes either exclusion. Also s 38-190(3), GSTR 2025/1 (final status) and GSTR 2005/6.
2. s 38-185(1) items 1–4A and GSTR 2002/6: who must export, the 60-day trigger, the instalment
   rule, extensions and acceptable export evidence.
3. ATO BAS instructions: G2 = goods only; where international freight and insurance on exports
   go; G10/G11/G14 for no-GST purchases.
4. s 9-30(3) priority of GST-free over input taxed.
5. Carried over from DL-0280: re-check list items 1–7 of `accounting-review-20261108.md`.

## Sources (search extracts, 2026-11-08; primary pages not opened)

- [ATO — Exports and GST](https://www.ato.gov.au/Business/International-tax-for-business/Australians-doing-business-overseas/Exports-and-GST/)
- [ATO — GST obligations for Pine Gap contractors](https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/in-detail/rules-for-specific-transactions/gst-obligations-for-pine-gap-contractors)
- [ATO — GSTR 2005/6 draft (s 38-190(3))](https://www.ato.gov.au/law/view/pdf/pbr/gstr2005-006dc1.pdf)
- [ATO — GSTR 2007/2 draft (s 38-190 items 2 and 3)](https://ato.gov.au/law/view/pdf/pbr/gstr2007-002dc1.pdf)
- [ATO — GSTR 2025/CP001](https://www.ato.gov.au/law/view/pdf/pbr/gstr2025-cp001.pdf)
- [Nexia — GST and Exports](https://nexia.com.au/node/857) (secondary)
- [vatupdate — GSTR 2025/1 summary](https://www.vatupdate.com/2025/07/23/gst-ruling-on-supplies-to-non-residents-provided-to-another-entity-in-australia) (secondary, from DL-0280)
