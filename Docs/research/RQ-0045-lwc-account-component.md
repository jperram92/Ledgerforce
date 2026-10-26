---
id: RQ-0045
title: How the UC-12 Account LWC reads LedgerForce mirror data (wire adapters vs Apex), formats money without client arithmetic, respects FLS, and is tested offline with LWC Jest
status: resolved
opened: 2026-10-26
resolved: 2026-10-26
opened_by: claude
linked_tasks: [T-0072, T-0111]
linked_adrs: [ADR-0006]
superseded_by:
---

# RQ-0045 — LWC Account component: data access, money display, FLS and offline tests

## Question

- Q1. Should the component read the Account mirror fields and the five most recent
  `LF_Invoice__c` rows through Lightning Data Service wire adapters (`lightning/uiRecordApi`
  `getRecord`, `lightning/uiRelatedListApi` `getRelatedListRecords`) or through an Apex
  controller (`@AuraEnabled(cacheable=true)` with `WITH USER_MODE` / `WITH SECURITY_ENFORCED`)?
- Q2. How are "the five most recent" invoices selected (sort, page size, related-list id)?
- Q3. How is money shown without floating-point arithmetic in the browser (AGENTS.md §4)?
- Q4. How are field-level security and sharing respected for a sales user with the
  `LF_Read_Only` permission set?
- Q5. How is an LWC tested without an org, and how does that test run inside the repo's gates
  (`pnpm test`, verify gate 2a, CI)?
- Q6. Which bundle metadata (`*.js-meta.xml`) exposes the component on Account record pages?
- Q7. (Card open question) Phase placement: design §8.2 puts UC-12 in MVP, §9.1 lists the
  "LWC Account component" under Phase 1.

## Why it matters

T-0072 / UC-12 (design §5.4, §8.2): sales reps see balance due, overdue amount, last payment and
the five most recent invoices "with no LedgerForce login". The package must stay unlocked and
pass a later AppExchange security review (salesforce/AGENTS.md), so every data path must enforce
CRUD/FLS. There is no Dev Hub or scratch org in this environment (RQ-0022), so the behaviour must
be proven offline and the org check deferred honestly.

## Sources consulted

`developer.salesforce.com` is blocked by this environment's egress proxy (`CONNECT tunnel failed,
response 403`; WebFetch `ENOTFOUND`, the same as RQ-0022). Primary documentation was reached
through search-result extracts; the authoritative offline behaviour comes from the source code of
the pinned `@salesforce/sfdx-lwc-jest@7.9.0` and an executed spike.

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S1 | https://developer.salesforce.com/docs/platform/lwc/guide/reference-get-field-display-value.html (search extract) | 2026-10-26 | primary (search summary) | `getFieldDisplayValue` returns the field's display value "formatted and localized"; currency example `$350,000,000`; the same value is at `record.data.fields.<field>.displayValue`; returns `undefined` when no formatted value is available. `getFieldValue` returns the raw value (`350000000`). |
| S2 | https://developer.salesforce.com/docs/atlas.en-us.uiapi.meta/uiapi/ui_api_responses_field_value.htm (search extract) | 2026-10-26 | primary (search summary) | UI API Field Value = `{ displayValue, value }`; `displayValue` is the localized, formatted string. |
| S3 | https://developer.salesforce.com/docs/platform/lwc/guide/reference-wire-adapters-get-related-list-records.html (search extract) | 2026-10-26 | primary (search summary) | `getRelatedListRecords`: `parentRecordId` and `relatedListId` required; `fields`, `optionalFields`, `pageSize` (default 50, 1–1999), `sortBy`, `where` optional; `sortBy` is an array that "accepts only one value"; custom relationship ids are `Custom_Objects__r`; fields as `Custom_Object__c.FieldName__c`. |
| S4 | https://developer.salesforce.com/docs/atlas.en-us.uiapi.meta/uiapi/ui_api_resources_related_list_records.htm (search extract) | 2026-10-26 | primary (search summary) | `sortBy`: a leading minus sign makes the order descending (example `-CreatedDate`). |
| S5 | https://developer.salesforce.com/docs/atlas.en-us.222.0.lightning.meta/lightning/apex_crud_fls.htm (search extract) and https://www.apexhours.com/lightning-data-service/ | 2026-10-26 | primary (older version) + secondary | Lightning Data Service is built on UI API and handles sharing, CRUD and FLS for you; Apex does not enforce them by default, so Apex controllers must enforce them themselves. |
| S6 | https://developer.salesforce.com/docs/atlas.en-us.232.0.api_meta.meta/api_meta/meta_lightningcomponentbundle.htm (search extract) | 2026-10-26 | primary (older version) | `<component>.js-meta.xml`, root `LightningComponentBundle`; `isExposed` + at least one `target` makes it available in Lightning App Builder; `targetConfig` for `lightning__RecordPage` with `<objects><object>…</object></objects>` restricts it to those record pages. |
| S7 | https://developer.salesforce.com/docs/platform/lwc/guide/unit-testing-using-wire-utility.html (search extract) | 2026-10-26 | primary (search summary) | Wire adapters are mocked in Jest by test adapters that "emit data on demand" via `emit()`; fixtures live in `__tests__/data/*.json`. |
| S8 | `node_modules/@salesforce/sfdx-lwc-jest` 8.0.0 and 7.9.0 source (`src/config.js`, `src/utils/project.js`, `src/utils/test-runner.js`, `src/lightning-stubs/uiRecordApi`, `uiRelatedListApi`, `formattedNumber`) | 2026-10-26 | source code | Must run from the SFDX project root (reads `sfdx-project.json`, finds `<packageDir>/**/lwc`); without a `jest.config.*` it passes its own config (`@lwc/jest-preset`, jsdom, LWC transformer, lightning stubs). `getRecord`, `getRelatedListRecords` are `createLdsTestWireAdapter(jest.fn())`; `getFieldValue` / `getFieldDisplayValue` are real implementations. Lightning base components are stubs with `@api` properties and an empty template. Depends on jest 29.7.0. |
| S9 | `node_modules/@salesforce/wire-service-jest-util` 4.1.6 source | 2026-10-26 | source code | LDS test adapter: `emit(data)`, `emitError(...)`, `getLastConfig()` (the resolved config the component passed, including `$recordId`). |
| S10 | `npm view @salesforce/sfdx-lwc-jest time` / `dependencies` | 2026-10-26 | experiment | 8.0.0 published 2026-06-26 (deps `@lwc/engine-dom` 9.3.4); 7.9.0 published 2026-04-01 (deps `@lwc/engine-dom` 8.28.2, jest 29.7.0). Both well over 2 weeks old. `pnpm audit` and `pnpm audit --prod` clean with 7.9.0. |
| S11 | Spike: `pnpm test:lwc` (cd salesforce && sfdx-lwc-jest -- --ci) before any spec existed | 2026-10-26 | experiment | Without `jest.config.cjs` Jest also picked up `salesforce/test/*.test.ts` (Vitest files) and failed; with `testMatch` limited to `force-app/**/lwc/**/__tests__/**/*.test.js` it exits 1 with "No tests found, exiting with code 1" — `--passWithNoTests` is not set, so a missing spec fails the gate rather than passing silently. |
| S13 | Spike: first spec run with 8.0.0 | 2026-10-26 | experiment | `SyntaxError: Unexpected token 'export'` in `@lwc/engine-dom/dist/index.js`: the 8.0.0 resolver returns `require.resolve('@lwc/engine-dom')`, whose 9.3.4 `main` is an ESM file that Jest 29 does not transform. With 7.9.0 (engine-dom 8.28.2, CJS `main`) the same spec compiles and runs. |
| S12 | Design §5.4, §8.2 UC-12, §9.1; `Docs/specs/UC-12.md`; `salesforce/AGENTS.md`; RQ-0088 (SLDS 2 hooks only) | 2026-10-26 | primary (project) | UC-12 reads Account `LF_Balance_Due__c`, `LF_Overdue_Amount__c`, `LF_Credit_Status__c`, `LF_Last_Payment_Date__c` and `LF_Invoice__c`; the package never computes accounting. |

## Findings

1. (Q1) LDS wire adapters enforce CRUD, FLS and sharing for the running user (S5) and need no
   Apex, no test class and no org-only coverage gate. Both reads the component needs exist as
   adapters: `getRecord` for the Account fields and `getRelatedListRecords` for the child
   `LF_Invoice__c` rows (S3). An Apex controller would add code that must enforce FLS itself
   (`WITH USER_MODE`), plus an Apex test class that cannot run here (no org). Inference:
   pure-LWC wire design is both safer and fully testable offline.
2. (Q2) The child relationship `LF_Invoice__c.LF_Account__c` is named `LF_Invoices`, so the
   related-list id is `LF_Invoices__r` (S3, salesforce contract test). Sorting is server-side,
   one key only, descending with a leading `-` (S3, S4); `pageSize: 5` returns five rows.
   "Most recent" = latest `LF_Issue_Date__c` (the document date LedgerForce mirrors).
   Inference (medium): whether the `-` prefix is written before the qualified name
   (`-LF_Invoice__c.LF_Issue_Date__c`) is not visible in the extracts; it must be confirmed in a
   scratch org (T-0111).
3. (Q3) UI API returns `displayValue`, a server-formatted, localized string, for currency fields
   (S1, S2). Showing it means the browser never parses or computes money. When `displayValue`
   is absent (S1: `undefined` "if a localized or formatted value is not available") the raw
   value can only be *formatted* by `lightning-formatted-number format-style="currency"`
   (no arithmetic). Dates are formatted by `lightning-formatted-date-time` with
   `time-zone="UTC"` so a date-only value never shifts a day.
4. (Q4) With `getRecord` `fields`, a field the user cannot read makes the wire return an error
   rather than silently showing nothing; the component then shows an error state. The
   `LF_Read_Only` permission set grants read on every field the component uses — checked by an
   offline contract test so a future field cannot be added without the permission.
5. (Q5) `@salesforce/sfdx-lwc-jest` is Jest-based (S8). The repo runs Vitest; running LWC
   templates under Vitest would need a hand-built LWC compiler plugin and lightning stubs —
   rebuilding what sfdx-lwc-jest is. A separate `test:lwc` script chained into `pnpm test`
   (`vitest run … && pnpm test:lwc`) puts the LWC suite in verify gate 2a and CI's
   `pnpm test` step with no change to either; Jest fails on "No tests found" (S11).
6. (Q6) `isExposed=true`, target `lightning__RecordPage` with `objects/object=Account` (S6),
   `apiVersion` = the project API version 67.0 (RQ-0022).
7. (Q7) The design is internally inconsistent (§8.2 MVP vs §9.1 Phase 1). The backlog already
   schedules T-0072 under MVP, the lead assigned it in round 8 (DL-0207), and the §7.2 component
   table lists "LWC package" under the MVP Salesforce Connector. Building it now is inside
   scope either way (it moves earlier, not out of scope); the human only confirms placement.

## Conclusion / decision

- Build a pure-LWC component `lfAccountSummary` with two wires: `getRecord` (Account fields via
  `@salesforce/schema` imports) and `getRelatedListRecords` (`LF_Invoices__r`, `pageSize: 5`,
  `sortBy: ['-LF_Invoice__c.LF_Issue_Date__c']`). No Apex.
- Show money from `displayValue`; fall back to `lightning-formatted-number` (format only). Never
  parse, add or compare money in JavaScript. Lint the LWC JavaScript with the repo's
  `lf/no-float-money` rule including the number-conversion ban.
- States: loading (spinner), error (message, no partial money), empty (no invoices), data.
- Test with `@salesforce/sfdx-lwc-jest@7.9.0` (dev dependency, DL-0218); `pnpm test:lwc`
  chained into `pnpm test`; an offline Vitest contract guard proves the chain, the bundle
  metadata, and that every field read is granted by `LF_Read_Only`.
- The scratch-org e2e (SS-UC12-04) and the `sortBy` `-` syntax check move to T-0111.

## Confidence

`medium-high`: data access, FLS by LDS, `displayValue` and bundle metadata are from primary
documentation (extracts) and the pinned library source; the exact descending `sortBy` string is
`medium` and is verified in the scratch org (T-0111).

## Follow-ups

- T-0111: deploy to a scratch org, open an Account as a sales user, screenshot (SS-UC12-04),
  and confirm the descending sort string and `displayValue` for currency and date fields.
- Human: confirm UC-12 phase placement (MVP vs Phase 1).

**Affects:** T-0072, T-0111, salesforce/force-app/main/default/lwc, UC-12, design §5.4
