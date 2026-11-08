---
adr: 0006
title: "Salesforce is the commercial system of record; field-level ownership table"
status: Proposed
date: 2026-10-24
author: claude
category: integration
human_gate: no
supersedes: none
superseded_by: none
---

# ADR-0006: Salesforce is the commercial system of record; field-level ownership table

## Status

Proposed — design-committed (D1, §5.5). Integration category: becomes Accepted when the
integration contract is implemented in the connector task with green CI and cross-provider
review. Note: the default **invoice trigger** (Opportunity Closed Won vs Order activation) is
an open decision in design §11.2 and is *not* decided here.

## Context and problem statement

Target customers run their business on Salesforce (§1). Customers, contacts, products,
opportunities and orders already live there; posted invoices, payments, journals and the GL
must live in LedgerForce, because "the GL must never be editable from a CRM" (D1). Two-way
sync with shared ownership produces conflicts (who wins when both sides edit a field?), and
Salesforce users can edit any field their profile allows. Sync must be idempotent (principle 4)
and survive outages (§5.6; review checklist §11.3 item 6 asks about a 3-day outage).

## Decision drivers

- One owner per field — no merge logic, no conflicts.
- The GL is never writable from Salesforce.
- Sales reps see financial status in Salesforce without a LedgerForce login (UC-12).
- Idempotent, replayable integration (principle 4, §5.6).
- Bank details never come from Salesforce (fraud control, §4.2, §6.1).

## Considered options

1. **Split ownership by object/field, stored as data: Salesforce owns commercial master data,
   LedgerForce owns financial documents and status; write-back into read-only mirror objects.**
2. **LedgerForce as master for customers too** (Account created/edited in LedgerForce, pushed to SF).
3. **Bidirectional sync with last-writer-wins / conflict resolution per field.**

### Option 1 — Split ownership

- Good, because each field has exactly one writer; conflicts become detectable violations, not
  merges.
- Good, because sales users keep their familiar Salesforce UI for customers and deals.
- Good, because LedgerForce-owned data appears in SF in read-only mirror objects
  (`LF_Invoice__c`, `LF_Payment__c`) and a few Account/Opportunity fields.
- Bad, because a user editing an LF-owned field in SF is overwritten on next write-back
  (logged as a conflict) — must be communicated in the UI/package.

### Option 2 — LedgerForce masters customers

- Good, because finance controls billing data quality.
- Bad, because it fights the customers' existing CRM processes; duplicate entry; adoption killer.

### Option 3 — Bidirectional with conflict resolution

- Good, because maximum flexibility.
- Bad, because conflicts on financial data are unacceptable; last-writer-wins is
  non-deterministic under replay; very hard to test.

## Decision outcome

Chosen option (design-committed): **Option 1**, with the ownership table of design §5.5 as the
initial data:

| Salesforce | LedgerForce | Direction | Owner |
|---|---|---|---|
| Account | Party (Customer role) | SF → LF | Salesforce |
| Contact + AccountContactRelation | Party contact with roles | SF → LF | Salesforce |
| Product2 + PricebookEntry | Product | SF → LF | Salesforce |
| Opportunity + line items | Billing source | SF → LF | Salesforce |
| Order + OrderItem | Billing source | SF → LF | Salesforce |
| LF_Invoice__c | Sales invoice | LF → SF | LedgerForce (read-only mirror) |
| LF_Payment__c | Receipt / allocation | LF → SF | LedgerForce (read-only mirror) |
| Account financial fields (LF_Balance_Due__c, LF_Overdue_Amount__c, LF_Credit_Status__c, LF_Last_Payment_Date__c) | AR summary | LF → SF | LedgerForce |
| Opportunity LF_Invoice_Status__c, LF_Amount_Invoiced__c, LF_Amount_Paid__c | Billing status | LF → SF | LedgerForce |
| Task (optional) | Dunning step | LF → SF | LedgerForce |

Rules:

1. Field-level ownership is stored as **data** (a `field_ownership` table), not hard-coded.
2. Inbound changes to LF-owned fields are ignored; outbound write-back overwrites SF edits to
   LF-owned fields and logs a conflict in the Sync issues inbox.
3. Supplier/employee bank details are never synced from Salesforce.
4. All upserts use external IDs (`LF_Id__c`) so retries are idempotent; inbound messages carry
   idempotency keys (record Id + commit number or SystemModstamp).
5. Nightly reconciliation (§5.3) replays anything missed.

## Consequences

### Good

- No merge logic; ownership violations are observable.
- Satisfies review checklist §11.3 item 5 (no field owned by both).

### Bad / accepted trade-offs

- Users must be told which SF fields are read-only; mirror objects need permission sets and a
  validation rule.
- Customers who want to master parties outside Salesforce need a later extension point.

## Compliance and verification

| Check | Where | Gate |
|---|---|---|
| Ownership table has exactly one owner per (object, field); test fails on duplicates | connector unit test (backlog) | §10.8 gate 2 |
| Replaying any inbound CDC message twice produces no additional rows/postings | connector idempotency test | gate 2 |
| Inbound update to an LF-owned field is ignored and a conflict is logged | connector test | gate 2 |
| Write-back upsert by `LF_Id__c` is idempotent on retry | connector contract test with recorded SF responses | gate 2 |
| UC-01/UC-03/UC-12 success scenarios with Playwright evidence | ADR-0015 | evidence gate |

## Links

- Design: D1, principle 4, §4.2, §5.3–§5.6, §8.2 (UC-01, UC-03, UC-12), §11.2 (invoice trigger), §11.3 items 5–6
- Related ADRs: ADR-0007, ADR-0008
