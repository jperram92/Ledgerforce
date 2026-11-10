# Canonical migration integration map

Decision DL-0314; owner lineage choice DL-0308. Inventory source:
`.agent/evidence/T-0168/canonical-migration-inventory.json` pins every source commit and SQL blob.
The alternate `feat/T-0048-bad-debt` branch is excluded; it belongs to source 872c4fa's lineage.

`origin/main` e39a76c ends at migration 0030. The current canonical payment chain ends at 0048.
The broader canonical family independently allocated 0049–0053 to different features. These
are additional collisions within the chosen family, not a reason to reverse the owner's choice.

Additional observed gaps: the pinned T-0070 source tree has migrations 0047 then 0050–0053
(0048/0049 absent), and T-0080 has 0049 then 0051 (0050 absent). Their historical task status is
not evidence that those exact trees can migrate freshly. Re-run the actual consolidated tree.

## Integration order

| Consolidated slot | Preserved source file | Source branch |
| --- | --- | --- |
| 0049 | 0049_ar_customer_refund.sql | feat/T-0055-customer-refunds |
| 0050 | 0050_bank_matching.sql | feat/T-0060-bank-matching |
| 0051 | 0051_bank_reconciliation.sql | feat/T-0061-bank-reconciliation |
| 0052 | 0050_salesforce_inbound_change.sql | feat/T-0065-sf-inbound-mapping |
| 0053 | 0051_salesforce_sync_object.sql | feat/T-0066-sf-polling-fallback |
| 0054 | 0052_salesforce_billing_source.sql | feat/T-0069-closed-won-invoice |
| 0055 | 0053_salesforce_reconciliation.sql | feat/T-0070-sf-nightly-reconciliation |
| 0056 | 0049_payments_stripe_webhook.sql | feat/T-0074-stripe-webhooks |
| 0057 | 0051_setup_opening_balance.sql | feat/T-0080-setup-wizard |
| 0058 onward | reserved for new single-supply work | T-0168 and split implementation cards |

This is a reservation and review map, not an applied or verified schema. No SQL file has been
copied or renamed in the working migration directory. Preserve old files/commits in their source
histories and qualify original DL/task references when porting. The migrator's contiguous-version
and checksum checks stay intact. Do not fill these occupied slots with no-op migrations.

## Required proof before integration

1. Read each source migration and its dependent product/tests fully. Check dependencies and any
   shared function replacements, especially payment confirmation and bank reconciliation guards.
2. Port bounded feature groups with source provenance and regression tests; preserve existing
   test strength. Run a fresh migration through the full resulting sequence and forced-RLS tests.
3. Verify upgrade from the actual main schema and from the shared 0048 canonical schema without
   dropping data, rewriting migration checksums or disabling triggers.
4. Databases already migrated from a divergent feature branch must not be silently treated as
   consolidated databases. The existing checksum refusal is correct. If such a database needs
   preserving, build an explicit, audited additive adoption/upgrade path before running it;
   neither this map nor the owner lineage choice authorizes deleting its data.
5. Cross-provider review and existing security/human gates apply to each integrated feature.

## Scope impact

Single-supply work cannot safely add a local 0049 or jump directly to 0058. Resolve the schema
integration prerequisite while researching its journal/BAS contract. The current GP-021 advance
invoice route remains supported. T-0069's source WIP should not be applied over canonical
Closed Won code; review and preserve that canonical implementation at the mapped schema slot.
