---
id: RQ-0162
title: Opening balances and posting-profile screens — which routes exist, which golden posting applies
status: answered
opened: 2026-11-15
resolved: 2026-11-15
opened_by: claude
linked_tasks: [T-0177, T-0187, T-0188]
linked_adrs: [ADR-0082, ADR-0075, ADR-0067]
superseded_by:
---

# RQ-0162 — Opening balances and posting-profile screens

## Question

T-0177 has two open questions:

- Q1. Do HTTP routes exist for the posting-profile matrix (read the matrix and its gaps, fill a gap)?
  If not, they are a public API change and need an ADR.
- Q2. Opening balances post a journal. Is its golden posting Approved, and which routes does the
  screen call?

## Findings

1. **Opening balances (Q2).** `apps/api/src/setup/opening-balances.controller.ts` (T-0080, DL-0314)
   already serves:
   - `POST /setup/opening-balances/preview`, the posting engine's `preview()` of the GP-037 journal
     (writes nothing);
   - `POST /setup/opening-balances`, which posts through `postOpeningBalance` and the posting engine.
     It needs an Idempotency-Key (201 new, 200 replay) and is audited (`opening_balance`);
   - `GET /setup/opening-balances?company_id=`, the live opening balance (404 none).

   All three need `settings.chart.manage`. The body is the CSV text of the trial balance and of the
   open AR and AP items, plus `conversion_date`. CSV refusals are 422 with `error` and `row`. Engine
   refusals are 422 with `error` and `line`. Test: `apps/api/src/setup/opening-balances.db.test.ts`
   (SS-PLAT-117).
   **GP-037 is Approved** (DL-0263 delegation, DL-0314; `Docs/accounting/postings.md`). The screen
   adds no posting behaviour, so no golden posting changes. Preview lines carry `account_code`,
   `debit`, `credit` (both decimal strings with one side zero), `party_id`, `due_date` and `memo`,
   but no account name. The screen reads names from `GET /accounts` (gl.account.read, which the
   Owner and Finance Admin hold), and shows the code alone if that read fails.
2. **Posting profiles (Q1).** No API route reads or writes posting profiles: a search of
   `apps/api/src` finds no use of `@ledgerforce/products` (it is only a dev dependency of the API).
   The module (`packages/modules/products/src/matrix.ts`, T-0039, DL-0267) has `resolvePosting`,
   `profileGaps` and `setOverride` but no "whole matrix" read. The wizard validator for step 7
   (`packages/modules/setup/src/wizard-validators.ts`) words each `profileGaps` result as
   `Posting-profile gap: <party> × <product> (<purpose>): <message>`.
   The screen therefore needs (a) a module read of the matrix (every active party profile × active
   product profile, each cell resolved by the same rule as `resolvePosting`, with the account's
   code and name and whether it came from the product default or an override), and (b) two routes:
   `GET /posting-profiles/matrix` and `PUT /posting-profiles/overrides`. That is a public API
   change, so it needs **ADR-0082** (category architecture, no new permission, no table, no
   migration: `app.posting_profile_override` already exists, migration 0033).
3. **Permissions (catalogue, `packages/shared/src/rbac/catalogue.ts`).** Reading the matrix is a
   settings read: `settings.read` (Owner, Finance Admin, Accountant, Auditor), which is the same
   permission the wizard's GET uses (DL-0590). Filling a gap chooses the account a combination
   posts to. That is chart-of-accounts configuration, so it needs `settings.chart.manage` (Owner,
   Finance Admin), like `PUT /accounts/system-roles/:role` (T-0146). No new permission is needed.
4. **Idempotency without a table.** `PUT /accounts/system-roles/:role` sets a value that is
   idempotent by nature. It requires the Idempotency-Key header, writes nothing and audits nothing
   when the value is already set (`changed: false`). An override set behaves the same way: the
   same body again leaves the same row. So the route needs no idempotency table (none may be
   added in this round, DL-0569).
5. **Screen paths.** IA S13 puts the matrix at `/accounting/posting-profiles` (also wizard step 7).
   The IA has no route for opening balances. The wizard lives at `/settings/setup` (DL-0600), so
   the opening balances screen goes at `/settings/setup/opening-balances`.

## Conclusion

- Opening balances: build the screen on the existing routes. No API change and no golden change.
- Posting profiles: add a module read `profileMatrix`, plus `GET /posting-profiles/matrix`
  (settings.read) and `PUT /posting-profiles/overrides` (settings.chart.manage, Idempotency-Key,
  audited when changed) under ADR-0082. Then build the screen.
- The card is too big for one slice. Split it: T-0177 keeps the opening-balances screen, T-0187
  takes the matrix read and routes, and T-0188 the matrix screen.

## Sources

- Code at caee105: `apps/api/src/setup/opening-balances.controller.ts`, `.db.test.ts`;
  `packages/modules/products/src/matrix.ts`; `packages/modules/setup/src/wizard-validators.ts`;
  `apps/api/src/gl/accounts.controller.ts` (rebind pattern); `packages/shared/src/rbac/catalogue.ts`.
- `Docs/accounting/postings.md` GP-037 (Approved); `Docs/ui/information-architecture.md` S13;
  `Docs/ui/mockups/08-setup-wizard.html`; design §4.1 steps 7 and 9, §4.4.
