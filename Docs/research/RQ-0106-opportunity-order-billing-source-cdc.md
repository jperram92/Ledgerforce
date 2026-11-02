---
id: RQ-0106
title: Opportunity / Order as an invoice trigger — CDC and polling fields, Closed Won (IsWon / StageName), Order activation (StatusCode), line items, completeness and the §11.2 default
status: resolved
opened: 2026-11-02
resolved: 2026-11-02
opened_by: claude
linked_tasks: [T-0069]
linked_adrs: [ADR-0006, ADR-0032]
superseded_by:
---

# RQ-0106 — Opportunity / Order as the UC-01 billing source

## Question

Q1. Do Opportunity, OpportunityLineItem, Order and OrderItem publish change events, so they can
flow through the same inbound path as Account/Contact/Product2 (T-0065) and the polling fallback
(T-0066)?
Q2. How does LedgerForce recognise "Closed Won" from a change: `StageName`, `IsWon`, or both? Is
`IsWon` reliably present in an UPDATE change event when only the stage was edited?
Q3. How is "Order activated" recognised (`Status` vs `StatusCode`)?
Q4. Line items arrive as separate change events (possibly before or after the parent's Closed Won
change). How does LedgerForce know it holds *all* lines before it drafts an invoice?
Q5. Which line fields become invoice lines (quantity, unit price, total, discount) without
floating-point money?
Q6. §11.2 open decision "invoice trigger default": what do we build until the product owner decides?

## Why it matters

UC-01 main flow 1–4 and A3/A4. A missed won signal never invoices; a draft created before the
last line arrives under-bills; a double signal (CDC + poll, or redelivery) double-bills.

## Sources consulted

`developer.salesforce.com` pages were read through WebSearch result extracts (direct fetch is
DNS-blocked in this sandbox, as for RQ-0101 and RQ-0103).

| # | Source | Accessed | Kind | What it says |
|---|---|---|---|---|
| S1 | Salesforce Object Reference — "Associated Objects (Change Event)" `sforce_api_associated_objects_change_event.htm` (API 252–264) | 2026-11-02 | official | Opportunity, OpportunityLineItem, Order and OrderItem are listed as objects with change events (`<Object>ChangeEvent`). |
| S2 | Salesforce Field Reference — OpportunityChangeEvent `salesforce_field_reference_OpportunityChangeEvent.htm` | 2026-11-02 | official | The change event carries `StageName` (picklist), `IsClosed` and `IsWon` (boolean), `CloseDate`, `Amount`, `AccountId`. |
| S3 | Change Data Capture Developer Guide — event body / `changedFields` (via Workato CDC doc quoting it) | 2026-11-02 | official (quoted) | UPDATE bodies carry only changed fields (plus LastModifiedDate); `changedFields` empty for CREATE; fields the subscribing user cannot see are omitted. |
| S4 | Object Reference — OpportunityStage | 2026-11-02 | official | Each stage value carries `IsClosed`/`IsWon`; several stage values may represent a won opportunity. |
| S5 | Object Reference — Order `sforce_api_objects_order.htm` | 2026-11-02 | official | `StatusCode` is one of two categories, Draft or Activated; `Status` picklist values map into them; orders are created Draft; `EffectiveDate` (Order Start Date); `TotalAmount` currency; `ActivatedDate`. |
| S6 | Object Reference — OpportunityLineItem `sforce_api_objects_opportunitylineitem.htm` | 2026-11-02 | official | `OpportunityId`, `Product2Id` (read-only since API 30.0), `Quantity`, `UnitPrice`, `TotalPrice` (derived from unit price × quantity, less discount); creating a line adds its TotalPrice to the parent Opportunity Amount. |
| S7 | Pub/Sub API Avro schemas (RQ-0101 S-rows) | 2026-11-02 | official | Currency and double fields are Avro `double`; dates are epoch days or ISO strings depending on schema version. |
| S8 | Design §4.3 (billing formats), §5.5, §5.6, §11.2; UC-01; billing-format catalogue `AU_BILLING_FORMATS` | 2026-11-02 | internal | STANDARD format: line source `opportunity_line_items`, per Opportunity, exclusive; §11.2 trigger default undecided. |

## Findings

1. **All four objects publish CDC** (S1) and are queryable, so they join `INBOUND_FIELD_MAP`:
   the processed-change row (migration 0050) keys them by record Id + commit number + sequence
   number, and the poller (migration 0051) selects exactly the mapped fields — CDC and polled rows
   converge by the existing timestamp rule (RQ-0103 finding 7).
2. **Won is a property of the stage** (S4): `IsWon` is derived from the `StageName` value's stage
   definition. The change event carries both (S2), but whether `IsWon` is listed in
   `changedFields` of a stage-only edit is not documented (S3 only guarantees changed fields), and
   field-level security can hide it. Rule adopted: the mirror keeps `is_won` when the change
   carries it; a `StageName` change without `IsWon` resets `is_won` to unknown; won =
   `coalesce(is_won, StageName ∈ tenant won stages)` with default won stages `{Closed Won}` (data).
3. **Order activation** (S5): `StatusCode = 'Activated'` (some APIs expose the code letter `A`)
   is authoritative; a `Status` change without `StatusCode` resets the code to unknown and falls
   back to `Status = 'Activated'`.
4. **Completeness** (S6): Opportunity `Amount` is the sum of its line `TotalPrice`s when it has
   products; Order `TotalAmount` likewise for OrderItems (S5). LedgerForce drafts only when the
   mirrored, active lines' `TotalPrice` sum equals the header amount (and there is at least one
   line); otherwise it waits — the next line or header change re-checks. No timer, no extra API
   call, and order of arrival does not matter.
5. **Line values** (S6, S7): CDC currency/quantity values are Avro doubles and REST JSON numbers.
   They are converted once at the boundary to their shortest decimal string (`String(v)`) and
   then only `decimal.js` is used. A line whose `TotalPrice` equals `Quantity × UnitPrice`
   rounded to cents becomes (quantity, unit price); a discounted line (they differ) becomes
   quantity 1 at its `TotalPrice` with the quantity and list price kept in the description, so the
   invoice equals what Salesforce sold to the cent.
6. **Trigger default** (S8): until §11.2 is decided, both triggers are built behind a per-company
   setting `invoice_trigger` (`opportunity` | `order`), default `opportunity` (card instruction);
   the other object is still mirrored, never invoiced.

## Conclusion / decision

Mirror Opportunity/Order headers and their line items (migration 0052) through
`applyInboundChange`; after each applied change of the configured trigger object or its lines,
evaluate the mirror: won/activated + complete + no invoice yet → resolve the document date with
the tenant lock-date policy (`resolvePostingDate`, `ar_invoice`), map lines through the tenant's
billing format (line source `opportunity_line_items` / `order_items`), and call
`createDraftInvoice` with source key `salesforce:<Object>:<Id>` (unique per company, so at most
one invoice per record even across sources). Auto-approval stays in AR (`ar_settings`).

## Confidence

High for S1, S5, S6 (official, stable across versions). Medium for finding 2 (the `IsWon`
presence in `changedFields` is undocumented; the rule does not depend on it).

## Follow-ups

- Scratch-org spike (RQ-0036 follow-up): record an OpportunityChangeEvent for a stage change into
  `fixtures/recorded/` and confirm whether `IsWon` is in `changedFields`.
- §11.2 decision by the product owner (trigger default) — the setting exists either way.
- Opportunity changes after the invoice (amendments) → credit note / re-bill flow (later task).

**Affects:** `packages/connectors/salesforce/src/inbound/`, `src/billing/`, migration 0052, UC-01.
