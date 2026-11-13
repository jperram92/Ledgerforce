---
id: RQ-0115
title: Which Stripe object gives each posted invoice a payment link for its exact amount due?
status: answered   # open | answered | answered-pending-human | superseded
opened: 2026-11-02
resolved: 2026-11-02
opened_by: claude
linked_tasks: [T-0073, T-0074]
linked_adrs: [ADR-0048]
---

# RQ-0115 — Stripe payment link per invoice: Payment Link vs Checkout Session vs hosted invoice

## Question

T-0073 open question: "Payment Links vs Checkout Sessions vs hosted invoice".

- Q1. Which Stripe object gives a per-invoice link for the exact amount due?
- Q2. Does the link expire, and how does that fit an emailed invoice due in 7–30 days?
- Q3. What metadata ties the payment back to the LedgerForce invoice for the webhook task (T-0074)?
- Q4. How do idempotency keys work, so a retried outbox handler does not create two links?
- Q5. How is test mode recognised and enforced?
- Q6. How do comparable systems do it?

## Why it matters

UC-03 / design §5.7 ("Stripe: payment links on invoices") and §9 MVP. RQ-0010 (2026-10-24)
recommended a Checkout Session per invoice; a link that dies before the customer opens the email
would make SS-UC03-01 useless in practice, so the expiry must be checked before building.

## Sources consulted

`docs.stripe.com` is outside this session's allowed network (WebFetch: `ENOTFOUND
docs.stripe.com`), so Stripe's pages were read through WebSearch extracts and, as the primary
source for API shapes, through the official SDK's type definitions (generated from Stripe's
OpenAPI spec), unpacked in a scratch directory and read only (`npm pack stripe` → `stripe@23.1.0`,
`OPENAPI_VERSION v2596`, `ApiVersion = "2026-10-28.endive"`).

| # | Source | Accessed | Kind | What it says |
|---|---|---|---|---|
| S1 | `stripe@23.1.0` `cjs/resources/Checkout/Sessions.d.ts` (SessionCreateParams.expires_at) | 2026-11-02 | primary (SDK types from the OpenAPI spec) | "The Epoch time in seconds at which the Checkout Session will expire. It can be anywhere from 30 minutes to 24 hours after Checkout Session creation. By default, this value is 24 hours from creation." `client_reference_id` "can be used to reconcile the Session with your internal systems". |
| S2 | https://docs.stripe.com/payments/checkout/managing-limited-inventory (WebSearch extract) | 2026-11-02 | primary (extract) | `expires_at` must be 30 min – 24 h after now; default 24 h; an expired session's status becomes `expired` and `checkout.session.expired` is sent. |
| S3 | `stripe@23.1.0` `cjs/resources/PaymentLinks.d.ts` (PaymentLink, PaymentLinkCreateParams, PaymentLinkUpdateParams) | 2026-11-02 | primary (SDK types) | No expiry field on a Payment Link; `line_items[].price_data` "Data used to generate a new Price object inline. One of `price` or `price_data` is required" with `currency`, `product_data.name`, `unit_amount` ("A non-negative integer in cents"), `tax_behavior`; `metadata` "will automatically be copied to checkout sessions created by this payment link"; `payment_intent_data.metadata` "will declaratively set metadata on Payment Intents generated from this payment link"; `restrictions.completed_sessions.limit` "The maximum number of checkout sessions that can be completed"; update `active?: boolean` — "If `false`, customers visiting the URL will be shown a page saying that the link has been deactivated"; `inactive_message`; object fields `id`, `url` ("The public URL that can be shared with customers"), `active`, `livemode`. |
| S4 | https://docs.stripe.com/changelog/basil/2025-07-30/ad-hoc-prices-for-payment-links (WebSearch extract) | 2026-11-02 | primary (extract) | Ad-hoc `price_data` on Payment Links added in API 2025-07-30: one request instead of creating a Price and then a Payment Link. |
| S5 | https://docs.stripe.com/api/idempotent_requests ; https://docs.stripe.com/idempotency (WebSearch extract) | 2026-11-02 | primary (extract) | `Idempotency-Key` header, up to 255 characters; keys may be pruned after 24 hours (a reused key after pruning is a new request); same key with different parameters returns an error; avoid personal data in keys. |
| S6 | `stripe@23.1.0` `cjs/RequestSender.js`, `README.md` | 2026-11-02 | source code | The SDK sends `Stripe-Version`, `Idempotency-Key` on POST, form-encodes bodies as `application/x-www-form-urlencoded` with bracketed keys (`line_items[0][price_data][currency]`); test keys look like `sk_test_...`. |
| S7 | https://docs.stripe.com/docs/implementation-guides/billing/testing ; aclarknet "Stripe Test Mode Configuration" (WebSearch extract) | 2026-11-02 | primary + secondary | Test secret keys start `sk_test_`; test and live objects never cross; test-mode Payment Link URLs are `https://buy.stripe.com/test_...`. `livemode: false` on objects in test mode (S3: `livemode: boolean`). |
| S8 | https://www.xero.com/au/campaign/invoice-payments ; https://www.xero.com/my/partnerships/stripe/ (WebSearch extract) | 2026-11-02 | secondary (vendor marketing) | Xero adds a "Pay now" button to every invoice once Stripe is connected; customers pay without a login; the payment reconciles automatically back to the invoice. |
| S9 | [RQ-0010](RQ-0010-stripe-and-peppol-mvp.md) | 2026-11-02 | internal | Earlier choice: Checkout Session per posted invoice; Stripe Invoicing rejected because it creates a second invoice of record (D1: LedgerForce owns invoices). |

## Findings

1. **Checkout Session expires in ≤ 24 h (S1, S2).** It cannot carry an emailed invoice whose due
   date is 7–30 days away: the link in the PDF would be dead before most customers open it. RQ-0010's
   choice is therefore wrong for the emailed link (it remains right for an interactive "pay now"
   click that creates a fresh session on demand).
2. **Payment Link fits (S3, S4).** It has no expiry, accepts an inline `price_data` (so one API call
   gives an exact amount — the amount due, in cents — with no Price/Product housekeeping), can be
   limited to one completed payment (`restrictions.completed_sessions.limit = 1`, so a forwarded
   email cannot be paid twice), and can be deactivated (`active = false`) when the amount due changes
   (credit note, part payment) so a stale amount can no longer be paid.
3. **Hosted invoice (Stripe Invoicing)** would make Stripe a second invoice of record with its own
   numbering, tax and PDF (S9) — rejected again.
4. **Tie-back metadata (S3).** Payment Link `metadata` is copied to every Checkout Session it
   creates, and `payment_intent_data.metadata` lands on the PaymentIntent. Setting both with
   `lf_tenant_id`, `lf_company_id`, `lf_invoice_id`, `lf_invoice_no` lets T-0074's
   `checkout.session.completed` / `payment_intent.succeeded` handler find the invoice without
   parsing descriptions. (Inference: no personal data in metadata.)
5. **Idempotency (S5, S6).** Stripe holds a key for at least 24 h and rejects the same key with
   different parameters. A key derived from the invoice and the amount due
   (`lf-plink-v1-<invoice id>-<amount due cents>`) makes a retried outbox handler (rolled back after
   the API call) get the same link back; a changed amount gets a new key. Beyond 24 h the durable
   guard is LedgerForce's own row (one active link per invoice), which is read first.
6. **Test mode (S3, S7).** The key prefix decides the mode (`sk_test_` / `rk_test_`), and every
   returned object carries `livemode`. Enforce both: refuse a non-test key unless the deployment is
   explicitly configured for live mode, and refuse a response whose `livemode` disagrees.
7. **Comparable systems (S8).** Xero (with Stripe) puts a "Pay now" link on each invoice and in the
   email, payable without a login, reconciled back to the invoice — the same shape as SS-UC03-01.
8. **No SDK needed (S6).** The call is one form-encoded POST with a bearer key and two headers; a
   small fetch-based client (as the Salesforce token client does) avoids a new runtime dependency.

## Conclusion / decision

- Use a **Stripe Payment Link per invoice and amount due**, created with inline `price_data`
  (`currency` = invoice currency lower-case, `unit_amount` = amount due in cents, `product_data.name`
  = "Invoice <no>"), `quantity = 1`, `restrictions[completed_sessions][limit] = 1`, `metadata` and
  `payment_intent_data[metadata]` = `lf_tenant_id`, `lf_company_id`, `lf_invoice_id`,
  `lf_invoice_no`, and `Idempotency-Key: lf-plink-v1-<invoice id>-<cents>`. This supersedes the
  "Checkout Session per invoice" line of RQ-0010's conclusion for the emailed link.
- **Create it when the invoice is rendered for sending** (the `ar.invoice.posted` email handler),
  not inside the posting transaction: posting must never wait on an external API, and the amount due
  is read at send time. Store it in `app.stripe_payment_link` (one active link per invoice) and
  reuse it while the amount due is unchanged.
- Write a fetch-based client in `packages/connectors/stripe` (no SDK); key from the runtime
  environment, never stored by this task (an encrypted per-company Stripe connection is follow-up
  work with a security ADR for the owner).
- Contract test against a local HTTP stub that replays request/response fixtures and asserts the
  request (path, form body, headers) matches.

## Confidence

High for API shapes and the 24 h Checkout limit (S1–S3 are generated from Stripe's OpenAPI spec and
agree with the doc extracts). Medium for behavioural details not in the types (concurrent sessions
near `completed_sessions.limit`). The fixture is built from the documented object shape, not
recorded from a live test-mode account (no Stripe key or network in this session) — replace it with
a real test-mode recording when a key is available.

## Follow-ups

- T-0074: read `metadata.lf_invoice_id` on `checkout.session.completed`; deactivate the link once paid.
- New card: deactivate + replace the link when the amount due changes (credit note, part payment).
- New card: per-company Stripe connection (encrypted secret key, design §6.6) — security ADR, owner gate.
- Record a real test-mode Payment Link create response as the contract fixture.

**Affects:** `packages/connectors/stripe`, `@ledgerforce/documents` (invoice template),
`@ledgerforce/email` (invoice email), migration 0049, T-0074, design §5.7, UC-03.
