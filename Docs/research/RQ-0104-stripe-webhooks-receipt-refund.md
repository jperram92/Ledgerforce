---
id: RQ-0104
title: How are Stripe webhooks verified, de-duplicated and routed to a tenant, which event posts GP-003, and how is a refund sent?
status: answered   # open | answered | answered-pending-human | superseded
opened: 2026-11-02
resolved: 2026-11-02
opened_by: claude
linked_tasks: [T-0074]
linked_adrs: [ADR-0048, ADR-0049]
---

# RQ-0104 — Stripe webhooks: signature, replay, tenancy, GP-003 trigger and refunds

## Question

T-0074 (design §6.9 "signed and replay-protected webhooks", §3.8 row 3, §5.7; UC-03, UC-11).
The card's open questions point at postings Q1/Q2 — both already answered (receipt at charge, fee
at payout; clearing and fee accounts are Stripe connector settings, not system roles). The build
needs these facts first:

- Q1. Exactly how is a Stripe webhook signed, and what must the receiver check?
- Q2. How are replays and duplicate deliveries handled?
- Q3. Which event posts the GP-003 receipt, and which fields carry amount, currency and the invoice?
- Q4. An unauthenticated POST must reach one tenant: how is the tenant chosen safely?
- Q5. How is a Stripe refund (SS-UC11-04, GP-006 Stripe variant) requested?
- Q6. How do comparable systems behave?

## Why it matters

A forged or replayed webhook would post a receipt and mark an invoice Paid that was never paid
(ledger integrity, AR misstatement). A dropped or doubled event would leave the invoice unpaid or
post the receipt twice. The tenant chosen for an unauthenticated request decides whose ledger is
written.

## Sources consulted

`docs.stripe.com` is outside this session's allowed network (WebFetch: `ENOTFOUND
docs.stripe.com`, as in RQ-0100). The primary source is therefore Stripe's official Node SDK
source and its types generated from Stripe's OpenAPI spec (`npm pack stripe@23.1.0`,
`OPENAPI_VERSION v2596`), unpacked into a scratch directory and only read (never installed).

| # | Source | Accessed | Kind | What it says |
|---|---|---|---|---|
| S1 | `stripe@23.1.0` `cjs/Webhooks.js` (`signature.verifyHeader`, `parseHeader`, `validateComputedSignature`, `prepareOptions`) | 2026-11-02 | source code | `DEFAULT_TOLERANCE: 300`; `EXPECTED_SCHEME: 'v1'`; the signed payload is `` `${details.timestamp}.${payload}` `` over the raw body; the header is split on `,` into `k=v` pairs, `t` is the timestamp and every `v1` value is a candidate signature (several are allowed); "No signatures found with expected scheme" when none; the event is accepted if **any** v1 equals the expected HMAC (`secureCompare`); then `timestampAge = floor(now/1000) − t` and "Timestamp outside the tolerance zone" if `tolerance > 0 && timestampAge > tolerance`. Test headers are generated as `t=<ts>,v1=<hex>`. |
| S2 | `stripe@23.1.0` `cjs/crypto/NodeCryptoProvider.js` + `platform/NodePlatformFunctions.js` (`secureCompare`) | 2026-11-02 | source code | HMAC-SHA256 keyed by the endpoint secret, hex digest; comparison returns false on a length mismatch and otherwise uses `crypto.timingSafeEqual` (constant time). |
| S3 | `stripe@23.1.0` `cjs/resources/Events.d.ts` | 2026-11-02 | primary (types from OpenAPI) | Event fields `id`, `object: 'event'`, `api_version`, `created`, `data.object`, `livemode`, `pending_webhooks`, `type`. `payment_intent.succeeded` — "Occurs when a PaymentIntent has successfully completed payment." Event types include `checkout.session.completed`, `charge.succeeded`, `charge.refunded`, `refund.created/updated/failed`. |
| S4 | `stripe@23.1.0` `cjs/resources/PaymentIntents.d.ts` | 2026-11-02 | primary (types) | PaymentIntent `id`, `amount_received: number` ("Amount that this PaymentIntent collects", integer minor units), `currency`, `latest_charge`, `livemode`, `metadata`, `status` ∈ `succeeded`, `processing`, `requires_*`, `canceled`. |
| S5 | `stripe@23.1.0` `cjs/resources/PaymentLinks.d.ts` (see RQ-0100 S3) | 2026-11-02 | primary (types) | `payment_intent_data.metadata` "will declaratively set metadata on Payment Intents generated from this payment link" — T-0073 sets `lf_tenant_id`, `lf_company_id`, `lf_invoice_id`, `lf_invoice_no` there. |
| S6 | `stripe@23.1.0` `cjs/resources/Refunds.d.ts` (`RefundCreateParams`, `Refund`) | 2026-11-02 | primary (types) | `POST /v1/refunds` with `payment_intent` ("The identifier of the PaymentIntent to refund") or `charge`, `amount` (integer cents; omitted = full), `reason` ∈ `duplicate`, `fraudulent`, `requested_by_customer`, `metadata`. Refund object: `id` (`re_…`), `amount`, `currency`, `payment_intent`, `charge`, `status` (string), `metadata`. Writes accept `Idempotency-Key` (RQ-0100 S5). |
| S7 | WebSearch extracts: hookdeck.com "Guide to Stripe Webhooks"; dev.to (A. Cloudstar) "Stripe Webhooks in Production"; fetchsandbox.com "stripe webhook replay stale timestamp" | 2026-11-02 | secondary | Stripe delivers at least once; duplicates and out-of-order delivery happen; dedupe by `event.id` in a table with a unique constraint and answer 2xx on a conflict; non-2xx is retried with backoff for up to three days in live mode; the timestamp check is what stops a captured, validly signed request from being replayed later; frameworks that parse JSON before verification break the signature (raw bytes are needed). |
| S8 | [RQ-0100](RQ-0100-stripe-invoice-payment-link.md), [ADR-0048](../adr/0048-stripe-payment-link-per-invoice.md), `Docs/accounting/postings.md` GP-003, GP-006, Q1, Q2 | 2026-11-02 | internal | GP-003 trigger "webhook `payment_intent.succeeded` / `charge.succeeded`", idempotency key = Stripe event id; receipt into `setting:stripe.clearing_account`; GP-006 Stripe variant credits clearing; the Stripe key is deployment configuration (`LF_STRIPE_SECRET_KEY`). |
| S9 | Xero / QuickBooks Online payment-integration behaviour (RQ-0100 S8 and RQ-0010) | 2026-11-02 | secondary | Card payments taken on an invoice are recorded against that invoice automatically into a clearing ("Stripe") account; fees and the payout settle later. |

## Findings

**Q1 — signature.** `Stripe-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>…][,v0=…]`. Compute
HMAC-SHA256(secret, `t + "." + raw body bytes`) as hex and accept when it equals **any** `v1`
(more than one appears while a secret is being rolled), compared in constant time (S1, S2). The
raw body must be verified before JSON parsing (S7). With several configured secrets (rotation),
try each.

**Q2 — replay and duplicates.** Two separate defences (S1, S7): (a) the timestamp tolerance
(300 s default) stops a captured request being replayed later — we also refuse timestamps more
than 300 s in the **future** (clock skew either way), which is stricter than the SDK; (b) the
event id is stored once (unique key); a second delivery of the same id does nothing and answers
2xx so Stripe stops retrying. Because two *different* events could describe the same payment, the
receipt itself is also keyed by the PaymentIntent id.

**Q3 — event.** `payment_intent.succeeded` (S3, S4) is the event GP-003 names, carries the
Payment Link's `lf_*` metadata (S5), and only fires once the money is collected
(`status = succeeded`, `amount_received` in cents). `checkout.session.completed` can fire with
`payment_status = unpaid` for delayed methods, so it is not used to post. `charge.succeeded`
would duplicate the PaymentIntent event; other events are acknowledged and ignored.

**Q4 — tenant routing.** The Stripe account and its secret key are deployment configuration
(ADR-0048), so Stripe signs every event with the one endpoint secret of that deployment. The safe
default is: one endpoint per deployment, secret(s) from the environment only; the tenant,
company and invoice come from the **signed** `lf_*` metadata that LedgerForce itself set when it
created the Payment Link, and are trusted only after the signature and timestamp pass, and only if
a Payment Link stored under that tenant (RLS) for that invoice exists and the currency and
livemode match. A per-tenant endpoint secret (per-tenant Stripe account / Connect) is a security
decision for the product owner (ADR-0049, Proposed).

**Q5 — refunds.** `POST /v1/refunds` with `payment_intent=pi_…`, `amount=<cents>`,
`reason=requested_by_customer`, `metadata`, and an `Idempotency-Key` (S6). GP-006's Stripe
variant credits Stripe clearing; the refund nets in the next payout (T-0075).

**Q6 — comparable systems.** Xero/QBO record a gateway payment against the invoice into a
clearing account and settle fees at payout (S9) — the same as GP-003 + GP-027.

## Conclusion / decision

- `verifyStripeSignature(rawBody, header, secrets, nowSeconds, tolerance = 300)` in
  `@ledgerforce/connector-stripe`: parse `t`/`v1`, HMAC-SHA256 hex, `timingSafeEqual`, any v1 of
  any configured secret, |now − t| ≤ tolerance; failure → HTTP 400 and nothing is stored.
- Public `POST /webhooks/stripe` (no session), raw body kept by Nest (`rawBody: true`),
  `LF_STRIPE_WEBHOOK_SECRET` (comma-separated for rotation, or `_FILE`); missing → 503.
- `payment_intent.succeeded` with `lf_*` metadata posts GP-003 through `recordReceipt`
  (debit the company's Stripe clearing account from `app.stripe_settings`, credit AR control),
  allocated to the invoice up to its open amount (any excess stays as customer credit).
  `app.stripe_webhook_event` stores each acted-on event id once (UNIQUE); the receipt is keyed
  `stripe:<payment intent id>`. Other events → 200, ignored.
- Refunds: `refundCreditViaStripe` sends `POST /v1/refunds` (`payment_intent`, cents, key
  `lf-refund-v1-<credit note id>-<cents>`) and posts GP-006 Stripe variant.

## Confidence

High for the signature algorithm, tolerance and object shapes (S1–S6 are Stripe's own SDK and
OpenAPI-generated types). Medium for delivery semantics (retry window, ordering) — secondary
extracts only (S7); the design does not depend on their exact values. The refund contract fixture
is built from the documented object shape, not recorded from a live test-mode account.

## Follow-ups

- Rate limiting for public routes (design §6.9) — none exists in the API yet; new card.
- Per-tenant Stripe account / endpoint secret — ADR-0049 owner decision.
- Record real test-mode fixtures (payment_intent.succeeded, refund) when a key is available.
- Deactivate the Payment Link once its invoice is paid (ADR-0048 follow-up).

**Affects:** `packages/connectors/stripe`, `apps/api` (public webhook route), migration 0049.
