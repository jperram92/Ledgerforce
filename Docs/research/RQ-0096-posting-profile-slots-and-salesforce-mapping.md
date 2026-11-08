---
id: RQ-0096
title: Which account slots do party and product posting profiles carry, and how do Salesforce Account.Type / Product2.Family values map to them?
status: answered
opened: 2026-11-08
resolved: 2026-11-08
opened_by: claude
linked_tasks: [T-0038, T-0039, T-0065]
linked_adrs: []
superseded_by:
---

# RQ-0096 — Posting-profile slots and the Salesforce mapping hooks

## Question

- **Q1.** Which accounts does a *party* posting profile decide and which does a *product* posting
  profile decide (design §4.4), and what account types may each slot hold?
- **Q2.** Is a party profile customer- or supplier-specific, given that one party can be both
  (design §4.2)?
- **Q3.** Which Salesforce values drive the mapping (design §4.4, §5 table row "Product2 +
  PricebookEntry → Product: Family → product profile"), and how must the mapping be stored so a
  custom field can replace the standard one?
- **Q4.** How does a product's optional default tax code (design §5 row "tax code field
  optional") relate to the effective-dated `app.tax_code` from T-0034?

## Why it matters

T-0038 creates the tables and the AU services SMB template seed; T-0039 resolves the
party × product matrix and runs the gap check; T-0065 imports Accounts and Products. A wrong
slot set or type rule would make T-0039's resolver or the golden keys
(`product:PROFESSIONAL_SERVICES.revenue`, `product:HARDWARE.asset`, party profile
`DOMESTIC_CUSTOMER` / `DOMESTIC_SUPPLIER` in `Docs/accounting/postings.md`) unresolvable.

## Sources consulted

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S1 | `Docs/solution-design/solution-design.md` §4.4, §4.2, §5 (Product2 row) | 2026-11-08 | primary (project spec) | Party profile (who) "decides the control account (AR/AP) and default tax code"; product profile (what) "decides revenue, expense, COGS and discount accounts"; matrix of overrides; "Salesforce Product2.Family (or a custom field) maps to product profile; Account.Type or a custom field maps to party profile"; gap check in wizard and nightly. Examples: Domestic customer, Overseas customer, Related party, Domestic supplier, Overseas supplier; Subscription, Professional services, Hardware, Reimbursable expense, Freight. |
| S2 | `Docs/accounting/postings.md` (Draft) header and reference chart | 2026-11-08 | primary (project, Draft) | Keys `product:<PROFILE>.<slot>` with slots `revenue` and `asset` (`HARDWARE.asset` = computer equipment); party profiles `DOMESTIC_CUSTOMER`, `DOMESTIC_SUPPLIER`. Tests must resolve accounts through these keys, never by code. |
| S3 | https://learn.microsoft.com/en-us/dynamics365/business-central/finance-setup-posting-groups | 2026-11-08 (fetch refused by the session egress proxy, 403; content from prior knowledge of the page, cited by design §2) | primary (vendor docs), not re-read | Business Central splits *customer/vendor posting groups* (receivables/payables control accounts) from *general business × general product posting groups* (sales, purchase, COGS, inventory adjustment, discount accounts) and VAT business × VAT product posting groups (tax). The design's "simplified BC matrix" folds these into two profiles. |
| S4 | https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_account.htm and `…/sforce_api_objects_product2.htm` | 2026-11-08 (fetch refused by the egress proxy, 403) | primary (vendor docs), not re-read | Account.Type is a picklist; standard values in a new org are Prospect, Customer - Direct, Customer - Channel, Channel Partner / Reseller, Installation Partner, Technology Partner, Other. Product2.Family is a picklist whose values are defined per org (a new org ships only "None"). Both are org-editable, so values are not fixed. |
| S5 | `packages/connectors/salesforce/fixtures/documented/pubsub-account-change-events.gen.mjs` (line 56) | 2026-11-08 | source code (documented fixture, RQ-0036) | A documented Account change event carries `Type: 'Customer - Direct'`, consistent with S4. |
| S6 | `packages/db/migrations/0031_tax_codes.sql`, `packages/modules/tax/src/tax-codes.ts` | 2026-11-08 | source code | Tax codes are versioned per (company, code, valid_from); `findTaxCode(company, code, on)` returns the version valid on a date. No single row identifies a code, so a foreign key to "the code" is impossible. |
| S7 | `packages/modules/gl/templates/au-services-smb.json` | 2026-11-08 | source code | The AU services chart has 4110 Professional services, 4120 Subscriptions, 4190 Recoverable costs income, 5000 Subcontractors, 6310 Hosting and cloud services, 1500 Office equipment (asset); no hardware-sales, COGS, inventory, freight or discount accounts. |

## Findings

1. Party profile slots: the **control account** (via the system roles AR_CONTROL / AP_CONTROL,
   which T-0018 binds once per company) and a **default tax code** (S1). Since the control
   account must be AR for a customer and AP for a supplier, and the golden file names
   `DOMESTIC_CUSTOMER` and `DOMESTIC_SUPPLIER` separately (S2), a party profile is
   **customer- or supplier-specific** (party_kind). A party that is both carries one profile per
   kind (Q2) — analogous to BC's separate customer and vendor posting groups (S3).
2. Product profile slots (S1, S2, S3): `revenue` (revenue type), `discount` (revenue or expense —
   a contra-revenue account is still type revenue, a "discounts given" expense is accepted),
   `expense` (expense), `cogs` (expense), `asset` (asset; capitalised purchases such as
   `HARDWARE.asset`). Every slot is optional: an empty slot is a *gap* that T-0039's gap check
   lists and the resolver refuses (PROFILE_GAP, SS-UC01-06); this is design §4.1 step 7
   ("fill any gaps the wizard flags").
3. A slot account must be active, postable and **not** a control account (control accounts are
   posted only by their subledger, design §3.2) — inference from §3.2, enforced in the database
   like the T-0018 role rules.
4. Salesforce values are org-defined picklists (S4, S5), and the design allows a custom field
   instead (S1). The mapping therefore stores `(object, field API name, value) → profile` as
   tenant data, matched exactly on the picklist API value. Overseas vs domestic cannot be read
   from the standard Account.Type values (inference): the template maps only the customer types.
5. A product default tax code must be stored as the **code** and resolved by date through
   `app.tax_code` (S6); the database can still refuse a code that has no version in the company.

## Conclusion / decision

- Party posting profile: `code`, `name`, `party_kind` (customer | supplier), `control_role`
  (AR_CONTROL for customers, AP_CONTROL for suppliers, foreign key to the company's system-role
  binding), optional `default_tax_code` (must exist in `app.tax_code` for the company).
  `app.party` gets `customer_posting_profile_id` and `supplier_posting_profile_id`.
- Product posting profile: five optional slots `revenue`, `discount`, `expense`, `cogs`, `asset`
  with the type rules of finding 2–3 in one IMMUTABLE SQL function mirrored in TypeScript (as
  T-0018 did for system roles).
- Product: name, optional code/description, optional profile, optional `default_tax_code`
  (resolved by date through `findTaxCode`), Salesforce Product2 Id (18-char) and the raw Family.
- `app.posting_profile_mapping (sf_object Account|Product2, sf_field, sf_value) → profile`.
- AU services SMB template: party profiles DOMESTIC_CUSTOMER (GST), OVERSEAS_CUSTOMER (FRE),
  DOMESTIC_SUPPLIER (GST); product profiles SUBSCRIPTION, PROFESSIONAL_SERVICES, HARDWARE,
  REIMBURSABLE_EXPENSE, FREIGHT mapped onto existing chart accounts only (S7); slots with no
  natural account in that chart stay empty for the wizard's gap step. Pending accountant review,
  like the chart itself.

## Confidence

`medium` — the slot model follows the project's own design and Draft golden keys (primary for
this project); the Salesforce picklist values and BC model could not be re-read today (egress
proxy refused the vendor sites). The build hedges: all Salesforce values are tenant data,
editable, exact-match; the template is data and pending accountant review.

## Follow-ups

- T-0065: re-read the Salesforce Object Reference for Account.Type / Product2.Family when the
  connector maps them (vendor fact, re-check).
- T-0039: resolver precedence (party profile tax code vs product tax code) and which slots are
  required per document type belong to the matrix resolution card.
- Accountant review of the template mappings rides with the chart template review (HANDOVER).

**Affects:** packages/db migration 0032, packages/modules/products, T-0039, T-0065
