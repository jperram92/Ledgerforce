---
id: RQ-0098
status: answered   # open | answered | answered-pending-human | superseded
opened: 2026-11-01
opened_by: claude
task: T-0051
---
# RQ-0098 — How a self-hosted install receives supplier bills by email

## Question
UC-05: a supplier PDF emailed to the tenant's bills inbox becomes a draft bill. Which inbound
mechanism suits the self-hosted install (design §7.2) and the hosted SaaS, and what must ingestion
handle?

## Findings
1. **Mechanisms.**
   - *IMAP polling* of an existing mailbox (Microsoft 365, Google Workspace, any host) — no DNS or
     open ports; needs the mailbox credentials (envelope-encrypted secret) and IDLE or a poll
     interval. Protocol: IMAP4rev2, RFC 9051 (IMAP4rev1 RFC 3501 still widely served).
   - *SMTP receiver* — the install accepts mail itself; needs an MX record, port 25 reachable and
     spam/TLS handling: unsuitable for most self-hosted SMB installs.
   - *Provider inbound webhooks* (SES, Postmark, Mailgun inbound) — good for the hosted SaaS; each
     posts the raw or parsed message to an HTTPS endpoint.
2. **Common denominator.** All three deliver an RFC 5322 message (MIME, RFC 2045–2049) — raw for
   IMAP `BODY[]`, raw or reconstructable for webhooks. PDFs arrive as `application/pdf` parts
   (base64) or occasionally `application/octet-stream` with a `.pdf` filename.
3. **Idempotency.** The `Message-ID` header (RFC 5322 §3.6.4) identifies a message across
   re-polls and webhook retries; when missing, a hash of the raw message serves.
4. **Parsing.** A MIME parser must decode transfer encodings, filenames (RFC 2231) and nested
   multiparts. postal-mime (MIT-0, no dependencies) parses raw messages in Node and browsers;
   mailparser (MIT) is heavier (html-to-text, linkify-it, nodemailer).

## Conclusion
- Ingestion is transport-agnostic: `ingestBillEmail(raw RFC 5322 bytes)` — idempotent on
  Message-ID (fallback SHA-256 of the message) — records an inbox item (the draft bill awaiting
  coding) with its PDF attachments stored, the sender matched to a supplier by contact email.
  Nothing posts until the AP Clerk codes it (createBill) and it is approved.
- Transports: IMAP polling is the self-host default and provider webhooks the SaaS path; both are
  adapters feeding the same function (follow-up card T-0121). SMTP receiving is not offered.
- Parser: postal-mime (ADR-0047).
- Limits: attachments over 10 MB are refused; only PDFs are kept (OCR/receipt capture is Phase 1).
