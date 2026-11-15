---
id: RQ-0167
title: Numbering and billing (wizard step 8) and approval amounts (wizard step 10) — what the routes must do, and whether POST /sod/settings needs an Idempotency-Key
status: answered
opened: 2026-11-15
resolved: 2026-11-15
opened_by: claude
linked_tasks: [T-0186, T-0195, T-0196]
linked_adrs: [ADR-0085, ADR-0081, ADR-0071, ADR-0026]
superseded_by:
---

# RQ-0167 — Numbering, billing and approval-amount settings

## Question

T-0186 builds the screens for wizard step 8 (invoice number series, billing formats, brand
colour, default payment terms, accepted payment methods, Stripe clearing account) and step 10
(approval amounts). Its open questions, plus one from T-0176:

- Q1. Number series: does the ledger expose a function to create a series, or does the route need
  one in `packages/ledger`? Which series does step 8 need?
- Q2. Stripe settings: which fields does `app.stripe_settings` need beyond the clearing account,
  and which account may be the clearing account?
- Q3. `POST /sod/settings` takes no Idempotency-Key today (it is state-idempotent). Should the
  screen send one, and should the route require it?
- Q4. What else on step 8 can wait (logo upload, accent colour, Stripe payout accounts)?

## Why it matters

The number series makes tax-invoice numbers; a prefix or width change after a number is issued
would break the sequence (design §3.4). The clearing account receives every Stripe receipt
(GP-003). A mutating route without an idempotency key breaks an apps/api rule.

## Sources consulted

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S1 | `packages/db/migrations/0010_ledger_number_series.sql` | 2026-11-15 | source code | `app.number_series` is owned by `packages/ledger`; lf_app has SELECT, INSERT, UPDATE; a guard trigger refuses a code or company change, lets `next_value` move only by +1, and fixes `prefix` and `pad_width` "once a number was issued" (`next_value > 1`). Nothing is deleted; `status 'archived'` retires a series. |
| S2 | `grep -rn "insertInto('app.number_series')" packages apps` | 2026-11-15 | source code | Only tests and fixtures insert series. `packages/ledger/src/numbering.ts` has `nextNumber` only: no production function creates a series. |
| S3 | `packages/modules/ar/src/invoices.ts` (`INVOICE_NUMBER_SERIES = 'ar_invoice_document'`), `credit-notes.ts` (`CREDIT_NOTE_NUMBER_SERIES = 'ar_credit_note_document'`), `packages/modules/documents/src/billing-formats.ts` | 2026-11-15 | source code | The invoice series code is `ar_invoice_document` (the card's "AR-INV" is a label, not the code). The AU billing-format catalogue names `ar_invoice_document` for invoice formats and `ar_credit_note_document` for credit notes; `seedBillingFormats` adds the catalogue codes a company lacks. |
| S4 | `packages/modules/setup/src/wizard-validators.ts` step 8 | 2026-11-15 | source code | Step 8 needs an active `ar_invoice_document` series, an active billing format, a brand colour, default payment terms, at least one accepted payment method and, when Stripe is accepted, an `app.stripe_settings` row. Step 10 needs an active Owner/Finance Admin and one `app.sod_settings` row. |
| S5 | migrations 0051, 0060; `packages/connectors/stripe/src/webhook.ts` (`setStripeSettings`), `payout.ts` | 2026-11-15 | source code | `stripe_settings` has `clearing_account_id` (NOT NULL) and, since 0060, nullable `fee_account_id`, `payout_account_id`, `stripe_party_id`; the payout handler refuses a payout while any of those is missing. `setStripeSettings` leaves omitted payout fields unchanged. |
| S6 | `Docs/accounting/postings.md` GP-003, chart line 1120 | 2026-11-15 | primary (golden, Approved) | GP-003 debits `setting:stripe.clearing_account` (1120 Stripe clearing), an asset that nets to zero at payout (GP-004/GP-027). |
| S7 | `apps/api/AGENTS.md`; `apps/api/src/settings/settings-common.ts` `requireKey`; DL-0642; RQ-0161 S8; RQ-0162 finding 4 | 2026-11-15 | source code / decision | "Every mutating endpoint requires an idempotency key (design §3.9) and returns the same result on replay." Settings routes require the header (400 `idempotency_key_required`) and are replay-safe by state, with no key table. |
| S8 | `apps/api/src/sod/sod.controller.ts`; callers `grep -rn "sod/settings"` | 2026-11-15 | source code | `POST /sod/settings` requires no key; a repeat of the current values answers 200 and writes nothing. Callers: three api-db test files only (`sod.db.test.ts`, `ap/bills.db.test.ts`, `ar/invoices.db.test.ts`); no web client, no worker, no script. `POST /sod/exceptions/weekly/acknowledge` also has no key and is called by the web admin client. |
| S9 | IETF HTTPAPI WG, "The Idempotency-Key HTTP Header Field" (draft-ietf-httpapi-idempotency-key-header), https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/ — not fetched: the agent proxy refused the host on 2026-11-15; paraphrased from general knowledge of the draft, to be confirmed by the reviewer | 2026-11-15 | standard (draft), unverified this session | A resource may require the header and reject a request that lacks it with 400; a key identifies one request so a retry is not applied twice. |
| S10 | Stripe API reference, "Idempotent requests", https://docs.stripe.com/api/idempotent_requests — as extracted by RQ-0115 S5 on 2026-11-02; not re-fetched | 2026-11-02 | vendor doc (via RQ-0115) | `Idempotency-Key` header on POST requests, up to 255 characters; the same key with different parameters is an error. Stripe accepts the key uniformly on every POST rather than per endpoint. |
| S11 | `packages/modules/ar/src/invoice-settings.ts` | 2026-11-15 | source code | `setInvoiceSettings` patches brand colour (#RRGGBB), accent colour, logo (PNG/JPEG ≤ 512 KiB, magic bytes), terms (0–365 days), methods (bank_transfer, stripe). The logo and accent colour are optional for the wizard. |
| S12 | Design §3.4, §4.1 step 8 and 10, §6.4–6.5, §11.2 | 2026-11-15 | primary (design) | Clean, gapless invoice series; step 8 "invoice numbering, billing formats, branding, payment terms, Stripe"; step 10 "users, roles, approval thresholds"; SoD thresholds are configurable and their values an open decision (DL-0131: placeholders until the owner decides). |

## Findings

1. **Q1.** No production function creates a number series (S2). The table is the ledger's (S1),
   so the function belongs in `packages/ledger` next to `nextNumber`. The guard already allows a
   prefix/width change only while `next_value = 1`; the function should say so before the
   database does (a raised error would abort the request transaction). Step 8 needs only
   `ar_invoice_document` (S4); the AU billing formats also name `ar_credit_note_document` (S3), and
   a credit note cannot be numbered without it, so the screen offers both.
2. **Q2.** Only `clearing_account_id` is needed for step 8 and GP-003 (S4, S6). The payout fields
   are needed for GP-027 payouts only and the connector refuses a payout without them (S5); they
   are a separate screen concern (party picker for the Stripe supplier). The clearing account is
   1120-like: an active, postable asset account that is not a control account (control accounts
   are written only with a sub-ledger party, design §3.2).
3. **Q3.** The apps/api rule (S7) applies to every mutating endpoint, and the route has no callers
   outside tests (S8), so requiring the key now costs three test call sites and no client. The
   draft standard and common practice allow a resource to require the header and answer 400
   without it (S9, S10). The route is already replay-safe by state, so, as for the other settings
   routes (DL-0642), the key is required but not stored: a repeat answers 200 and inserts no new
   settings row. The acknowledge route has a web caller and is not part of this card; it becomes a
   follow-up card (T-0196).
4. **Q4.** Logo upload needs a multipart or base64 body and a preview; accent colour is
   cosmetic; payout accounts need a party picker (finding 2). None is required by step 8 (S4,
   S11). They become follow-up card T-0195.

## Conclusion / decision

1. Add `defineNumberSeries` and `numberSeriesOf` to `packages/ledger/src/numbering.ts`
   (insert, or change prefix/width while no number is issued; 409-type refusal
   `NUMBER_SERIES_IN_USE` afterwards). Routes under `/setup/billing` (ADR-0085), permission
   `settings.setup.manage` for writes and `settings.read` for the read, each write with an
   Idempotency-Key, replay-safe by state, audited when it changes something.
2. The Stripe route sets only the clearing account through `setStripeSettings`; it must be an
   active, postable, non-control asset account of the company (422 `INVALID_CLEARING_ACCOUNT`).
3. `POST /sod/settings` now requires an Idempotency-Key (400 `idempotency_key_required`, checked
   first, nothing written); the approval-amounts screen sends one. Recorded in ADR-0085 and DL-0711.
4. Logo, accent colour and Stripe payout accounts on screen: T-0195. Key on the weekly
   acknowledge route: T-0196.

## Confidence

`high` for Q1, Q2, Q4 (repository code and the Approved golden). `medium-high` for Q3: the
external sources were not fetched this session (proxy refusal; S9 is unverified), but the conclusion rests on the
repository's own rule (S7) and the absence of callers (S8).

## Follow-ups

- ADR-0085, DL-0710 to DL-0714, T-0195, T-0196.

**Affects:** packages/ledger/src/numbering.ts, apps/api/src/settings, apps/api/src/sod, apps/web/src/settings.
