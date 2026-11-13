---
adr: 0057
title: "Batch billing responses carry the batch status and each item's result"
status: Proposed
date: 2026-11-13
author: claude
category: architecture
human_gate: no
supersedes: none
superseded_by: none
---

# ADR-0057: Batch billing responses carry the batch status and each item's result

## Status
Proposed. It becomes Accepted on green CI plus cross-review by codex. The category is
architecture (a public API change). It only adds response fields to existing routes and adds no
permission, table, migration or dependency, so it has no human gate.

## Context and problem statement
The batch screen (T-0084, UC-02, SS-UC02-08) must show the preview totals and the exception
list, both before the run (warnings) and after the job ran (invoices that failed, with the
reason). It must also not offer Approve on a batch that is already approved. The routes from
T-0043/T-0044 (`POST /ar/batches/preview`, `GET /ar/batches/:id`,
`POST /ar/batches/:id/approve`) returned only the stored preview. They did not return the batch
status or the per-item outcome, although `@ledgerforce/ar` already records both
(`app.billing_batch.status`, and `batchSummary` reads the item results written by `runBatch`).

## Decision
All three routes return the same view, with these fields added:

| Field | Meaning |
|---|---|
| `status` | `preview`, `approved`, `posted` or `cancelled`, from `app.billing_batch.status` |
| `items[].status` | `preview` until the job ran, then `posted` or `failed` |
| `items[].invoice_no` | the posted invoice number, else `null` |
| `items[].failure_code`, `items[].failure_message` | why the item failed (for example `INVALID_PARTY`), else `null` |
| `outcome` | `{posted, failed, posted_gross}`; `posted_gross` is a decimal string |

`loadBatchPreview` now reads `status`. The approve route used to override the status with a
literal `'approved'`; it now returns what is stored, which is `approved`. All existing fields are
unchanged, so existing clients keep working.

## Considered options
1. Additive fields on the existing routes (chosen). One read gives the screen everything.
2. A separate `GET /ar/batches/:id/results` route. Rejected: two round trips and two shapes for
   one screen, for no access difference (both are `ar.read`).
3. Deriving the outcome in the browser from the invoice list. Rejected: the browser must not
   compute accounting state (apps/web/AGENTS.md), and failures are not invoices.

## Consequences
- The web batch screen shows the exception list before and after the run from one read.
- Covered by `apps/api/src/ar/batches.db.test.ts` (SS-UC02-08: real run with one archived party,
  one item posted with its number and one failed with `INVALID_PARTY`).
- No change to permissions, idempotency or audit.

## Links
- Task T-0084; decision DL-0430; related ADR-0023 (role templates); T-0043, T-0044.
