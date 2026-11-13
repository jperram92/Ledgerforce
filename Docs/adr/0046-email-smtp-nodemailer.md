---
adr: 0046
title: "Send document email over SMTP with nodemailer from outbox handlers"
status: Accepted
date: 2026-11-01
author: claude
category: integration
human_gate: no
supersedes: none
superseded_by: none
---

# ADR-0046: Send document email over SMTP with nodemailer from outbox handlers

## Status
Accepted 2026-11-13 by the product owner\'s instruction to accept all ADRs within risk (DL-0405); previously Proposed:

Proposed — becomes Accepted on green CI plus cross-review by codex (category integration, a new
runtime dependency per design §10.6; credentials stay in the environment's secret store, so no
change to the security model and no human gate).

## Context and problem statement

Design §5.7 / §9.1: invoices, statements, reminders and remittance advices are emailed (SMTP or a
transactional provider). T-0040 publishes `ar.invoice.posted` with the Billing To recipients; T-0041
renders the PDF. Something must turn events into delivered email, exactly once per event as far as
SMTP allows, to the right contacts.

## Decision drivers
- Works with any SMTP relay (self-hosted installs) and the SMTP endpoints of transactional providers.
- Attachments (PDF), TLS, authentication, well-maintained.
- Sending outside the posting transaction (design §3.9: workers read the outbox).

## Considered options
1. nodemailer (SMTP transport) in an outbox handler.
2. A provider SDK (SES, Postmark, SendGrid) — vendor lock-in for self-hosted installs.
3. A hand-written SMTP client.

## Decision outcome
Option 1, `nodemailer@10.1.2`.

Rules:
1. Email is sent only by outbox handlers in the worker (never inside a posting transaction).
2. Recipients are resolved from contact roles at send time (`billing_to` → To, `billing_cc` → Cc;
   `statements` → To for statements, falling back to `billing_to`; `remittance` → To for
   remittance advices); no active recipient = no email and a recorded refusal.
3. Each send is recorded in `app.email_delivery` (one row per event and purpose, unique), so a
   redelivered event is not sent twice once recorded. SMTP cannot join the database transaction:
   if the record does not commit after a successful send, the event is retried and may be sent
   again (at-least-once, documented).
4. SMTP settings come from the environment (`LF_SMTP_URL`, `LF_SMTP_FROM`); credentials are never
   stored in the database or logged. TLS is required unless the URL says `smtp://` to a local relay.
5. Tests use an in-process SMTP sink (no network, no mocks of the client).

## Consequences
### Good
- Provider-neutral; testable end to end with a real SMTP conversation.
### Bad / accepted trade-offs
- At-least-once delivery under a crash between send and commit.
### Follow-ups
- Bounce/complaint handling and a provider webhook (later); statement and reminder templates
  (T-0049, T-0068).

## Compliance and verification
| Check | Where | Gate |
|---|---|---|
| Posted invoice → one email To Billing To, Cc Billing CC, PDF attached; no resend | packages/modules/email/src/invoice-email.db.test.ts | db-tests |
| Remittance contact receives the advice listing bills | same | db-tests |

## Links
- Design §5.7, §9.1. Task T-0042. ADR-0008 (outbox), ADR-0045 (PDF). DL-0270.
