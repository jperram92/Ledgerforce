---
id: RQ-0022
title: SFDX unlocked-package metadata layout for the LedgerForce package, current API version, and how to validate it without an org
status: resolved
opened: 2026-10-24
resolved: 2026-10-24
opened_by: claude
linked_tasks: [T-0062]
linked_adrs: [ADR-0006, ADR-0007]
superseded_by:
---

# RQ-0022 — SFDX package metadata and offline validation

## Question

- Q1. What is the source-format layout of an SFDX project for an unlocked package
  (`sfdx-project.json`, objects, fields, validation rules, permission sets, custom permissions)?
- Q2. Which API version should `sourceApiVersion` and the `*-meta.xml` files use today?
- Q3. How is a Platform Event (`__e`) defined in metadata (`eventType`, `publishBehavior`), and
  how do permission sets grant publish/subscribe? Does field-level security apply to its fields?
- Q4. How do we make the mirror objects and LedgerForce-owned Account/Opportunity fields
  read-only for everyone except the integration user, as design §5.4 requires ("permission
  sets and a validation rule")?
- Q5. What can be validated **without an org** (the card's open question: the human provides a
  Dev Hub later; CI has none today)? Can `sf project convert source` run offline? Can
  `sf project deploy validate` (check-only deploy)?

## Why it matters

T-0062 builds the package that every later Salesforce task depends on: T-0063 (auth, needs the
integration permission set), T-0067 (write-back by `LF_Id__c` external ID), T-0072 (LWC reads the
mirror fields). Design §5.1, §5.4, §5.5; ADR-0006 (field ownership). A wrong field type or a
missing external-ID flag is only discovered at deploy time in an org, which we do not have yet.

## Sources consulted

`developer.salesforce.com` is blocked by this environment's egress proxy (`CONNECT tunnel
failed, response 403`; WebFetch: `ENOTFOUND`), so primary documentation was reached through
search-result extracts, and the Salesforce CLI itself (the reference implementation of the
source format) was installed outside the repository and executed.

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S1 | `npm view @salesforce/cli time` | 2026-10-24 | primary (registry) | Latest 2.157.2 (2026-10-24); 2.155.0 published 2026-10-08 (16 days old). |
| S2 | `npm install @salesforce/cli@2.155.0` into the session scratchpad (not the repo) | 2026-10-24 | experiment | 1,472 packages, **697 MB** `node_modules`. |
| S3 | `sf project generate --name genproj --template empty` (CLI 2.155.0) | 2026-10-24 | experiment | Generated `sfdx-project.json`: `packageDirectories:[{path:"force-app",default:true}]`, `namespace:""`, `sourceApiVersion:"67.0"`; `.forceignore` ignores `package.xml`, `**/__tests__/**`. |
| S4 | `sf project deploy validate --help` (CLI 2.155.0) | 2026-10-24 | experiment | `-o, --target-org=<value> (required)` — a check-only deploy always needs an org. |
| S5 | `sf project convert source --help` (CLI 2.155.0) | 2026-10-24 | experiment | Converts source format to Metadata API format; flags are local paths only, no org flag. |
| S6 | `@salesforce/source-deploy-retrieve` 13.4.4 `lib/src/registry/metadataRegistry.json` (bundled in CLI 2.155.0) | 2026-10-24 | source code | `customobject`: directory `objects`, suffix `object`, `strictDirectoryName: true`, children `fields/field`, `validationRules/validationRule`, `listViews/listView`, …; `permissionset`: `permissionsets/permissionset`; `custompermission`: `customPermissions/customPermission`. |
| S7 | `@salesforce/schemas` 1.10.3 `sfdx-project.schema.json` (bundled) | 2026-10-24 | source code | A package directory may carry `package`, `versionName`, `versionNumber` (`major.minor.patch.build`, e.g. `1.2.1.8`; `NEXT` allowed as build), `definitionFile`. |
| S8 | WebSearch "Salesforce Winter '27 API version" → Apex Reference / Tooling API version lists, apexhours.com, salesforceben.com | 2026-10-24 | secondary | Spring '26 = 66.0, Summer '26 = 67.0, Winter '27 = 68.0 (listed as preview in the doc sets found). |
| S9 | WebSearch → developer.salesforce.com *Platform Events Developer Guide*, "Migrate Platform Event Definitions with Metadata API" (extract) | 2026-10-24 | primary (extract) | A platform event is a `CustomObject` whose name ends in `__e`; sample sets `<eventType>HighVolume</eventType>`, `<publishBehavior>PublishAfterCommit</publishBehavior>`, `<deploymentStatus>Deployed</deploymentStatus>`; "Only the HighVolume value is supported … if you create a platform event with the StandardVolume event type, you get an error." |
| S10 | WebSearch → developer.salesforce.com *Platform Events Developer Guide*, "Considerations for Defining and Publishing Platform Events" (extract) | 2026-10-24 | primary (extract) | "All platform event fields are read only by default, and you can't restrict access to a particular field … field-level security permissions don't apply and the event message contains all fields." |
| S11 | WebSearch → Trailhead "Bypass your validation rules"; greytrix.com; outboundsync.com | 2026-10-24 | secondary | Pattern: a custom permission assigned through a permission set; the validation rule skips users who hold it (`$Permission.<Name>`), so the bypass is granted/revoked without editing formulas. |
| S12 | Salesforce Metadata API behaviour known from use, consistent with S6 (not re-fetched: docs blocked) | 2026-10-24 | inference (medium) | Permission sets cannot carry `fieldPermissions` for universally required fields or master-detail fields (deploy error); platform events support only Read and Create object permissions. |

## Findings

1. **Layout (Q1).** Source format puts each object in `force-app/main/default/objects/<Obj>/`
   with `<Obj>.object-meta.xml`, fields in `fields/<Field>.field-meta.xml`, validation rules in
   `validationRules/<Name>.validationRule-meta.xml`; permission sets in
   `permissionsets/<Name>.permissionset-meta.xml`; custom permissions in
   `customPermissions/<Name>.customPermission-meta.xml` (S6). Standard objects (Account,
   Opportunity) take only the child folders for the custom fields/rules we add — no
   `<Obj>.object-meta.xml` is needed for them (S6: children are separate components).
   `sfdx-project.json` for an unlocked package names the package directory with `package`,
   `versionName` and `versionNumber` (`0.1.0.NEXT`) (S7); the `packageAliases` id (`0Ho…`) is
   only created by `sf package create` against a Dev Hub, so it is added later.
2. **API version (Q2).** The CLI's own project template uses **67.0** (S3); Winter '27 (68.0) is
   still listed as a preview in the doc sets we could reach (S8). 67.0 deploys to every org on
   Summer '26 or later. *Inference:* pin 67.0 now; move to 68.0 in a later card after the
   Winter '27 rollout is confirmed GA for production orgs.
3. **Platform event (Q3).** `LF_Billing_Request__e` is a `CustomObject` with
   `eventType HighVolume` (the only supported value), `deploymentStatus Deployed` and
   `publishBehavior PublishAfterCommit` (S9). PublishAfterCommit means a request published from a
   Flow or button whose transaction rolls back is never delivered — the safe choice for "Invoice
   this Opportunity". FLS does not apply to event fields (S10), so permission sets must not carry
   `fieldPermissions` for `__e` fields; access is the object permission: Create = publish,
   Read = subscribe (S12, inference consistent with S10).
4. **Read-only (Q4).** Two independent controls, as design §5.4 requires:
   (a) permission sets — the sales-user set grants Read on the mirror objects and `readable`
   only on every LF field; only the integration set grants Create/Edit and `editable`;
   (b) validation rules that reject any insert/update of the mirror objects, and any change to an
   LF-owned Account/Opportunity field, unless `$Permission.LF_Integration_Write` (a custom
   permission granted only by the integration permission set) is true (S11). (b) also stops
   administrators whose profiles give them FLS edit, which (a) alone cannot.
   Fields used in permission sets must not be required at field level and must be lookups, not
   master-detail (S12).
5. **Offline validation (Q5).** `sf project convert source` has no org flag and runs offline
   (S5; executed in T-0062, see the card's evidence). `sf project deploy validate` needs
   `--target-org` (S4), so a check-only deploy and Apex tests need the Dev Hub/scratch org the
   human will provide. Salesforce publishes no standalone XSD for source format; the CLI is the
   reference parser (S6). Adding the CLI to the repo's devDependencies would add ~697 MB and
   ~1,470 packages to every `pnpm install` (S2).

## Conclusion / decision

- Build the package under `salesforce/` with `sfdx-project.json` (`sourceApiVersion` **67.0**,
  package directory `force-app`, package `LedgerForce`, `versionNumber 0.1.0.NEXT`).
- Validate offline with a **repo-owned contract test** (Vitest, `salesforce/test/`) and a small
  strict reader for the XML subset Salesforce metadata uses (elements, text, the five predefined
  entities, comments, the root `xmlns` attribute; everything else refused). The test asserts the
  contract later tasks depend on: objects, fields, types, external-ID/unique flags, permission
  sets (least privilege), validation rules, the platform event, API-version consistency, file
  naming, and no secrets in `salesforce/`.
- Do **not** add `@salesforce/cli` to the repo (size, S2). Run `sf project convert source`
  (CLI 2.155.0, installed outside the repo) as a cross-check and record its output as evidence.
- The org-dependent half of SS-UC12-02 (a sales user's save is blocked in a real org; Apex test)
  waits for the Dev Hub. Write the Apex test now, mark it as not yet executed, and keep the
  register honest.
- Decision-log entries DL-0094 … DL-0097.

## Confidence

`high` for layout, CLI behaviour and API 67.0 as the CLI default (executed experiments, S2–S7);
`medium` for the platform-event permission and FLS restrictions (primary-doc extracts via search
and long-standing behaviour, S9–S12) — the scratch-org deploy will confirm or refute them.

## Follow-ups

- When the Dev Hub exists: `sf package create`, a scratch-org deploy, run the Apex test, then flip
  SS-UC12-02's org part. Re-check API 68.0 GA (re-check date: 2026-11-30).

**Affects:** `salesforce/`, T-0063, T-0067, T-0072, design §5.1/§5.4/§5.5, ADR-0006.
