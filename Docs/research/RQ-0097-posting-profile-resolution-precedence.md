---
id: RQ-0097
title: In what order does the posting-profile matrix resolve an account and a tax code, and which combinations does the gap check list?
status: answered
opened: 2026-11-08
resolved: 2026-11-08
opened_by: claude
linked_tasks: [T-0039, T-0040, T-0069]
linked_adrs: []
superseded_by:
---

# RQ-0097 — Posting-profile resolution precedence and the gap-check scope

## Question

- **Q1.** For a company, party, product, direction (sale | purchase) and slot, in what order are
  the matrix override, the product profile slot and any party default consulted for the
  **account**?
- **Q2.** Which **tax code** wins when the party profile's default (e.g. OVERSEAS_CUSTOMER → FRE)
  and the product's default (e.g. a product coded GST) are both set and differ?
- **Q3.** Which party-profile × product-profile × slot combinations "could occur" (design §4.4)
  and therefore belong in the gap check?
- **Q4.** What does the resolver do when the party has no profile for the direction, the product
  has no profile, or a profile is archived?

## Why it matters

T-0039 builds the resolver and the gap check; T-0040 (invoice posting) and T-0069 (Closed Won
draft, SS-UC01-06) consume them. A wrong account order posts revenue to the wrong account; a
wrong tax-code rule charges or omits GST on a supply — a tax treatment, which agents may not
decide alone (AGENTS.md §6).

## Sources consulted

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S1 | `Docs/solution-design/solution-design.md` §4.4 | 2026-11-08 | primary (project spec) | Party profile "decides the control account (AR/AP) and default tax code"; product profile "decides revenue, expense, COGS and discount accounts"; "Matrix: party profile × product profile → account overrides only where they differ from the product default"; gap check "any combination that could occur but has no account is listed before it can block a posting". |
| S2 | same, §2 research summary (line 58) and §3 chart (line 68) | 2026-11-08 | primary (project spec) | BC's matrix "is the right model but needs guardrails … flags gaps before posting rather than at posting"; LedgerForce collapses BC's posting-group types into party profile, product profile, **tax code** and bank account. |
| S3 | same, §5 row "Product2 + PricebookEntry → Product: Family → product profile; tax code field optional" | 2026-11-08 | primary (project spec) | A product may carry its own tax code. Nothing says how it combines with the party default. |
| S4 | https://learn.microsoft.com/en-us/dynamics365/business-central/finance-setup-vat (VAT posting setup) | 2026-11-08 (vendor site not re-fetched; egress proxy refused vendor docs earlier today, RQ-0096 S3) | primary (vendor docs), from prior knowledge | BC decides VAT by the **combination** of VAT business posting group (customer/vendor) × VAT product posting group (item) in the VAT posting setup matrix — neither side alone "wins". |
| S5 | `Docs/research/RQ-0096-posting-profile-slots-and-salesforce-mapping.md`, migration `0032_products_posting_profiles.sql` | 2026-11-08 | source code / project research | Party profiles are customer- or supplier-specific; product profiles have five optional slots (revenue, discount, expense, cogs, asset); overrides keyed party profile × product profile × slot; an empty slot is a gap. Follow-up: "resolver precedence (party profile tax code vs product tax code) and which slots are required per document type belong to the matrix resolution card". |
| S6 | `Docs/accounting/postings.md` (Draft) GP-001, GP-008 | 2026-11-08 | primary (project, Draft) | Golden lines resolve revenue through `product:<PROFILE>.revenue`; the tax code appears per line (GST, GST-CAP), i.e. the line carries its own code. |
| S7 | GST Act 1999 s 38-190 (exports of services to non-residents GST-free) and Div 38 (GST-free food, health …) — ATO, https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/when-to-charge-gst-and-when-not-to | 2026-11-08 (from prior knowledge, not re-fetched) | primary (regulator), not re-read | A supply's GST status depends on **both** who/where the recipient is (export → GST-free) and what is supplied (e.g. basic food → GST-free). |

## Findings

1. **Account order (Q1)** is settled by the design (S1): the party profile decides only the
   control account, so it has no default for revenue/expense/COGS/discount/asset. Order:
   **override (party profile × product profile × slot) → product profile slot → gap**. The
   "party default" layer in the question does not exist for these slots.
2. **Tax code (Q2)** is not settled by the design (S1, S3). A fixed precedence is wrong either
   way (S7): "party wins" charges GST on a GST-free food product sold to a domestic customer;
   "product wins" charges GST on an export of a GST-coded service to an overseas customer. BC
   resolves it with a two-sided matrix (S4), which the design does not include. Choosing a
   precedence is a tax treatment → human/accountant gate.
3. Safe rule that decides no treatment: an explicit tax code on the document line always wins
   (S6 — golden lines carry their own code); otherwise, if only one default is set, or both are
   equal, use it; if both are set and differ, **refuse with TAX_CODE_CONFLICT** naming both codes
   so a person picks the line's code; if neither is set, refuse with NO_TAX_CODE. Nothing is ever
   silently taxed with a guess.
4. **Gap scope (Q3).** Direction follows the party profile kind: customer profiles are used on
   sales, supplier profiles on purchases (S5). Slots by direction: sale → revenue, discount,
   cogs (COGS is recognised on the sale); purchase → expense, asset. Which of those is needed
   depends on the document line (a hardware purchase uses asset, a subscription purchase uses
   expense), which the profiles do not know. So the gap check lists every active party profile ×
   active product profile × direction slot that cannot resolve, and lets the caller narrow the
   slots (the wizard can ask only for revenue and expense; period close for all).
5. **Missing links (Q4).** No profile for the party's direction, no product profile, or an
   archived profile are distinct refusals that name what is missing; they are not slot gaps,
   because the matrix cannot even be entered.

## Conclusion / decision

- Account: override → product slot → `PROFILE_GAP` error naming party profile, product profile,
  slot and direction.
- Tax code: line code → single/equal default → `TAX_CODE_CONFLICT` (both set, different) or
  `NO_TAX_CODE`. **Open for the human/accountant:** whether a fixed precedence or a tax matrix
  (BC-style) should replace the conflict refusal. Building the refusal does not decide it.
- Gap check: active profiles only; slots per direction as finding 4; optional slot filter;
  output sorted, with a sentence per gap.
- Party/product without a usable profile: `NO_PARTY_PROFILE`, `NO_PRODUCT_PROFILE`,
  `PROFILE_ARCHIVED`.

## Confidence

`medium` — account order is primary-sourced from the project design; the tax-code rule is a
deliberately non-deciding guard whose replacement is a human decision; vendor/regulator pages
could not be re-fetched today.

## Follow-ups

- Human/accountant: tax-code precedence or matrix (HANDOVER *Open questions for human*).
- Nightly scheduling of the gap check needs a worker scheduler (none exists yet): follow-up card.
- T-0069 attaches the PROFILE_GAP refusal to the Closed Won draft as a warning (SS-UC01-06 UI/flow part).

**Affects:** packages/modules/products (resolver, gap check), T-0040, T-0069
