---
adr: 0045
title: "Render document PDFs from HTML templates with playwright-core driving headless Chromium"
status: Accepted
date: 2026-11-01
author: claude
category: architecture
human_gate: no
supersedes: none
superseded_by: none
---

# ADR-0045: Render document PDFs from HTML templates with playwright-core

## Status
Accepted 2026-11-13 by the product owner\'s instruction to accept all ADRs within risk (DL-0405); previously Proposed:

Proposed — becomes Accepted on green CI plus cross-review by codex (category architecture, a new
runtime dependency per design §10.6; it does not change the security model — see rules 3–4 — so
no human gate).

## Context and problem statement

T-0041 needs tax-invoice PDFs. Design §7.1: "PDF — HTML templates rendered by headless Chromium —
same template engine as email and previews". The repository already pins Playwright 1.63.0 for
end-to-end tests; nothing in the runtime renders PDFs yet.

## Decision drivers
- One template (HTML) for screen preview, email body and PDF (design §7.1).
- Exact typography for a tax invoice; selectable text (search, accessibility, text extraction).
- No new external service; runs in the self-hosted stack.

## Considered options
1. `playwright-core` (runtime) driving the Chromium build it pins.
2. Puppeteer.
3. A pure-JS PDF writer (pdfkit, pdf-lib) laying out text by hand.
4. An external rendering service (Gotenberg, a SaaS API).

## Decision outcome
Option 1, `playwright-core@1.63.0` — the same version the repository already uses for tests, so
one browser build serves tests and production.

Rules:
1. Templates are data-driven pure functions producing escaped HTML (no template-time code from
   tenants); every interpolated value is HTML-escaped.
2. The renderer receives a complete HTML string: `setContent`, then `page.pdf()` A4 with printed
   backgrounds. No URL is ever navigated to.
3. JavaScript is disabled in the page and every network request is aborted (route handler), so a
   template cannot fetch or execute anything; fonts and images are inline.
4. One browser per renderer instance, closed by the owner; a page per document, closed after
   rendering; a render timeout bounds every document.
5. Shipping Chromium in the worker image (and its effect on the image vulnerability gate) is a
   follow-up card; until then rendering runs where a Playwright browser is installed (CI db job
   installs it).

## Consequences
### Good
- Same HTML for preview, email and PDF; text in the PDF is real text (tested by extraction).
### Bad / accepted trade-offs
- Chromium is large and has its own CVE stream (image scans will show it); memory per render.
### Follow-ups
- Card: Chromium in the worker image, renderer as a worker job (T-0119).

## Compliance and verification
| Check | Where | Gate |
|---|---|---|
| GP-001 invoice PDF text contains number, ABN, GST 125.00, total 1,375.00 | packages/modules/documents/src/invoice-pdf.db.test.ts | db-tests |
| Values are escaped; JS off; network blocked | packages/modules/documents/src/invoice-html.test.ts; pdf.ts | unit |

## Links
- Design §4.3, §7.1. Task T-0041. DL-0269.
