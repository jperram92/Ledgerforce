---
adr: 0100
title: "Invoice logo upload and serving, and Stripe payout settings, under /setup/billing (extends ADR-0085)"
status: Accepted
date: 2026-11-22
author: claude
category: security
human_gate: yes
supersedes: none
superseded_by: none
---

# ADR-0100: Invoice logo upload and serving; Stripe payout settings (extends ADR-0085)

## Status
Accepted under the product owner's standing delegation DL-0691 (security decisions with research
comparing standards and comparable systems, a decision-log entry and tests). Category security
(a user file upload that is stored, served and embedded into customer documents) and public API
(design §10.6). Research: RQ-0182. Recorded in DL-0870. Extends ADR-0085 by this separate record;
ADR-0085 is not edited. No migration, no new permission, no third-party runtime dependency.

## Context and problem statement
Wizard step 8's optional settings — invoice logo, accent colour, Stripe payout accounts — have no
HTTP route or screen (RQ-0167 Q4, T-0195). The logo must travel in a body larger than Nest's
100 kB JSON parser, must be validated by content, should not leak personal metadata into every
invoice, and must be shown back without ever running as active content. The payout accounts
decide where GP-027 posts.

## Decision drivers
- OWASP File Upload: validate by content, size limit, generated name, authorised users,
  CSRF-protected, rewrite images and drop metadata (RQ-0182 S1).
- No new runtime dependency (no multipart parser, no image codec).
- Thin controllers over module functions; every write keyed, replay-safe by state and audited
  once per change (ADR-0085, DL-0642).
- GP-027's journal decides which account kinds the payout fields may name.

## Decision

1. `PUT /setup/billing/logo {company_id, logo: {content_type, content_base64} | null}`
   (settings.setup.manage, Idempotency-Key). A route-scoped JSON reader (the ADR-0078 reader,
   now also for PUT) reads at most **1 MiB** for this path; larger is 413 `payload_too_large`
   before the controller. `content_type` is `image/png` or `image/jpeg`; `content_base64` is
   strict base64. The API cleans the file with `cleanInvoiceLogo` (`@ledgerforce/ar`): a
   structural walk (PNG: signature, chunk lengths and CRC-32, IHDR first, IEND last, nothing
   after; JPEG: SOI, marker segments to SOS, a SOF before SOS, EOI last), dimensions at most
   4,000 × 4,000 px, and metadata dropped (PNG: only IHDR PLTE IDAT IEND tRNS cHRM gAMA iCCP sBIT
   sRGB cICP bKGD pHYs are kept; JPEG: APP1, APP3–APP13, APP15 and COM before SOS are dropped).
   Then `setInvoiceSettings` stores it (its magic-byte and 512 KiB checks still apply).
   `logo: null` removes it. → `{invoice, changed}`. The same cleaned bytes again (SHA-256) answer
   `changed:false` and write no audit row. The audit row has the content type, size and SHA-256,
   never the bytes. Refusals 400 `INVALID_INVOICE_SETTINGS` with a plain message. SVG is refused.
2. `GET /setup/billing/logo?company_id=` (settings.read) answers the stored bytes with the stored
   type (magic bytes re-checked), `Content-Disposition: inline; filename="invoice-logo.png|jpg"`,
   `Content-Security-Policy: default-src 'none'; sandbox`, `Cross-Origin-Resource-Policy:
   same-origin`, plus the global `nosniff` and `no-store`; 404 `LOGO_NOT_SET` when none.
3. `PUT /setup/billing/stripe {company_id, clearing_account_id, fee_account_id?,
   payout_account_id?, stripe_party_id?}`: each payout field, when sent, must be in the matching
   list below (422 `INVALID_FEE_ACCOUNT`, `INVALID_PAYOUT_ACCOUNT`, `INVALID_STRIPE_PARTY`, checked
   before writing). A field not sent is left as it is; a saved payout field cannot be cleared
   (the connector never clears one, and payouts refuse while any is missing). `stripe` in every
   answer is `{clearing_account_id, fee_account_id, payout_account_id, stripe_party_id}` (nulls
   when unset). `changed` and the audit row cover all four fields.
4. `GET /setup/billing` adds `fee_accounts` (active, postable, non-control, debit-normal expense
   accounts), `payout_accounts` (`{id, code, name, bank_account_name}`: the GL accounts of the
   company's active bank accounts in its base currency that are active, postable and not control
   accounts) and `stripe_parties` (`{id, name}`: active parties with an active supplier role).
5. The accent colour is sent on the existing `PUT /setup/billing/invoice` (ADR-0085 item 4).

## Considered options
- multipart/form-data (rejected: needs multer as a direct runtime dependency; base64 JSON is the
  repository's reviewed pattern, ADR-0078, and Odoo's).
- Re-encode the image with sharp/libvips or ImageMagick (rejected: native runtime dependency with
  its own parser CVEs; metadata can be dropped structurally without decoding).
- Accept SVG through a sanitiser (rejected: script/XXE surface, sanitiser bypass history, the
  database CHECK and the invoice renderer accept PNG/JPEG only).
- Serve the logo from a public, unauthenticated URL (rejected: settings are tenant data).
- Let the payout fields be cleared (rejected: the connector cannot clear them and a cleared field
  only makes the next payout fail).

## Consequences
- Positive: the three settings can be set without SQL; uploads are validated by structure, not
  by name; customer invoices no longer carry the uploader's Exif/GPS/XMP; the logo can never be
  served as a document.
- Negative: base64 adds a third to the upload size; Exif orientation is dropped with Exif.
- Follow-up: none required.

## Links
RQ-0182, RQ-0167, ADR-0085, ADR-0078, ADR-0071, ADR-0054, GP-027, T-0195, DL-0870 to DL-0874.
