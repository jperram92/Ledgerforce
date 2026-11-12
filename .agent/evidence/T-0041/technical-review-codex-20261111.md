# T-0041 independent technical review follow-up

- Date: 2026-11-11
- Head reviewed: `152594c`
- Reviewer: three independent Codex sub-agents (read-only)
- Builder on card: Codex
- Scope: shared render deadline, cleanup/resource ownership, lifecycle test coverage
- This user-requested Codex review is not cross-provider approval and does not satisfy the configured cross-provider gate.

## Findings

All three reviewers agree the original whole-render timeout defect is resolved: one deadline is created before launch and applied through context/page setup, HTML loading and PDF generation; late contexts are closed; failed launch promises are cleared for retry. No blocking defect in render timeout behavior was found.

Follow-up recommendations were to test a hung `page.pdf()` operation with context cleanup, and verify retry after browser launch failure. Both are covered by the focused tests added in commit `4af1d05` (4/4 pass). One reviewer noted that `PdfRenderer.close()` can wait on an indefinitely pending launch and concurrent `close()`/`render()` ownership is unspecified. This is an operational lifecycle risk outside the per-document render deadline; no failure was reproduced.

## Separate evidence gap

Existing real Chromium/PostgreSQL PDF tests verify PDF bytes and extractable GP-001 text (invoice number, ABN, GST 125.00 and total 1,375.00). They do not show page layout or pagination. Local visual capture was not available during this review: Playwright's expected Chromium binary could not be accessed, Docker daemon was unavailable, and no PDF-to-image utility was found. Do not treat text extraction or an HTML preview as visual PDF evidence.

## Verdict

No blocking renderer defect found in the reviewed timeout repair. Visual PDF evidence, fresh CI on `4af1d05`, and the formal cross-provider gate remain open. T-0041 stays `verifying`.
