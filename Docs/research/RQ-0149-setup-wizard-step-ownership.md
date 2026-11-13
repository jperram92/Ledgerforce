---
id: RQ-0149
title: Setup wizard — which module owns each step's state, what each validator checks, which steps may be skipped
status: answered
opened: 2026-11-13
resolved: 2026-11-13
opened_by: claude
linked_tasks: [T-0123, T-0157, T-0158]
linked_adrs: [ADR-0067]
superseded_by:
---

# RQ-0149 — Setup wizard step ownership, validators and skipping

## Question

T-0123 builds the persisted wizard of design §4.1 (ten steps, unlocked in order, each completed
only when a validator that reads the owning module's state passes).

- Q1. For each step 1–10, which module already persists the state the step sets up on the build
  line, and what exactly must be true for the step's validator to pass?
- Q2. Steps 3, 8 and 10 need settings no module persists yet (GST basis and BAS frequency;
  invoice branding, payment terms, payment methods; approval thresholds beyond the SoD
  settings). Which module owns each? The wizard must not.
- Q3. Which steps may be skipped (e.g. step 9 for a new business), by whom, and how is that
  recorded?
- Q4. What does the wizard itself persist, and what does "in progress" mean?
- Q5. Where does AC-6 (seed the default overdue-reminder schedule) hook in?

## Why it matters

Design §4.1 (steps), §4.4 (gap check in the wizard), §5 (Salesforce connection), §6.3
(provisioning runs the wizard), §6.4–6.5 (roles, SoD thresholds). If the wizard kept its own copy
of settings, the two copies would drift and a "complete" wizard could describe a company that
cannot post (the rule the card states: validators read module state and never duplicate it).

## Sources consulted

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S1 | `Docs/solution-design/solution-design.md` §4.1, §4.4, §5.2, §6.3–6.5 | 2026-11-13 | primary (design) | The ten steps; the gap check "runs in the wizard and nightly"; integration user per org; SoD thresholds are configurable settings |
| S2 | `packages/db/migrations/0001…0064`, `packages/db/src/schema.ts` | 2026-11-13 | source code | Tables that already hold each step's state (listed in Findings) |
| S3 | `packages/modules/products/src/matrix.ts` `profileGaps` | 2026-11-13 | source code | The T-0039 gap check: every active party × product profile combination without an account, with a message |
| S4 | `packages/modules/setup/src/opening-balances.ts` `openingBalanceOf` | 2026-11-13 | source code | Step 9 state: the live opening balance of a company or `null` |
| S5 | `packages/modules/ar/src/reminders.ts` `seedReminderSchedule` | 2026-11-13 | source code | Idempotent seed of the default reminder steps (`ON CONFLICT DO NOTHING`), returns rows added |
| S6 | `packages/modules/gl/src/system-roles.ts`, `templates.ts` | 2026-11-13 | source code | 17 core roles (migration 0005) and 7 period-end roles (0062, ADR-0061); the AU templates bind only the core roles |
| S7 | https://learn.microsoft.com/en-gb/dynamics365/business-central/ui-get-ready-business | 2026-11-13 | primary (comparable product) | Business Central marks an assisted setup guide *Completed* after it is run |
| S8 | https://docs.cosmoconsult.com/business-central/regulatory-affairs/get-started.html | 2026-11-13 | secondary (partner docs) | The BC checklist lets a user "Skip for now" and revisit; a step is finished by "Mark as completed" unless skipped |

## Findings

1. **Existing state per step** (S2, S3, S4, S6):
   | Step | Owner (package) | State already persisted |
   |---|---|---|
   | 1 Company | platform (`app.company`) + ledger (`app.fiscal_year`, 0018) | name, legal name, ABN, base currency; fiscal years generated from a convention |
   | 2 Chart | gl (`app.account`, `app.account_role_binding`) | accounts and system-role bindings |
   | 3 Tax | tax (`app.tax_code`, 0032) | effective-dated tax codes. **GST basis and BAS frequency: nowhere.** |
   | 4 Bank | bank (`app.bank_account`, 0056) | BSB, encrypted number, APCA user id, ABA user name |
   | 5 Salesforce | connector-salesforce (`app.salesforce_connection` 0017, `app.salesforce_billing_settings` 0052) | active connection per company; invoice trigger object |
   | 6 Import | parties / products (`salesforce_account_id`, `salesforce_product2_id`) | Salesforce-linked parties and products |
   | 7 Profiles | products (`profileGaps`) | profiles, overrides, gap check |
   | 8 Numbering etc. | ledger (`app.number_series`), ar (`app.billing_format`, `app.ar_settings`), payments (`app.stripe_settings`) | invoice number series, billing templates. **Branding, default payment terms, accepted payment methods: no single owner yet.** |
   | 9 Opening | setup (`app.opening_balance`, T-0080) | the live opening balance |
   | 10 Users | auth (`app.app_user`, `app.user_role`, 0021 `app.sod_settings`) | users, roles, SoD thresholds (bill, credit note, journal, batch) |
2. The AU chart templates bind only the 17 core roles (S6); the period-end roles are bound later
   by the period-end work, so requiring them at step 2 would block every new company (inference
   from S6).
3. Comparable products let a user skip or mark a step complete and come back (S7, S8). LedgerForce
   is stricter by design: a step completes only when its validator passes (card goal).
4. Step 9 has one legitimate no-data outcome named on the card: a new business has no history,
   so there is nothing to convert. Every other step sets up something the first invoice or payment
   needs (design §4 intro: "the first invoice posts correctly").

## Conclusion / decision

1. **Q1 validators (T-0123):** each step's validator reads the owning module and returns a list
   of plain-language *missing* items; `[]` means it passes:
   - 1: company name, legal name, a valid ABN (`abnIsValid`, parties), base currency, at least one
     fiscal year.
   - 2: at least one active account; every **core** system role bound (one item per unbound role).
   - 3: at least one tax code in force on the as-of date.
   - 4: at least one active bank account; at least one active bank account with an APCA user id
     and ABA user name (batch payments).
   - 5: an active Salesforce connection; the invoice trigger chosen (`salesforce_billing_settings`).
   - 6: at least one active Salesforce-linked party and one Salesforce-linked product.
   - 7: at least one active party and product posting profile; every `profileGaps` item, with its
     message.
   - 8: an active invoice number series (`ar_invoice_document`); at least one active billing
     format.
   - 9: a live opening balance (`openingBalanceOf`), or the company's recorded *no history*
     declaration.
   - 10: an active user holding `owner` or `finance_admin`; SoD settings saved (`app.sod_settings`).
2. **Q2 owners (T-0158, not T-0123):** GST basis and BAS frequency → **tax** module
   (`tax_settings` per company); invoice branding, default payment terms and accepted payment
   methods → **ar** module (extend AR settings per company); approval thresholds → the existing
   **SoD settings** (auth), adding only thresholds that design §6.5 names and 0021 lacks. The
   wizard never stores them; T-0158 extends validators 3, 8 and 10 to require them.
3. **Q3 skipping:** only step 9 may be completed without data, by declaring *no history* with a
   reason (1–500 characters). The same permission that completes a step may declare it (the API
   card T-0157 fixes that permission, proposed `settings.chart.manage`). No other step is skippable
   in the MVP; a later request to skip is a scope change.
4. **Q4 wizard state:** the wizard persists only the *completion record* per company and step
   (who, when, outcome `validated` | `no_history`, reason). Status is derived: `complete` when a
   record exists; `in_progress` for the first incomplete step (it is unlocked); `not_started` for
   later steps, which are locked. The wizard is complete when all ten records exist. Validators run
   on every read, so a completed step whose module state later regresses shows its missing items
   (`valid: false`) without being un-completed; reopening is out of scope.
5. **Q5 AC-6:** completing step 1 calls `seedReminderSchedule` (ar) in the same transaction; it
   is idempotent, so a repeat completion adds nothing.

## Confidence

`high` for Q1, Q4, Q5 (read from the repository's code and schema). `medium` for Q3 (design is
silent; follows the card and comparable products, recorded as a decision so it can be reversed).

## Follow-ups

- T-0157: `GET /setup/wizard`, `POST /setup/wizard/steps/:n/complete` (card AC-3).
- T-0158: GST basis / BAS frequency (tax), branding / payment terms / payment methods (ar),
  validators 3, 8, 10 extended.
- DL-0520 (ownership and validators), DL-0521 (skip rule), ADR-0067 (wizard state data model).

**Affects:** packages/modules/setup, apps/api/src/setup, packages/db migration 0065, design §4.1.
