---
adr: 0048
title: "Stripe Payment Link per invoice and amount due, created at send time by a fetch-based client"
status: Proposed
date: 2026-11-02
author: claude
category: integration
human_gate: no
supersedes: none
superseded_by: none
---

# ADR-0048: Stripe Payment Link per invoice and amount due, created at send time by a fetch-based client

## Status

Proposed — becomes Accepted on green CI plus cross-review by codex (category integration: a new
integration contract and table, design §10.6; no new runtime dependency). The Stripe secret key
stays in the runtime environment (`LF_STRIPE_SECRET_KEY`), as SMTP credentials do (ADR-0046), so
this ADR does not change the security model. Storing a per-company Stripe key (envelope-encrypted,
design §6.6) is a **separate security decision for the product owner** — not taken here.

## Context and problem statement

Design §5.7 and UC-03 (SS-UC03-01): a posted invoice whose payment method is Stripe must carry a
Stripe test-mode payment link for the amount due in its PDF and its email. The billing format
record already says which invoices offer it (`app.billing_format.payment_link = 'stripe'`,
migration 0036). [RQ-0115](../research/RQ-0115-stripe-invoice-payment-link.md) compared Stripe's
options; T-0074 (webhooks) needs to tie a payment back to the invoice.

## Decision drivers

- The link printed on an emailed invoice must still work at the due date (7–30 days later).
- Exact amount due, payable once; a changed amount must not stay payable at the old figure.
- LedgerForce is the invoice of record (RQ-0010 D1); no second invoice in Stripe.
- Posting must never wait on an external API.
- Retries (outbox redelivery, rolled-back transactions) must not create duplicate links.
- Avoid new runtime dependencies where a small client will do (design §10.6).

## Considered options

1. **Checkout Session per invoice** (RQ-0010) — exact amount and `client_reference_id`, but
   `expires_at` is at most 24 h after creation (RQ-0115 S1, S2): the emailed link dies first.
2. **Stripe hosted invoice (Stripe Invoicing)** — a second invoice of record with its own numbering,
   tax and PDF; extra fees. Rejected.
3. **Payment Link per invoice and amount due** (chosen) — no expiry, inline `price_data` for the
   exact cents, `restrictions.completed_sessions.limit = 1`, deactivatable, metadata copied to the
   Checkout Session and PaymentIntent (RQ-0115 S3, S4).
4. Client: **official `stripe` SDK** (new runtime dependency, broad surface) vs **fetch-based
   client** (two endpoints, form encoding, ~150 lines, same pattern as the Salesforce token client).
   Chosen: fetch-based.
5. Timing: **create at posting** (in the posting transaction: posting depends on Stripe uptime;
   amount fixed at posting) vs **create when rendered for sending** (chosen: amount due read at send
   time; posting unaffected).

## Decision outcome

Chosen: option 3 with a fetch-based client, created at send time. Rules:

1. `@ledgerforce/connector-stripe` owns the client (`StripeClient`) and `ensureInvoicePaymentLink`.
   No module calls Stripe directly; documents and email depend only on the
   `InvoicePaymentLinkProvider` port in `@ledgerforce/documents`.
2. Only invoices whose billing format's `payment_link` is `stripe` get a link; drafts never do.
3. Amount due = the invoice's AR open item (`app.subledger_entry.open_amount`, control role
   `AR_CONTROL`); nothing due → no link. Amount in integer cents from decimal.js, never a float.
4. Create: `POST /v1/payment_links`, `Stripe-Version: 2026-10-28.endive`, inline `price_data`
   (`currency`, `unit_amount`, `product_data.name = "Invoice <no>"`), quantity 1,
   `restrictions[completed_sessions][limit]=1`, `inactive_message`, and `metadata` +
   `payment_intent_data[metadata]` = `lf_tenant_id`, `lf_company_id`, `lf_invoice_id`,
   `lf_invoice_no` (no personal data). `Idempotency-Key: lf-plink-v1-<invoice id>-<cents>`.
5. Store each link in `app.stripe_payment_link` (migration 0048 on this branch; reserved 0049):
   at most one `active` per invoice (partial unique index); reuse it while the amount due is
   unchanged; when it changes, `POST /v1/payment_links/<id>` `active=false` (key
   `lf-plink-off-v1-<id>`), mark the row `deactivated`, then create a new one. Rows are never deleted.
6. Test mode by default: the key prefix must match the mode (`sk_test_`/`rk_test_` unless
   `LF_STRIPE_MODE=live`), and a response whose `livemode` differs is refused. The key never
   appears in errors or logs; https only (http on loopback for the test stub).
7. The `ar.invoice.posted` email handler calls the provider after its dedupe check, so a redelivered
   event never calls Stripe again.

## Consequences

- Good: links stay valid until paid or replaced; exact amount; T-0074 gets `lf_invoice_id` on the
  Checkout Session and PaymentIntent; no new runtime dependency; posting unaffected by Stripe outages.
- Bad: the Stripe call runs inside the outbox handler's DB transaction (as SMTP does, ADR-0046); a
  rollback after the call leaves a link in Stripe that the retry reuses within 24 h (idempotency) —
  later than that, an orphan unused link is possible (never sent to a customer).
- Bad: an outstanding link is only deactivated when the invoice is next rendered; a credit note or
  receipt does not yet deactivate it eagerly (follow-up card), though `completed_sessions.limit=1`
  caps it at one payment and T-0074 must handle an over-payment.
- The contract fixture is built from the documented object shape, not a live recording (RQ-0115).

## Compliance and verification

| Rule | Enforced by |
|---|---|
| 1, 4, 6 | `packages/connectors/stripe/src/client.contract.test.ts` (fixture-replaying stub fails on any drift in path, form, headers, key mode) |
| 2, 3, 5, 7 | `packages/connectors/stripe/src/stripe-link.contract.db.test.ts` (SS-UC03-01) |
| 5 (RLS) | `packages/db/src/rls.db.test.ts` cross-tenant suite |
| No float money | lint rule (AGENTS.md §4) |

## Links

- [RQ-0115](../research/RQ-0115-stripe-invoice-payment-link.md), [RQ-0010](../research/RQ-0010-stripe-and-peppol-mvp.md)
- ADR-0045 (PDF), ADR-0046 (email), T-0073, T-0074, design §5.7, §6.6, UC-03
