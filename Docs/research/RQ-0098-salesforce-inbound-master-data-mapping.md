---
id: RQ-0098
title: How do Account, Contact and Product2 change events map onto parties, contacts and products idempotently, including partial updates, ordering, delete/undelete and unmapped values?
status: answered
opened: 2026-11-08
resolved: 2026-11-08
opened_by: claude
linked_tasks: [T-0065, T-0066, T-0070]
linked_adrs: [ADR-0006, ADR-0032]
superseded_by:
---

# RQ-0098 — Salesforce inbound master-data mapping (Account / Contact / Product2)

## Question

- **Q1.** What does a CDC change event body contain for CREATE, UPDATE, DELETE and UNDELETE, and
  how are compound fields (Account `BillingAddress`, Contact `Name`) and fields set to null shown?
- **Q2.** What ordering does Salesforce guarantee, and how can the mapper refuse an older change
  that arrives after a newer one (other channel, reconcile/polling replay)?
- **Q3.** What is the idempotency key when the same record state arrives by CDC and by a
  SystemModstamp delta query (T-0066 / T-0070)?
- **Q4.** How are the billing contact roles carried (design §4.2) and how is a multi-select picklist
  encoded?
- **Q5.** What happens to an unmapped picklist value or a value LedgerForce cannot accept (bad ABN,
  empty name, unknown tax code), given design §5.6 rule 2 and the rule "never silently dropped"?
- **Q6.** Where does such a problem go, given that `app.sync_issue` (migration 0030) is keyed on an
  outbox event and a pg-boss dead-letter job?

## Why it matters

T-0065 turns Salesforce-owned master data (design §5.5, ADR-0006 D1) into parties, contacts and
products that invoices (T-0069) and posting-profile resolution (T-0039) depend on. A partial
update read as "every other field is now null" would wipe customer data; a replayed or older event
applied after a newer one would roll a record back; a dropped unmapped value would leave a party
with no posting profile and nobody told.

## Sources consulted

| # | Source | Date | Kind | Finding |
|---|---|---|---|---|
| S1 | https://developer.salesforce.com/docs/platform/change-data-capture/guide/cdc-subscribe-compound-fields.html (via WebSearch extract; direct fetch refused: host not in the session's allowed domains) | 2026-11-08 | primary (extract) | Compound fields (Name, Address) arrive as nested records; changed components are named `Compound.Component` in `changedFields` (e.g. `BillingAddress.Street`). In the documented UPDATE example the other address components are null although unchanged: "don't infer a change from a null value alone — check the header". |
| S2 | https://developer.salesforce.com/docs/platform/pub-sub-api/guide/event-deserialization-considerations.html (via WebSearch extract) | 2026-11-08 | primary (extract) | Pub/Sub header field lists are hex bitmaps over the schema field order; `"<i>-0x.."` entries cover the children of compound field i. When only compound components are nulled, `nulledFields` carries only the compound entry. (Already implemented by T-0064 `bitmapFieldNames`.) |
| S3 | https://trailhead.salesforce.com/content/learn/modules/change-data-capture/learn-change-data-capture-characteristics and …/cdc_subscribe.htm (via WebSearch extract) | 2026-11-08 | primary (extract) | Change types CREATE, UPDATE, DELETE, UNDELETE. "The order of events delivered is based on the order of the corresponding committed transactions." Events of one transaction for several records of one object can be merged into one event with several `recordIds`. No ordering guarantee is stated across channels. |
| S4 | RQ-0036 S7/S8 (this repo) | 2026-10-25 | primary (extract) | Header: `commitNumber` (system change number of the committed transaction, increasing), `commitTimestamp`, `sequenceNumber` (order within the transaction), `transactionKey`; gap events carry record ids and no data. |
| S5 | RQ-0096 S4 (this repo) | 2026-11-08 | primary, not re-read | Account.Type and Product2.Family are org-editable picklists; mapping is tenant data matched exactly on the API value. |
| S6 | Design §4.2, §5.3, §5.5, §5.6; ADR-0006 | 2026-11-08 | primary (project spec) | Account → Party (Customer role): name, addresses, ABN field, currency, type → party profile. Contact (+ AccountContactRelation) → party contact with roles; "a LedgerForce 'Billing Role' multi-select field on Contact" is an allowed source. Product2 → Product, Family → profile, tax code field optional. Idempotency key = record Id + commit number or SystemModstamp; duplicates dropped; failures land in Sync issues. Bank details never come from Salesforce. |
| S7 | Salesforce SOAP/REST API behaviour for multi-select picklists (memory of the Object Reference "Multi-Select Picklist" field type; not re-read today) | 2026-11-08 | secondary (unverified) | A multi-select picklist value is one string with the selected API values separated by `;`. |
| S8 | Salesforce merge behaviour (memory of the CDC guide "Change Events for Merged Records"; not re-read today) | 2026-11-08 | secondary (unverified) | Merging Accounts/Contacts emits DELETE for each losing record and UPDATE for the master. |

## Findings

1. **UPDATE carries only what changed (S1, S2).** The mapper must apply a *patch*: a field is
   written only when it is named in `changedFields` (value from the body) or `nulledFields` (null).
   A null in the body that is not named in either list means "unchanged". CREATE and UNDELETE bodies
   carry the full record (non-null fields), so they are applied as "every non-null body field".
   DELETE carries no field data that matters.
2. **Compound fields** are nested records; their components are named `BillingAddress.Street` etc.
   in the field lists, so the patch works per component.
3. **Ordering (S3, S4).** Within one channel events arrive in commit order. Across channels (an
   Account channel and a Contact channel), from a gap re-read, or from a SystemModstamp delta query
   an older state can arrive after a newer one. `commitNumber` is a system-wide increasing change
   number and `sequenceNumber` orders a transaction's events, so `(commitNumber, sequenceNumber)`
   is a total order per record for CDC. A polled record has no commit number, only
   `SystemModstamp`; it is ordered by time against the stored commit timestamp.
4. **Idempotency (S6, design §5.6 rule 1).** The subscriber already drops a redelivered event by its
   key `cdc:<entity>:<id>:<commit>:<seq>` (T-0064). The mapper keeps its own per-record version
   (commit number, sequence, commit time / SystemModstamp) so the same change replayed by any
   path is a no-op, and an older one is ignored as stale — both are recorded, never silent.
5. **Billing roles (S6, S7).** The standard source the design names that needs no
   AccountContactRelation custom field is a multi-select `LF_Billing_Role__c` on Contact. Values are
   `;`-separated API values. AccountContactRelation.Roles is the alternative source; it is a separate
   CDC entity and is left to a follow-up card.
6. **Unmapped values and invalid data (S6).** A failure here is a *data* problem, not a transient
   one: retrying with backoff does not fix it. Design §5.6 rule 2's end state — a Sync issue with
   error, payload and retry — applies directly. Throwing from the handler would roll back the whole
   batch and block the channel forever (T-0064 commits batch + cursor atomically), so the handler
   must contain the failure to the one record (a savepoint) and record an issue.
7. **Where the issue goes (Q6).** `app.sync_issue` requires an outbox event id and a dead-letter job
   id (migration 0030) — it models *outbound* deliveries. An inbound record problem has neither.
   Changing those columns would need DROP NOT NULL on a merged migration's columns, which the runner
   forbids. A sibling table for inbound record issues, with the same status vocabulary, is additive.

## Conclusion / decision

- Pure mapping functions per entity turn a change into a *patch* (Findings 1–2); a persistence layer
  applies it inside the subscriber's transaction under a savepoint per record.
- Per-record sync state `app.salesforce_record_sync (company, entity, record id)` holds the last
  applied version: CDC `(commit_number, sequence_number, commit_at)` or polled `SystemModstamp`
  (`commit_at`). Result per record: `applied`, `duplicate` (same version), `stale` (older version),
  `issue` (not applied, issue raised). Delete → archive (status `archived`); undelete → active.
  Nothing is deleted in LedgerForce.
- Account → party with customer role; Type → customer or supplier profile by the mapping table;
  Name, BillingAddress, ShippingAddress, CurrencyIsoCode and `LF_ABN__c` are Salesforce-owned;
  everything else on the party (credit limit, terms, delivery preference, bank details, tax status)
  is LedgerForce-owned and never written by the mapper.
- Contact → party contact under its Account's party; `LF_Billing_Role__c` → contact roles (missing
  roles deactivated). A Contact whose Account is not synced, or that moves to another Account, is an
  issue (not applied).
- Product2 → product; Family → product profile; IsActive false → archived; optional `LF_Tax_Code__c`
  → default tax code.
- Unmapped picklist value: the record **is** applied (Salesforce owns it) with no profile — a gap
  T-0039 will block before posting — and an issue is raised. Invalid data: the record is **not**
  applied and an issue is raised with the payload. An issue is resolved automatically by the next
  clean apply of that record. Issues live in a new `app.salesforce_inbound_issue` (migration 0034);
  surfacing it in the Sync issues inbox API/UI is a follow-up card.

## Confidence

`medium` — the CDC body semantics come from current Salesforce pages read through search extracts
(direct fetch of developer.salesforce.com was refused in this session); the multi-select encoding
and merge behaviour are from memory and not re-read (S7, S8). No org was contacted: fixtures are
*documented*, not recorded. The build hedges: field lists come from the decoded header, not from
null-ness; unknown values are issues, not guesses.

## Follow-ups

- Record redacted Account/Contact/Product2 CDC fixtures from a scratch org (fixtures/recorded/)
  and re-run the contract tests against them; re-read the compound-field page and the
  multi-select format (S7) and merge events (S8) directly.
- AccountContactRelation.Roles as a second billing-role source; PricebookEntry → product price.
- Show `app.salesforce_inbound_issue` in the Sync issues inbox API and UI with a one-click retry
  (re-read the record).

**Affects:** packages/db migration 0034, packages/connectors/salesforce (inbound), T-0066, T-0070
