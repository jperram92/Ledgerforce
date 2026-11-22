---
adr: 0099
title: "Bills inbox SaaS transport: signed Mailgun inbound webhook, single-use tokens, routing by random inbound address"
status: Accepted
date: 2026-11-22
author: claude
category: security
human_gate: yes (delegated, DL-0691)
supersedes: none
superseded_by: none
---

# ADR-0099: Bills inbox SaaS transport — signed Mailgun inbound webhook, single-use tokens, routing by random inbound address

## Status

Accepted 2026-11-22 by the building agent under the product owner's standing instruction DL-0691
(security decisions delegated on condition of research, a decision-log entry and tests):
research RQ-0181 (re-reading RQ-0177 F4), decisions DL-0860..DL-0864, tests listed below.

## Context and problem statement

UC-05 on the hosted SaaS: supplier bills arrive at a mail provider, which POSTs each message to
LedgerForce (RQ-0177 F4). The endpoint is public — no session, no tenant in the URL — so its
authenticity check, replay protection, tenant routing and resource limits are its entire
security model. Mailgun routes `forward()` is the first provider (RQ-0177 conclusion). Its
signature covers only `timestamp ‖ token`, **not the message or the recipient** (RQ-0181 F1).

## Decision drivers

- Nothing is parsed (MIME) or stored before the request is authenticated, fresh and not a replay.
- No tenant id is ever taken from a payload; routing needs a secret-grade per-company value.
- An unsigned caller learns nothing (no tenant, no token existence); a signed caller learns only
  "unknown recipient".
- A genuine Mailgun retry is never lost because of our own replay guard.
- Bounded memory per request; no new runtime dependency (AGENTS.md §4).
- No secret or message content in logs or error bodies.

## Considered options

1. **Basic credentials in the forward URL** (how Rails handles Postmark/SendGrid). Rejected for
   Mailgun: it offers a real signature; Basic is a static bearer secret in provider config.
2. **Per-company forward URL with a path token** (one Mailgun route per company). Rejected: one
   provider route per tenant does not scale and leaks provisioning into the provider account.
3. **Deployment-level signing key + routing by a random per-company inbound address (chosen).**
   One catch-all Mailgun route for the inbound domain forwards to
   `POST /webhooks/mailgun/messages.mime`; the company is found from the recipient's random
   token through a narrow SECURITY DEFINER lookup.

Body parsing: Node's `Response.formData()` (decodes text fields as UTF-8, corrupting 8-bit
MIME), busboy/multer (transitive only; would become a direct runtime dependency), or **an
in-house RFC 7578 parser over bytes (chosen, ~100 lines, octet-exact, bounded)**.

## Decision outcome

1. **Order of checks** (each refuses before the next runs): `/webhooks/*` rate limit (ADR-0054)
   → configured, else 503 → `multipart/form-data`, else 415 → at most 26 MiB by `Content-Length`
   and by count, else 413, read by a route-scoped reader before any parser → form parse with at
   most 32 parts and 8 KiB of part headers; exactly one `timestamp`, `token`, `signature`, else
   400 → signature, else 401 → timestamp within ±300 s, else 401 → route shape (`body-mime`
   present, no `attachments`), else 406 → recipient routing, else 406 → replay record, else 406
   → MIME parse and ingest.
2. **Signature.** hex HMAC-SHA256(signing key, `timestamp ‖ token`) compared with
   `timingSafeEqual` against every configured key (several during a key roll). Keys come from
   `LF_MAILGUN_SIGNING_KEY[_FILE]` only. Token: 1–256 characters `[A-Za-z0-9]`; timestamp: 1–12
   digits.
3. **Single-use tokens.** `app.inbound_webhook_receipt (provider, provider_token)` has a global
   unique key and is written **in the ingest transaction**, before `ingestBillEmail` runs. A
   committed token refuses every later request with 406 `replayed` (Mailgun never retries a
   406), from any tenant — the unique index holds across RLS. A failed ingest rolls the token
   back, so a genuine retry that reuses it still lands. Rows are never deleted (directive 6);
   one row per accepted delivery, linked to its inbox item.
4. **Tenant routing.** `app.bill_inbox_address` gives each company one active random token
   (26 characters base32, 130 bits, `crypto.randomBytes`); its inbound address is
   `bills-<token>@<LF_INBOUND_EMAIL_DOMAIN>`. Rotation supersedes the row (old address stops
   working at once). `app.bill_inbox_route(token)` — SECURITY DEFINER, owned by `lf_migrator`,
   `search_path` pinned, EXECUTE granted to `lf_app` only — returns `(tenant_id, company_id)` of
   an active token of an active tenant, else no row; nothing else is readable through it. The
   recipient must be exactly one address, at the configured domain, with a well-formed token;
   every failure answers the same 406 `unknown_recipient`.
5. **Residual risk (accepted).** The body and recipient are unsigned, so a party that can read a
   genuine request in flight (i.e. break TLS) and beat it to us within 300 s could substitute
   the message. TLS, the single-use token and the window bound this; Mailgun offers nothing
   stronger. If Mailgun re-sent an original timestamp on retries hours later they would be
   refused as stale (no source says it does; RQ-0181 F4) — visible in Mailgun's delivery log.
6. **Content safety.** Unchanged (ADR-0053, ADR-0095 rule 7): only PDFs ≤ 10 MB kept, nothing
   rendered or posted; the message is `ingestBillEmail` input exactly as a poll would supply it.
   An `InboxError` answers 406 and stores nothing.
7. **No secrets in logs.** Error bodies are fixed codes; neither keys, signatures, tokens nor
   message content are logged.

### Consequences

- Good: no new dependency; same authenticity pattern as Stripe (ADR-0049); per-company routing
  needs no provider configuration per tenant; replay table doubles as a delivery audit trail.
- Bad: one row per delivered email forever (small); the Mailgun body is unsigned (residual risk
  above); the inbound address must be shown to the company (settings UI with T-0216).
- Follow-ups: T-0223 (SendGrid Inbound Parse, signed), T-0224 (Postmark Basic + SES via S3/SNS).

## Validation

- `packages/modules/ap/src/inbound-webhook.test.ts` — signature against the recorded vector
  (RQ-0181 X1), wrong key/stale/malformed fields, multipart parser octet-exactness and limits,
  recipient parsing.
- `apps/api/src/ap/bills-inbound-webhook.db.test.ts` — SS-PLAT-167..169: delivery creates one
  inbox item, redelivery adds nothing; unsigned/wrong/stale/replayed refused before storage;
  unknown token refused without tenant detail; oversize refused with 413; rate-limit class.
- `packages/db/src/rls.db.test.ts` — SS-PLAT-170: the route function returns one company for an
  active token and nothing for unknown/superseded tokens; the generated cross-tenant suite
  covers both new tables.

## Links

RQ-0181, RQ-0177, ADR-0049, ADR-0053, ADR-0054, ADR-0095, ADR-0016, DL-0691, T-0215, T-0223,
T-0224, design §6, UC-05.
