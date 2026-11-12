---
id: RQ-0135
title: Complete canonical invoice PDF worker delivery
status: open
opened: 2026-11-11
resolved:
opened_by: codex
linked_tasks: [T-0119]
linked_adrs: [ADR-0045, ADR-0053]
superseded_by:
---

# RQ-0135 — Worker PDF delivery

## Question

Which runtime image, durable storage and event handling complete the existing canonical PDF
implementation without rebuilding the interrupted source T-0041 scaffold?

## Inspected evidence

- At cf03cb0, `apps/worker/src/main.ts` starts the outbox worker with an empty HandlerRegistry.
  Its production dependencies do not include documents/email. The worker image inherits the
  Alpine node runtime and installs no Chromium.
- `packages/modules/documents/src/pdf.ts` renders escaped HTML with JavaScript disabled,
  offline context and request abortion. `invoice-pdf.db.test.ts` is exercised by passing CI.
  ADR-0045 remains Proposed; its acceptance requires green CI and cross-review.
- `packages/modules/email/src/invoice-email.ts` already renders and attaches invoice PDFs,
  resolves Billing To/CC and records delivery dedupe keys. It does not persist rendered bytes;
  its documented SMTP send/commit crash window must not be described as exactly-once delivery.
- Migration0045 provides append-only `document_attachment` bytea storage for bills/inbox,
  with tenant RLS and a size limit. Its owner_type CHECK explicitly permits only bill_inbox_item
  and supplier_bill. Invoice persistence therefore needs an additive design; do not drop or
  weaken those constraints. The existing SMTP handler renders within its delivery transaction;
  durable rendering and email retries need separate failure-boundary tests.
- [Playwright Docker documentation](https://playwright.dev/docs/docker), opened2026-11-11:
  browser/runtime versions must match; custom images need browser binaries and OS dependencies.
  The documentation lists supported Ubuntu images and warns about musl distributions. This
  supports investigating a separate Debian worker stage with the pinned browser, not claiming
  that the existing Alpine runtime has been proven compatible. No version upgrade is selected.

## Remaining checks before implementation

1. Compare a pinned-browser Debian worker stage with distribution Chromium; real image scan and
   compose smoke must pass without exceptions or weakened container/security gates.
2. Choose additive invoice-file storage and migration position using the canonical migration map.
   Preserve existing bill/inbox storage and divergent branch histories.
3. Define event order, concurrency/dedupe and retry behavior for rendering, persistence and SMTP.
   Reuse existing invoiceEmailHandler only after its dependencies and failure behavior are proven.
4. Specify document retrieval authorization and the Salesforce PDF link; do not publish tenant
   files through unauthenticated paths. Confirm adjustment-note/statement scope separately.
5. Write failing worker registration, real-PDF persistence and compose tests before runtime code.

Status remains open. These are inspected gaps and investigation options, not acceptance of the
runtime architecture or a completed PDF delivery feature.
