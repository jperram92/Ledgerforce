---
adr: 0082
title: "HTTP routes for the posting-profile matrix: read the matrix, set an override"
status: Proposed
date: 2026-11-15
author: claude
category: architecture
human_gate: no
supersedes: none
superseded_by: none
---

# ADR-0082: HTTP routes for the posting-profile matrix

## Status
Proposed. It becomes Accepted on green CI plus cross-review by codex. The category is
architecture, a public API change. It adds no permission, no table, no migration and no
third-party dependency, so it has no human gate. (`@ledgerforce/products`, an internal workspace
package, moves from a dev to a runtime dependency of the API, as in DL-0624.)

## Context and problem statement
Design §4.4: a document line's accounts come from the party profile × product profile matrix, with
an override only where a combination differs from the product default. The module (T-0039,
DL-0267) resolves one combination (`resolvePosting`), lists the gaps (`profileGaps`, which wizard
step 7 shows) and sets an override (`setOverride`). It has no HTTP route (RQ-0162 finding 2).
The matrix screen (IA S13, mockup 08, T-0188) must show the whole matrix and let a Finance Admin
fill a gap. The browser may not resolve accounts itself (apps/web AGENTS.md).

## Decision drivers
- A thin controller over the module, which owns the resolution rule (one rule for posting, the
  gap check and the screen).
- The apps/api rules: an Idempotency-Key on every mutation, an audit entry for every change, and a
  tenant transaction. Money and accounts are never computed in the browser.
- The permission catalogue as it stands (no new permission).

## Decision
1. **Module read** `profileMatrix(trx, companyId, date)` in `@ledgerforce/products` returns:
   - the active party profiles (code, name, kind, control account, default tax code);
   - the active product profiles (code, name, revenue, expense and COGS accounts, default tax code);
   - one **cell** per party × product, resolved by the same `resolveRows` as `resolvePosting` for the
     party's purpose (customer → sale, supplier → purchase). A resolved cell carries its account
     (id, code, name), its account source (`product` default or `override`) and its tax code with
     source. A gap carries the reason and message that `profileGaps` reports. Every cell says
     whether an override row exists;
   - the **choices**: the company's active, postable, non-control revenue and expense accounts,
     which are the only accounts an override may name (`setOverride`'s rule).

   It returns null when the company is not visible (another tenant's or unknown).
2. **Module write** `fillOverride(trx, companyId, input)` checks that both profiles are active
   profiles of the company and that a given tax code is an active tax code of the company
   (`PROFILE_UNKNOWN`, `PROFILE_TAX_CODE`). It then calls `setOverride`, which refuses an unusable
   account with `PROFILE_ACCOUNT`. It returns the override before and after, plus `changed`.
3. **`GET /posting-profiles/matrix?company_id=&as_of=`** needs `settings.read`. That is the
   permission that reads the wizard, so the Owner, Finance Admin, Accountant and Auditor hold it.
   `as_of` defaults to today in the tenant's report time zone, as for the wizard (ADR-0075).
   Answers: 200 with the matrix; 400 for a malformed request; 404 when the company is not visible.
4. **`PUT /posting-profiles/overrides`** needs `settings.chart.manage` (Owner, Finance Admin): choosing the
   account a combination posts to is chart configuration, like re-binding a system role (T-0146).
   - Body: `{ company_id, party_profile_id, product_profile_id, revenue_account_id?,
     expense_account_id?, cogs_account_id?, tax_code? }`. A field that is left out stays as it
     is; `null` clears it.
   - The Idempotency-Key header is required (400 without it). Setting a value is idempotent by
     nature, as for the system-role rebind: a repeat answers 200 with `changed: false` and writes
     nothing.
   - A change writes one audit entry (`posting_profile_override`,
     `<party_profile_id>:<product_profile_id>`) with the values before and after.
   - Refusals: 400 malformed request; 404 unknown company or profile (`PROFILE_UNKNOWN`); 422 for an
     unusable account or tax code (`PROFILE_ACCOUNT`, `PROFILE_TAX_CODE`).
5. Overrides are configuration rows, not ledger rows. No journal is written. Documents resolve the
   new account the next time they are built.

## Consequences
- Good: the screen shows exactly what posting and the wizard's gap check will do. The gap list on
  step 7 and the matrix cannot disagree.
- Good: no schema change (`app.posting_profile_override`, migration 0033).
- Neutral: an override cannot be deleted through these routes. Every field can be cleared to null,
  and the cell then falls back to the product default. Removing the row would be a later, separate
  route.
- Bad: the read resolves every cell with a few queries each (as `profileGaps` already does). That
  is fine for setup-sized matrices (tens of profiles); caching waits for evidence of need.

## Alternatives considered
- Compute the matrix in the browser from raw profile rows: rejected, because it is accounting in
  the browser and would be a second copy of the resolution rule.
- A new permission `settings.posting_profiles.manage`: rejected, because it is a security change
  (human gate) for something `settings.chart.manage` already covers.
- POST with an idempotency table: rejected. No migration is allowed in this round (DL-0569), and
  the set is idempotent by nature.

## Links
RQ-0162, DL-0650, DL-0652, T-0187, T-0188, ADR-0075, design §4.4, IA S13.
