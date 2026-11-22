---
id: RQ-0181
title: Mailgun inbound route webhook - signature, replay, payload shape and tenant routing (vendor facts re-read for T-0215)
status: answered
opened: 2026-11-22
resolved: 2026-11-22
opened_by: claude
linked_tasks: [T-0215, T-0223, T-0224]
linked_adrs: [ADR-0099, ADR-0095, ADR-0049, ADR-0016]
superseded_by:
---

# RQ-0181 — Mailgun inbound route webhook: signature, replay, payload shape, tenant routing

## Question

RQ-0177 F4 chose Mailgun routes `forward()` as the first SaaS transport for the bills inbox and
asked T-0215 to re-read the vendor facts it took from search extracts. Sub-questions:

- **Q1** What exactly does Mailgun sign on a route `forward()` POST, with which key, and is the
  message body covered by the signature?
- **Q2** What is the payload shape (content type, field names) when the route forwards raw MIME?
- **Q3** How does Mailgun treat our HTTP status (which codes are retried, which stop retries)?
- **Q4** What replay protection is needed, given what the signature covers, and how must it
  interact with Mailgun's retries so a genuine retry is not lost?
- **Q5** How is a request routed to its tenant without trusting a tenant id from the payload?
- **Q6** Size limits before parsing; how the body is parsed without a new dependency and without
  corrupting 8-bit MIME.
- **Q7** Which of SendGrid Inbound Parse, Postmark and SES+SNS facts can be re-verified now, and
  what is left for follow-up cards?

## Why it matters

Design §6 (security): a public webhook has no session; its authenticity check, replay guard and
tenant routing are its whole security model. UC-05: a lost or duplicated bill email is a lost
or duplicated payable. AGENTS.md §4: no new runtime dependency without an ADR.

## Sources consulted

Network note (2026-11-22): vendor documentation hosts were **not reachable** from this session
(`documentation.mailgun.com`, `www.twilio.com`, `postmarkapp.com`, `docs.aws.amazon.com`: proxy
CONNECT 403 / DNS not resolved, both with `curl` and the web fetcher). GitHub raw content and web
search were reachable. Vendor facts therefore come from (a) open-source production
implementations whose tests use values recorded from the vendor, and (b) web-search extracts of
the vendor pages, marked as such. The one cryptographic fact that matters most (Q1) was
re-verified by computation against an independent recorded test vector (S1, spike X1).

| # | Source (URL or command) | Accessed | Kind | What it says |
|---|---|---|---|---|
| S1 | https://raw.githubusercontent.com/rails/rails/main/actionmailbox/app/controllers/action_mailbox/ingresses/mailgun/inbound_emails_controller.rb and `.../test/controllers/ingresses/mailgun/inbound_emails_controller_test.rb` | 2026-11-22 | source code (production framework) | Inbound route params: `body-mime` (full RFC 822 message), `timestamp` (Unix seconds), `token` (random 50-character string), `signature` = hex HMAC-SHA256 of timestamp concatenated with token, keyed with the Mailgun **Signing key** (Settings → API security); optional `recipient`. Compared with `secure_compare`; timestamp accepted within ±2 minutes. The route must forward to a URL ending `/mime`. The body is kept as binary (`param_encoding … ASCII_8BIT`) because raw MIME can contain non-UTF-8 bytes. Test vector: key `tbsy84uSV1Kt3ZJZELY2TmShPRs91E3yL4tzf96297vBCkDWgL`, timestamp `1539112500`, token `7VwW7k6Ak7zcTwoSoNm7aTtbk1g67MKAnsYLfUB7PdszbgR5Xi`, signature `ef24c5225322217bb065b80bb54eb4f9206d764e3e16abab07f0a64d1cf477cc`. |
| S2 | https://raw.githubusercontent.com/anymail/django-anymail/main/anymail/webhooks/mailgun.py | 2026-11-22 | source code (production library) | Same HMAC over `f"{timestamp}{token}"` with the webhook signing key, constant-time compare. Inbound (route `forward()`) fields are top-level POST fields: `body-mime` when raw MIME was requested, `recipient` (envelope recipient), `sender`, `timestamp`, `token`, `signature`; the presence of `attachments` means the route used `store()` instead of `forward()`; a JSON body means a tracking webhook was pointed at the inbound URL. The token is used as the event id (unique per POST). |
| S3 | https://raw.githubusercontent.com/anymail/django-anymail/main/tests/test_mailgun_inbound.py | 2026-11-22 | source code (tests from recorded payloads) | Inbound route POSTs are `multipart/form-data`; `test_inbound_mime` posts `token`, `timestamp`, `signature`, `recipient`, `sender`, `body-mime`. |
| S4 | Web search "Mailgun routes forward URL ends with mime body-mime 406 Not Acceptable not retry" → extracts of documentation.mailgun.com `receive-forward-store/receive-http`, `webhooks/webhook-retries`, `en/latest/quickstart-receiving.html` | 2026-11-22 | primary (search extract) | "If your forward URL ends in `mime` or `raw-mime` we include a `body-mime` field with the raw MIME content and omit `body-plain` and `body-html`." "A HTTP 406 means the POST is rejected and it will not be retried"; for other failures Mailgun retries for about 8 hours. |
| S5 | Web search "Mailgun webhook signature token timestamp … signing key HMAC" → extracts of documentation.mailgun.com `webhooks/securing-webhooks`, hookdeck.com/webhooks/mailgun/verify | 2026-11-22 | primary (search extract) + secondary | Signature = HMAC-SHA256(webhook signing key, timestamp + token), hex, compare in constant time; the signing key is not the API key; **the event payload is not signed** — the signature proves only that the token and timestamp came from Mailgun. Subaccounts add a `parent-signature` with the primary account's key. No statement found on whether a retry reuses the token/timestamp. |
| S6 | https://raw.githubusercontent.com/anymail/django-anymail/main/anymail/webhooks/sendgrid.py | 2026-11-22 | source code | SendGrid signed webhooks: ECDSA (P-256, SHA-256) over `timestamp + raw body`, headers `X-Twilio-Email-Event-Webhook-Signature` (base64) and `X-Twilio-Email-Event-Webhook-Timestamp`, public key PEM from SendGrid. (Event Webhook; anymail's Inbound Parse view does not verify a signature.) |
| S7 | https://raw.githubusercontent.com/rails/rails/main/actionmailbox/app/controllers/action_mailbox/ingresses/postmark/inbound_emails_controller.rb and `.../sendgrid/inbound_emails_controller.rb` | 2026-11-22 | source code | Rails authenticates Postmark and SendGrid inbound only by HTTP Basic credentials in the URL (warns it is insecure without TLS). Postmark raw message in `RawEmail`, recipient in `OriginalRecipient`; SendGrid raw message in `email`, recipients in JSON `envelope`. |
| S8 | Repository: `packages/connectors/stripe/src/webhook-signature.ts`, `apps/api/src/payments/stripe-webhook.controller.ts`, `apps/api/src/security/rate-limit.ts`, `apps/api/src/security/statement-body.ts`, `packages/db/migrations/0014_auth_oidc.sql` (`tenant_id_for_slug`), `packages/modules/ap/src/inbox.ts` | 2026-11-22 | source code | Existing patterns: verify before parsing, ±300 s, constant time, secrets from configuration only; `/webhooks/*` per-address rate-limit class; route-scoped body reader with its own byte limit (413 before parse); narrow SECURITY DEFINER lookup returning one id; `ingestBillEmail` idempotent per company on Message-ID. |
| S9 | RFC 7578 (multipart/form-data) §4.1–4.2, RFC 2046 §5.1.1 (boundary syntax, CRLF delimiters) | 2026-11-22 (standard text) | primary | A part is `--boundary CRLF headers CRLF CRLF body`, ended by `CRLF --boundary`; the closing delimiter is `--boundary--`; each part has `Content-Disposition: form-data; name="…"`; boundary 1–70 characters. Field values are octets (no charset transform is required). |
| X1 | Spike: `node -e 'require("crypto").createHmac("sha256","tbsy84…L").update("1539112500"+"7VwW7k…Xi").digest("hex")'` | 2026-11-22 | experiment | Output `ef24c5225322217bb065b80bb54eb4f9206d764e3e16abab07f0a64d1cf477cc` — equals the recorded signature of S1. The algorithm is confirmed byte-exactly; the same vector is a unit test of our verifier. |

## Findings

1. **Q1 — signature.** hex HMAC-SHA256(signing key, `timestamp` ‖ `token`), no separator
   (S1, S2, S5, confirmed by X1). The body (`body-mime`, `recipient`) is **not** covered (S5).
   Consequence: a captured (timestamp, token, signature) triple could carry any body; only
   single use of the token, a short timestamp window and TLS bound that. *Inference:* the token
   is unique per POST (S2 uses it as the event id).
2. **Q2 — payload.** `multipart/form-data`, top-level fields (S2, S3); with a forward URL ending
   `mime` the raw message is in `body-mime` (S1, S4). `attachments` present = `store()` route;
   JSON = tracking webhook (S2): both refused as misconfiguration. Raw MIME may contain 8-bit
   bytes, so the field must be kept as octets, not decoded as UTF-8 (S1, S9).
3. **Q3 — status codes.** 2xx = accepted; **406 = rejected, never retried**; anything else is
   retried for about 8 hours (S4). So: 503 when the endpoint is not configured or the database
   fails (Mailgun retries); 406 for a replayed token or an unknown recipient (never useful to
   retry); 401 for a missing, wrong or stale signature (an attacker gains nothing from the
   distinction; a genuine but stale retry keeps being refused, see F4).
4. **Q4 — replay.** Because the body is unsigned (F1), the token must be single-use. Record
   `(provider, token)` with a global unique key **in the same transaction as the ingest**: a
   failed ingest rolls the token back, so a Mailgun retry that reuses it is accepted (S4
   retries); a committed token refuses every later use, from any tenant (unique key holds
   across RLS). The timestamp window is ±300 s (the card; the Stripe endpoint's value; Rails
   uses ±120 s). *Residual risk:* if Mailgun re-sent the original timestamp on retries hours
   later, those retries would be refused as stale; no source says it does (S5), Rails' tighter
   window works in production, and a delivery that keeps failing is visible in Mailgun's logs.
   Recorded in ADR-0099.
5. **Q5 — tenant routing.** The tenant comes from the **recipient address**: each company gets a
   random inbound address token (local part `bills-<token>`, ≥128 bits) at the deployment's
   inbound domain; a narrow SECURITY DEFINER function returns `(tenant_id, company_id)` for an
   active token and nothing else, like `tenant_id_for_slug` (S8). The lookup runs only after the
   signature is verified, so an unsigned caller cannot probe tokens; an unknown token answers the
   same 406 for every case and names no tenant. The recipient must be exactly one address at the
   configured domain. Since the recipient is unsigned (F1), routing still depends on the
   single-use token; a forged request with a fresh signature is impossible without the signing
   key.
6. **Q6 — size and parsing.** Mailgun's inbound ceiling is 25 MB (RQ-0177 S10 neighbourhood;
   RQ-0177 F5 sets a 25 MiB message ceiling for every transport). The endpoint reads at most
   26 MiB (message + form overhead), refusing with 413 from `Content-Length` or the running
   count before anything is parsed (statement-body pattern, S8). The form is parsed by a small
   in-house RFC 7578 parser over bytes (keeps `body-mime` octet-exact; at most 32 parts; part
   headers ≤ 8 KiB) — Node's built-in `Response.formData()` decodes text fields as UTF-8 and
   would corrupt 8-bit MIME; busboy/multer are only transitive and would be a new direct
   dependency (ADR needed). MIME parsing (postal-mime) happens only after signature, timestamp,
   routing and the replay record.
7. **Q7 — other providers.** SendGrid signed webhooks use ECDSA P-256/SHA-256 over
   timestamp ‖ raw body (S6, source code); whether Inbound Parse carries the same headers could
   not be re-read (twilio.com unreachable) → follow-up card **T-0223** (SendGrid Inbound Parse,
   `send_raw`, signed security policy). Postmark inbound remains Basic-auth only (S7), weaker;
   SES needs S3 + SNS X.509 verification → follow-up card **T-0224** (Postmark + SES), both to
   re-read vendor docs when reachable.

## Conclusion / decision

- Build **Mailgun routes `forward()` to `POST /webhooks/mailgun/messages.mime`** completely in
  T-0215; SendGrid → T-0223; Postmark and SES → T-0224.
- Order of checks, each refusing before the next step: rate limit (`webhook` class) → configured
  (503) → content type `multipart/form-data` (415) → size ≤ 26 MiB (413) → form parse, exactly
  one `timestamp`/`token`/`signature` (400) → signature over timestamp‖token with any configured
  signing key, constant time (401) → timestamp within ±300 s (401) → `attachments` field or no
  `body-mime` (406, misconfigured route) → recipient = one `bills-<token>@<inbound domain>` and
  token resolves through `app.bill_inbox_route()` (406) → in one `withTenant` transaction:
  insert `(mailgun, token)` into the replay table (conflict → 406 `replayed`), then
  `ingestBillEmail(body-mime octets)`, then link the receipt to the inbox item → 200
  `{outcome: created | duplicate}`; an `InboxError` answers 406 (never retried, message
  refused) and keeps nothing.
- Migration (reserved 0080): `app.bill_inbox_address` (per-company random token, one active per
  company, supersede to rotate), `app.inbound_webhook_receipt` (replay table, tenant-owned, global
  unique `(provider, provider_token)`), function `app.bill_inbox_route(text)`.
- Configuration: `LF_MAILGUN_SIGNING_KEY[_FILE]` (comma-separated during a roll) and
  `LF_INBOUND_EMAIL_DOMAIN`. Nothing secret or message content is logged.

## Confidence

`high` for the signature algorithm (two independent implementations + reproduced recorded
vector X1) and payload shape (two implementations + recorded-payload tests); `medium` for
Mailgun retry semantics (search extract S4, consistent across two vendor pages); `low` for
whether a Mailgun retry reuses the original timestamp (no source; mitigation recorded).

## Follow-ups

- Re-read documentation.mailgun.com when reachable (retry token/timestamp reuse; recipient field
  for multi-recipient matches) — noted on T-0223.
- T-0223 SendGrid Inbound Parse; T-0224 Postmark (Basic auth, documented as weaker) and SES via
  S3 + SNS.

**Affects:** packages/modules/ap (inbox webhook), apps/api (route, body reader, config),
packages/db migration (reserved 0080), ADR-0099, design §6, UC-05.
