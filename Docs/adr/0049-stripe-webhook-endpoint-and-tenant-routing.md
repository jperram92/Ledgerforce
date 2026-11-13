---
adr: 0049
title: "Stripe webhooks: one signed endpoint per deployment, tenant from signed Payment Link metadata"
status: Accepted
date: 2026-11-02
author: claude
category: security
human_gate: yes
supersedes: none
superseded_by: none
---

# ADR-0049: Stripe webhooks — one signed endpoint per deployment, tenant from signed Payment Link metadata

## Status
Accepted 2026-11-13 by the product owner\'s instruction to accept all ADRs within risk (DL-0405); previously Proposed:

Proposed — **security** category: stays Proposed until the product owner accepts it (AGENTS.md §6;
security ADRs are not delegated). T-0074 implements the safe default described here so the build
can proceed; nothing in it widens what an unauthenticated caller can do beyond posting a receipt
for a payment Stripe signed.

## Context and problem statement

Design §6.9 requires "signed and replay-protected webhooks"; UC-03 (SS-UC03-02/05/06) requires a
Stripe payment to post GP-003 against the right invoice exactly once. A webhook is an
unauthenticated POST: there is no session to say which tenant it belongs to. ADR-0048 made the
Stripe secret key deployment configuration (`LF_STRIPE_SECRET_KEY`), so one Stripe account serves
the deployment; a per-company Stripe connection is a separate owner decision.
[RQ-0104](../research/RQ-0104-stripe-webhooks-receipt-refund.md) has the signature scheme.

## Decision drivers

- A forged, altered or replayed request must never post.
- The tenant must be chosen from something an attacker cannot set.
- No secret in the repository; rotation without downtime.
- Stripe retries non-2xx; a malformed-but-signed event must not loop forever.

## Considered options

1. **One endpoint per deployment (`POST /webhooks/stripe`), endpoint secret(s) from the runtime
   environment, tenant/company/invoice from the signed `lf_*` metadata LedgerForce put on the
   Payment Link, cross-checked under RLS against the stored link** (chosen as the default).
2. Per-tenant URL (`/t/:slug/webhooks/stripe`) with a per-tenant endpoint secret stored
   envelope-encrypted (design §6.6) — needs per-tenant Stripe accounts (or Connect) and secret
   storage: the owner's decision, together with the per-company Stripe key (ADR-0048).
3. Per-tenant URL sharing the deployment secret — the slug adds nothing (the secret is shared),
   and a mismatch between slug and metadata would need a third rule. Rejected.

## Decision outcome

Option 1, with these rules:

1. Secrets: `LF_STRIPE_WEBHOOK_SECRET` (`whsec_…`; comma-separated list during rotation) or
   `LF_STRIPE_WEBHOOK_SECRET_FILE`. Absent → the route answers 503 and verifies nothing. Never
   logged, never stored in the database or repository; tests generate their own.
2. The raw request body (`application/json`, within the API's existing JSON body limit — Express's
   100 KiB default; Nest keeps the raw bytes with `rawBody: true`) is verified before it is
   trusted: HMAC-SHA256 over
   `` `${t}.${body}` ``, hex, any `v1` of any configured secret, constant-time compare;
   `|now − t| ≤ 300 s`. Any failure → 400 `{error}` and nothing is read or written.
3. Only after verification are `metadata.lf_tenant_id`, `lf_company_id`, `lf_invoice_id` read.
   The work runs in `withTenant(lf_tenant_id)` as `lf_app` (RLS FORCE); the invoice must have a
   Payment Link stored in that tenant and company, the currency must match the invoice, and the
   event's `livemode` must match the configured Stripe mode. A signed event that fails these
   checks is acknowledged (200 `{ignored: reason}`) and posts nothing — it is ours but not
   actionable, and a non-2xx would only make Stripe retry it for days.
4. Replay: the event id is stored once (`app.stripe_webhook_event`, UNIQUE per tenant); the receipt
   is keyed by the PaymentIntent id. A duplicate answers 200 `{duplicate: true}`.
5. No rate limiter exists in the API yet (design §6.9); verification is a single HMAC per secret
   before any database access. A rate-limit card is raised.

## Consequences

- Good: forged, altered and stale requests are refused before any database access; a tenant can
  only be reached with metadata LedgerForce wrote and Stripe signed; idempotent at two levels.
- Bad: every tenant shares the deployment's Stripe account and endpoint secret — compromise of that
  secret affects all tenants (as the shared secret key already does under ADR-0048).
- To revisit when the owner decides per-company Stripe connections (option 2).

## Compliance and verification

| Rule | Enforced by |
|---|---|
| 2 | `packages/connectors/stripe/src/webhook-signature.test.ts` (SS-UC03-06), `apps/api/src/payments/stripe-webhook.db.test.ts` |
| 3, 4 | `packages/connectors/stripe/src/stripe-webhook.contract.db.test.ts` (SS-UC03-02, SS-UC03-05) |
| 1 | `apps/api/src/config.test.ts` |
| RLS | `packages/db/src/rls.db.test.ts` cross-tenant suite |

## Links

- [RQ-0104](../research/RQ-0104-stripe-webhooks-receipt-refund.md), [ADR-0048](0048-stripe-payment-link-per-invoice.md), design §6.6, §6.9, T-0074
