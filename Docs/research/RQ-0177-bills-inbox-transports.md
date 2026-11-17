---
id: RQ-0177
title: How the bills inbox receives mail - IMAP polling (self-host) and provider inbound webhooks (SaaS)
status: answered
opened: 2026-11-16
resolved: 2026-11-16
opened_by: claude
linked_tasks: [T-0127, T-0215, T-0216]
linked_adrs: [ADR-0095, ADR-0053, ADR-0018]
superseded_by:
---

# RQ-0177 — Bills inbox transports: IMAP polling and provider inbound webhooks

## Question

RQ-0111 settled that every transport feeds `ingestBillEmail(raw RFC 5322 bytes)` (T-0051) and
that IMAP polling is the self-host default and provider webhooks the SaaS path. T-0127 builds the
transports. Open sub-questions:

- **Q1** Which IMAP client: a library (imapflow, node-imap, emailjs-imap-client) or an in-house
  minimal client, given AGENTS.md §4 (a new runtime dependency needs an ADR; prefer none)?
- **Q2** Which IMAP protocol subset is needed to poll a mailbox exactly once per message without
  changing it, and what makes it idempotent across re-polls, crashes and UIDVALIDITY resets?
- **Q3** How do mailbox providers authenticate IMAP today (password, app password, OAuth2
  XOAUTH2), and what must be stored, and how?
- **Q4** Inbound-webhook formats and authenticity for Postmark, SendGrid Inbound Parse, Mailgun
  routes and AWS SES (+SNS): what is signed, what replay protection exists, and how is a request
  routed to its tenant safely?
- **Q5** Size limits, malware / zip-bomb exposure and DMARC/SPF: what must the transport refuse
  or record?
- **Q6** Idempotency key: is Message-ID sufficient?

## Why it matters

Design §6.6 (secrets) and §7.2 (self-host): mailbox credentials are secrets; a careless poller
either double-creates draft bills or silently loses mail; a webhook endpoint is public and
unauthenticated by session, so its authenticity check and tenant routing are the whole security
model. UC-05.

## Sources consulted

Network note: in this session only GitHub and web search were reachable; vendor documentation
hosts (documentation.mailgun.com, postmarkapp.com, twilio.com, docs.aws.amazon.com) did not
resolve, so their facts below come from search-result extracts of those pages (marked
"search extract") and must be re-read when T-0215 is built.

| # | Source | Accessed | Kind | What it says |
|---|---|---|---|---|
| S1 | RFC 3501 (IMAP4rev1) §2.3.1.1 UID / UIDVALIDITY, §6.3.2 EXAMINE, §6.4.4 SEARCH, §6.4.5 FETCH (BODY.PEEK, RFC822.SIZE), §4.3 literals, §9 grammar | 2026-11-16 (standard text) | primary | UIDs are strictly ascending per mailbox and never reused while UIDVALIDITY is unchanged; a changed UIDVALIDITY invalidates every cached UID. EXAMINE opens read-only (no \Seen change, no expunge). BODY.PEEK[] fetches the full message without setting \Seen. RFC822.SIZE is the message size in octets. Strings are atoms, quoted, or literals `{n}CRLF<n octets>`. |
| S2 | RFC 9051 (IMAP4rev2) §6.4.4 / §6.4.9 and Appendix E | 2026-11-16 (standard text) | primary | Same UID model; `n:*` where n exceeds the highest UID still matches the highest-UID message ("*" is the largest number in use), so a client must filter results above its cursor. IMAP4rev2 servers still accept IMAP4rev1 clients. |
| S3 | RFC 8314 §3.3, §4 | 2026-11-16 (standard text) | primary | Mail access should use implicit TLS (IMAP port 993) in preference to STARTTLS; certificate verification required. |
| S4 | https://raw.githubusercontent.com/postalsys/imapflow/master/package.json | 2026-11-16 | source code | imapflow 2.12.1, MIT, runtime dependencies: @zone-eu/mailsplit, encoding-japanese, iconv-lite, libbase64, libmime, libqp, pino, socks (8 direct, more transitive). |
| S5 | github.com/mscdex/node-imap; github.com/emailjs/emailjs-imap-client (repository state, prior knowledge) | 2026-11-16 | secondary | node-imap last released 2017 (unmaintained); emailjs-imap-client archived. Neither is a reasonable new dependency. |
| S6 | learn.microsoft.com "Deprecation of Basic authentication in Exchange Online" (search extract) | 2026-11-16 | primary (extract) | From 2022-10-01 Basic auth is disabled for IMAP/POP in Exchange Online; OAuth 2.0 is supported for IMAP since 2020. |
| S7 | blog.rebex.net "Office 365 and IMAP or POP3 with OAuth 2.0 authentication in unattended (app-only) mode" (search extract) | 2026-11-16 | secondary | App-only IMAP: client-credentials token with scope `https://outlook.office365.com/.default`, then SASL XOAUTH2. A third-party page claims app-only is unsupported; sources disagree, so M365 app-only needs its own check (T-0216). |
| S8 | documentation.mailgun.com "Securing webhooks" (search extract) | 2026-11-16 | primary (extract) | Signature = hex HMAC-SHA256(webhook signing key, timestamp + token); the same check covers Routes `forward()` POSTs (fields top-level in the form); Mailgun recommends caching tokens and refusing repeats, plus a timestamp window. |
| S9 | postmarkapp.com support "attachment and email size limits", Rails ActionMailbox Postmark ingress docs (search extract) | 2026-11-16 | primary (extract) + source code | Postmark inbound has no HMAC signature: it relies on HTTP Basic credentials in the webhook URL (HTTPS required) and optional IP allowlisting; JSON payload, optional `RawEmail` field; inbound size limit 35 MB. |
| S10 | twilio.com SendGrid "Securing your Inbound Parse Webhooks", "Inbound Email Parse Webhook" (search extract) | 2026-11-16 | primary (extract) | Inbound Parse supports ECDSA signature verification (as the Event Webhook: signature and timestamp headers over timestamp + raw body) via a security policy; `send_raw` posts the full MIME; total message limit 30 MB. |
| S11 | docs.aws.amazon.com SES "Publish to Amazon SNS topic action" and S3 action (search extract) | 2026-11-16 | primary (extract) | The SNS action carries the full MIME only up to 150 KB (larger mail bounces); larger mail needs the S3 action. SNS messages are signed (X.509, SignatureVersion 1 SHA1 / 2 SHA256) with a certificate from an `sns.<region>.amazonaws.com` URL; SES receipt notifications carry SPF, DKIM, spam and virus verdicts. |
| S12 | RFC 5322 §3.6.4 | 2026-11-16 (standard text) | primary | Message-ID SHOULD be present and is globally unique per message instance; not guaranteed (may be absent or reused by broken senders). |
| S13 | RFC 7489 (DMARC) §6.6, RFC 7208 (SPF) §2.6, RFC 8601 (Authentication-Results) | 2026-11-16 (standard text) | primary | SPF/DKIM/DMARC are evaluated by the receiving MTA; a downstream consumer only sees the receiver's `Authentication-Results` header, which is trustworthy only when added by the receiver's own authserv-id. |
| S14 | Repository: packages/modules/ap/src/inbox.ts, ADR-0053, ADR-0018, packages/shared/src/crypto/envelope.ts, packages/connectors/stripe/src/webhook-signature.ts, apps/api/src/security/rate-limit.ts, apps/worker/src/daily-jobs.ts | 2026-11-16 | source code | ingestBillEmail is idempotent per company on Message-ID (fallback SHA-256 of the raw message), keeps only PDFs ≤ 10 MB, never posts. Envelope encryption with AAD binding exists. The Stripe webhook pattern (HMAC over raw body, ±300 s window, event-id idempotency, tenant from signed data, `withTenant`) and a per-address `webhook` rate-limit class for `/webhooks/*` exist. Per-tenant jobs are fanned out by the owner-role scheduler. |
| S15 | Experiment: the in-process fake IMAP server and client tests of T-0127 (`imap-client.test.ts`) | 2026-11-16 | experiment | The minimal client completes greeting, LOGIN, EXAMINE, UID SEARCH, UID FETCH (RFC822.SIZE, BODY.PEEK[]) against a server speaking RFC 3501 responses with literals, including the `n:*` edge case of S2. |

## Findings

1. **Q1 — client.** imapflow is the only maintained full-featured Node client (S4, S5), but it
   brings eight direct runtime dependencies (logging, charset conversion, MIME splitting, SOCKS)
   for features the poller does not use: we already parse MIME with postal-mime (ADR-0053), never
   need IDLE, flags, append, move or charset conversion. The poller needs seven commands (F2).
   *Inference:* an in-house client of a few hundred lines over `node:tls` is smaller to audit
   than the dependency tree and fits directive 5 and AGENTS.md §4 ("prefer none").
2. **Q2 — protocol subset and idempotency.** Implicit TLS (S3); greeting; `LOGIN`
   (or `AUTHENTICATE XOAUTH2`, T-0216); `EXAMINE <folder>` (read-only, S1) yields
   `UIDVALIDITY`; `UID SEARCH UID <last+1>:*` (filter results above the cursor, S2);
   `UID FETCH <set> (UID RFC822.SIZE)` to refuse oversize mail before downloading it;
   `UID FETCH <uid> (UID BODY.PEEK[])` (no \Seen change, S1); `LOGOUT`. The mailbox is never
   modified. Per mailbox the poller keeps `(uidvalidity, last_uid)`; ingesting a message and
   advancing `last_uid` commit in one transaction under a row lock, so a crash re-fetches at
   most the message in flight, and Message-ID idempotency (F6) absorbs that and any
   UIDVALIDITY reset (which restarts the cursor at 0).
3. **Q3 — authentication.** Generic hosts and Google (with an app password) accept `LOGIN` over
   TLS; Exchange Online no longer accepts passwords for IMAP (S6) and needs OAuth2 XOAUTH2, with
   conflicting evidence on app-only tokens (S7). The password (or later the OAuth client
   secret) is a secret under design §6.6 and is sealed with the existing envelope encryption
   (ADR-0018), AAD-bound to tenant, company, row and field, never returned by reads.
4. **Q4 — webhooks.** Authenticity differs per provider: Mailgun HMAC over timestamp+token with
   token replay cache (S8); SendGrid ECDSA over timestamp+raw body (S10); SNS X.509 signatures
   with certificate-URL host validation (S11); Postmark only Basic credentials + IP allowlist
   (S9). Common safe shape (same as the Stripe endpoint, S14): verify over the raw body before
   parsing; bounded timestamp window; replay cache keyed by the provider's unique token/id;
   tenant routing from a per-company random inbound address token looked up by a narrow
   SECURITY DEFINER function (like `tenant_id_for_slug`), never from an unauthenticated tenant
   id; the existing `/webhooks/*` rate-limit class. SES via SNS cannot carry PDFs above 150 KB
   (S11), so SES needs the S3 action, a second integration.
5. **Q5 — size, malware, DMARC.** Provider ceilings are 30–35 MB (S9, S10). With a 10 MB PDF
   cap (RQ-0111) and base64's 4/3 growth, a 25 MiB message ceiling admits every acceptable
   bill; the poller refuses larger messages from RFC822.SIZE before download and bounds every
   literal it reads (a hostile or broken server cannot exhaust memory). Only PDFs are kept;
   archives are never expanded (no zip-bomb surface); PDFs are stored, never rendered or
   executed server-side, and served with `Content-Disposition: attachment` semantics (RQ-0148).
   Malware scanning is the mailbox provider's job (S11 verdicts; M365/Google scan before
   delivery). SPF/DKIM/DMARC are evaluated by the receiving MTA (S13); the sender address only
   *suggests* a supplier and nothing posts until a human codes and approves the bill, so a
   spoofed sender cannot cause a payment by itself.
6. **Q6 — idempotency.** Message-ID is the right key with the existing SHA-256 fallback (S12,
   RQ-0111); the IMAP cursor makes re-polls cheap, Message-ID makes them correct.

## Conclusion / decision

- Build **one transport slice per card**: T-0127 builds IMAP polling (AC-1) completely; the
  webhook transport (AC-2) moves to **T-0215**; OAuth2 XOAUTH2 for Microsoft 365 / Google and the
  mailbox settings API/UI to **T-0216**.
- IMAP: **in-house minimal IMAP4rev1 client** (`packages/modules/ap/src/imap-client.ts`), no new
  dependency; implicit TLS only with certificate verification; read-only `EXAMINE` +
  `BODY.PEEK[]`; RFC822.SIZE pre-check with a 25 MiB ceiling; bounded line and literal sizes and
  command timeouts. ADR-0095 (security: client + credential storage).
- Mailbox configuration in `app.bill_inbox_mailbox` (migration 0077): host, port, username,
  folder, sealed password, `(uidvalidity, last_uid)` cursor, last poll outcome. One active
  mailbox per company.
- Poll: per message `withTenant` transaction = lock mailbox row, skip if already past, ingest,
  advance cursor. An `InboxError` (e.g. attachment over 10 MB) or an oversize message is counted
  as refused and the cursor advances (one bad mail never blocks the inbox); infrastructure errors
  stop the poll with the cursor unchanged. Connection/auth failures are recorded on the row
  (no secret in the text) and the job does not throw.
- Scheduling: owner-role scheduler fans out `ap.inbox.poll` per active tenant every 5 minutes
  (job id per tenant and slot); the lf_app worker polls each active mailbox of that tenant.
- Webhooks (T-0215): first provider Mailgun routes (`forward()` to `.../messages.mime`,
  raw MIME, HMAC + token replay table + ±300 s), then SendGrid (ECDSA, `send_raw`); Postmark only
  with Basic credentials + IP allowlist documented as weaker; SES via S3+SNS last.

## Confidence

`high` for the IMAP protocol facts (standards + executed experiment S15) and the client choice;
`medium` for vendor webhook details (search extracts, to be re-read in T-0215); `low` for
Microsoft 365 app-only IMAP (sources disagree — T-0216 must verify against current Microsoft
documentation).

## Follow-ups

- T-0215 webhook transport (AC-2 of T-0127); T-0216 XOAUTH2 + mailbox settings API/UI.
- Re-check provider limits and signature schemes when T-0215 starts (vendor facts move).

**Affects:** packages/modules/ap (inbox), apps/worker (scheduler, worker), packages/db migration
0077, ADR-0095, design §6.6, §7.2, UC-05.
