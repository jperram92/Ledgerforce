# Cross-review T-0041 — FAIL

Reviewer: codex, independent agent `/root/independent_review`. Builder: claude.
Reviewed head: `cf03cb0e44430917355e20f8c88a077780252ecd`. Date: 2026-11-11 Australia/Sydney.
Ordinary cross-provider review; ADR-0052's bounded same-provider exception is not needed here.
Product/state were not changed. This report does not accept ADR-0045 or mark the task done.

## Findings

1. **MAJOR — document timeout is not the promised whole-render bound.**
   `packages/modules/documents/src/pdf.ts:25` awaits browser launch and context creation before
   establishing the supplied timeout. `setContent` then gets the full allowance, followed by
   another full allowance for `pdf()`. Context cleanup is awaited outside both. Consequently
   `timeoutMs` is not the documented upper bound for one document, and ADR-0045 rule4 is not
   implemented as stated. This is a control-flow finding, not a reproduced browser hang or a
   claim that the existing GP-001 PDF test fails. Add tests covering lifecycle stages and
   cleanup, then implement a shared deadline with cancellation/resource ownership appropriate
   to a shared browser. Avoid fixing it with an uncancelled outer Promise.race alone.

2. **MAJOR for public template inputs — integer quantities lose significant zeros.**
   `invoice-html.ts:74` uses `q.replace(/\.?0+$/, '')`; the decimal point is optional, so
   `quantity: '10'` renders as `1`, and `100` also renders as `1`. I reproduced this by importing
   `renderInvoiceHtml` through Node's type stripping and rendering a line with quantity10,
   unit price10 and net100; the captured Qty cell was `1`. The typed model accepts string
   quantities and does not require exactly four fractional digits. The normal PostgreSQL
   NUMERIC text `10.0000` is unaffected, so this is not a demonstrated failure of the existing
   loadInvoiceDocument-to-PDF path. Add regression cases for integer and fractional quantities
   and trim zeros only from the fractional part.

3. **Follow-up robustness concern — failed launch remains cached.**
   `pdf.ts:19` caches the launch promise even when rejected. Subsequent render calls on that
   instance retry the same rejection until the owner invokes close/reset. This is directly
   visible in the code but not independently reproduced with a browser failure. Specify and
   test recovery semantics before the long-lived worker integration; do not assume job retry
   alone recovers a failed renderer instance.

4. **Evidence gap — no visual PDF proof.** The T-0041 evidence directory contains a manifest
   and three test JSON files, but no screenshot of the rendered report. Text extraction proves
   presence of strings, not clipping, pagination or readable layout. Capture visual evidence
   for the invoice report before final acceptance, including a multi-page case if supported.

## What is already implemented and what is separate

The library has a real PostgreSQL invoice loader, escaped HTML templates, billing-format data
and a Chromium PDF renderer. Existing integration tests create/post a real GP-001 invoice,
render a real PDF and extract its text using pdfjs, checking invoice number, ABN, GST125 and
total1375. No posting engine is mocked away for that contract. The no-op document outbox in
that test confines it to document rendering; it does not prove delivery.

The worker registry is currently empty (`apps/worker/src/main.ts:31`). Worker-image Chromium,
idempotent PDF storage, email registration and Salesforce PDF links are explicitly separate
T-0119 work, with open RQ-0135. These deployment gaps are not new evidence that the library
cannot render in a properly provisioned environment. Nor does the library's passing contract
prove a deployed invoice-to-PDF-to-email flow. Credit-note/proforma layout identifiers exist
as template metadata; this review does not certify complete renderers for those layouts.

## Commands and evidence

| Check | Result |
| --- | --- |
| Read card, ADR0045, library, invoice/statement tests, migration0036, manifest, worker registration and T0119 | Completed |
| Standalone Node import/render quantity10 probe | Executed successfully; observed Qty1, confirms finding2 |
| Focused Vitest invoice-html and statement-html tests, sandbox | Startup failed resolving unplugin-swc; no test result |
| Same command with authorized unrestricted retry | Exit0; 2 files, 6/6 tests pass |
| Existing T0041 manifest | Real PDF text-extraction and script-disabled tests reported passed at01cee717d247 |
| Historical run note `.agent/runs/2026-10-31-claude-r01.md:64` | Records prior typecheck repair, then14PASS/0FAIL/2PENDING, not full DoD green |

Focused command: `corepack pnpm exec vitest run --project unit packages/modules/documents/src/invoice-html.test.ts packages/modules/documents/src/statement-html.test.ts`.
I did not independently rerun full verify, full unit/DB/e2e/security suites or Chromium tests
for this review. Existing1292-test DB CI is reported to include invoice-pdf; it does not test
the newly identified timeout/integer-quantity cases. No claim of independent full-run success.

## Checklist

| Item | Result | Reason / evidence |
| --- | --- | --- |
| A1 | unclear | Focused tests passed; no fresh full static commands run by this reviewer |
| A2 | fail | Passing existing tests omit confirmed integer-quantity and render-budget cases |
| A3 | pass | n/a to rendering: no ledger posting changes; loader reads posted values |
| A4 | pass | Rendering consumes GP001 values; no approved golden alteration in reviewed library |
| A5 | pass | Migration0036 enables/forces tenant RLS; billing_format has cross-tenant fixture registration |
| A6 | pass | Migration0036 adds table/column/constraint; no destructive migration operation |
| A7 | unclear | JS disabled, offline context and abort-all routing inspected; no independent image/security run here |
| A8 | pass | Codex reviewing Claude-authored implementation |
| B1 | pass | n/a: renderer does not post; formats stored decimal amounts rather than recomputing GST |
| B2 | pass | No direct ledger writes in documents implementation |
| B3 | pass | No manual-journal/control-account path introduced |
| B4 | pass | Read-only invoice document loading introduces no period-policy changes |
| B5 | pass | No Salesforce field ownership change; future PDF link delivery remains separate |
| B6 | pass | n/a: no Salesforce sync path implemented by this library |
| B7 | pass | n/a: no supplier/payment permission change |
| B8 | pass | billing_format tenant/company constraints and forced RLS present; no role elevation |
| B9 | pass | Card, ADR, DL0269 and follow-up T0119 identify library/delivery boundary |
| B10 | pass | No new Phase1 dependency required for standard invoice rendering |
| B11 | fail | Rendered quantity can misstate public model input; other accounting coverage is outside this library review |
| B12 | unclear | This review does not independently certify tax-invoice legal sufficiency or reverify all jurisdictional source claims |
| C1 | unclear | Historical implementation/test evidence exists; complete RED-before-production sequence not independently established |
| C2 | pass | Inspected focused tests contain no skip/focus or weakened assertions; real PDF contract uses real components |
| C3 | pass | Inspected migration additive; no deletion performed during review |
| C4 | pass | Display uses integer minor units/BigInt; bounded parseInt rounding digits are exact, no float arithmetic on amounts |
| C5 | pass | No journal mutations from this module |
| C6 | pass | No env, security-gate or approved golden edits by reviewed document code |
| C7 | pass | Reviewing canonical feature lineage; no main push or branch mutation performed |
| C8 | pass | Runtime playwright-core dependency has architecture ADR0045; remains Proposed pending successful review |
| C9 | fail | ADR0045's per-document timeout rule is not satisfied by implementation |
| C10 | pass | T0041 has no linked open RQ; openRQ0135 concerns separately scoped deployment/storage |
| C11 | fail | Text reports exist, but required report screenshot/visual evidence is absent |
| C12 | fail | Card checked verify-green despite recorded pending gates; repairs and final verification/review remain |

## Required next actions

Builder: preserve this report, add failing regressions, repair quantity formatting and the
document-timeout contract, address renderer retry ownership in the worker research, and
capture visual evidence. Re-run relevant pure and real PDF tests plus final verification,
then obtain independent review of repairs. Keep T-0119's runtime/storage/delivery work separate
and do not accept ADR0045 or mark T0041 done on this failed review.
