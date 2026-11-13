---
id: RQ-0101
title: Salesforce CDC change event bodies for inbound mapping — what CREATE, UPDATE, DELETE and UNDELETE carry, compound fields, multi-record events, commit number
status: resolved
opened: 2026-11-02
resolved: 2026-11-02
opened_by: claude
linked_tasks: [T-0065]
linked_adrs: [ADR-0006, ADR-0032]
superseded_by:
---

# RQ-0101 — CDC change event bodies for the inbound Account/Contact/Product2 mapping

## Question

Q1. Which body fields does each change type carry (CREATE, UPDATE, DELETE, UNDELETE), and how does
an UPDATE tell "unchanged" apart from "set to null"?
Q2. How do compound fields (Account `BillingAddress`, Contact `Name`) appear in the body and in
`changedFields`?
Q3. Can one change event name several records (`recordIds`), and what does that mean for applying
it?
Q4. Can `commitNumber` order changes, and is "record Id + commit number" unique per change?

## Why it matters

T-0065 maps change events to party, contact and product upserts (design §5.5) with an idempotency
key (design §5.6 rule 1). Applying an UPDATE's null "unchanged" fields as values would wipe data;
treating a DELETE body as values would do the same; ordering by commit number across an instance
migration would drop changes.

## Sources consulted

`developer.salesforce.com` could not be fetched from this sandbox (DNS blocked, as in RQ-0004 and
RQ-0036); the pages below were read through WebSearch result extracts, which quote them.

| # | Source | Accessed | Kind | What it says |
|---|---|---|---|---|
| S1 | https://developer.salesforce.com/docs/atlas.en-us.change_data_capture.meta/change_data_capture/cdc_event_fields_header.htm and https://developer.salesforce.com/docs/atlas.en-us.apexref.meta/apexref/apex_class_eventbus_ChangeEventHeader.htm (via WebSearch) | 2026-11-02 | primary (extract) | `changedFields` lists the fields changed in an update (including LastModifiedDate) and is empty for other operations, including CREATE. When the same change applies to several records, Salesforce sends **one** event and `recordIds` holds all their ids (examples: the same field set to the same value on many Accounts; deleting several Accounts). `nulledFields` names fields set to null in an update. `transactionKey` groups the changes of one transaction; `sequenceNumber` is the change's position in it, starting at 1. |
| S2 | Same ChangeEventHeader pages (via WebSearch) | 2026-11-02 | primary (extract) | `commitNumber` is the system change number, a diagnostic value that rises over time; it is unique only within one database instance and, after an org migrates to another instance, "might not be unique or sequential". |
| S3 | https://developer.salesforce.com/docs/atlas.en-us.change_data_capture.meta/change_data_capture/cdc_event_fields_body.htm (current and 262.0, via WebSearch) | 2026-11-02 | primary (extract) | DELETE: the body carries no usable record values (current page says either "no values" or "all fields with empty values"; 262.0 says all record fields are null). UNDELETE: the body carries the original record's data. UPDATE over Pub/Sub: unchanged fields are empty even when the record has a value; fields set to null are also empty — tell them apart with the decoded `changedFields` / `nulledFields`. |
| S4 | https://developer.salesforce.com/docs/platform/change-data-capture/guide/cdc-subscribe-compound-fields.html (via WebSearch) | 2026-11-02 | primary (extract) | Compound fields (Address, Name) are nested structures in the event. In an update, `changedFields` names each changed component as `Compound.Component`, e.g. `BillingAddress.Street`; the nested object lists every component, unchanged ones null. Component names can differ from the object's flat field names (`BillingAddress.Street` ↔ `Account.BillingStreet`). |
| S5 | RQ-0036 (S7, S8) and DL-0169 | 2026-11-02 | internal | Header field list, gap/overflow events, and the existing per-record idempotency key `cdc:<entity>:<record id>:<commit number>:<sequence number>`. |

## Findings

1. **What to apply (S1, S3).** CREATE and UNDELETE: every non-null body field is the record's
   value. UPDATE: only the fields named in `changedFields` changed; a changed field whose value is
   null (or that is in `nulledFields`) was cleared; every other field must be left alone, whatever
   its body value. DELETE: no values; the header's record ids are the only payload.
2. **Compound fields (S4).** The mapping must read nested records (`BillingAddress.City`,
   `Name.LastName`) and match `changedFields` entries of the form `Compound.Component`. A changed
   component is applied from the nested value. Flat names (`BillingCity`) may also appear for
   schemas that expose them (our documented fixture of RQ-0036 does); the field map accepts both.
3. **Multi-record events (S1).** One UPDATE or DELETE can name many records with the *same*
   change. The mapper applies the change to each record id and keeps one idempotency key per
   record (the existing key already does).
4. **Commit number (S2, S5).** Commit number alone is not a safe ordering key across an instance
   migration, and one transaction can change the same record twice (CREATE then UPDATE, same
   commit number, different `sequenceNumber`). The key stays record id + commit number +
   sequence number (DL-0169). Changes are applied in delivery order (replay-id order on a channel);
   no "newest commit wins" filter is built on `commitNumber`.

## Conclusion / decision

- Mapping rules: CREATE/UNDELETE apply all present mapped fields (UNDELETE re-activates);
  UPDATE applies only mapped fields named in `changedFields` (nulls clear optional columns, and a
  cleared required column is an unmappable change); DELETE archives the party, contact or product
  (nothing is deleted, directive 6).
- Compound fields are read through dotted paths with a flat-name fallback.
- One processed-change row per (company, entity, record id, commit number, sequence number) in
  migration 0050; a second delivery of the same key is logged as a duplicate on that row.
- Order: replay-id order; staleness across sources (reconcile vs. CDC) is left to the reconcile
  job, which reads current state.

## Confidence

Medium-high for S1, S3 and S4 (consistent extracts of the official guide; the delete-body wording
varies between releases, but every version agrees there are no usable values). Medium for the
exact nested component names per object: no `GetSchema` response could be recorded without an
org. The field map is data, so a recorded schema can correct it without code changes.

## Follow-ups

- Scratch-org spike (RQ-0036 follow-up): record `AccountChangeEvent`, `ContactChangeEvent` and
  `Product2ChangeEvent` schemas and one UPDATE with a compound-field change into
  `fixtures/recorded/`, and confirm the component names used by the field map.

**Affects:** `packages/connectors/salesforce/src/inbound/`, migration 0050, design §5.5, §5.6
rule 1, ADR-0006.
