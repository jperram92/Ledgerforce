---
adr: 0095
title: "Bills inbox IMAP polling: in-house minimal IMAP client, sealed mailbox credentials, read-only polling"
status: Accepted
date: 2026-11-16
author: claude
category: security
human_gate: yes (delegated, DL-0691)
supersedes: none
superseded_by: none
---

# ADR-0095: Bills inbox IMAP polling — in-house minimal IMAP client, sealed mailbox credentials, read-only polling

## Status

Accepted 2026-11-16 by the building agent under the product owner's standing instruction DL-0691
(security decisions delegated on condition of research, a decision-log entry and tests):
research RQ-0177, decisions DL-0810..DL-0813, tests listed below.

## Context and problem statement

UC-05: supplier bills emailed to the company's bills mailbox become inbox items
(`ingestBillEmail`, T-0051, ADR-0053). On a self-hosted install the mailbox is an existing
Microsoft 365, Google Workspace or other IMAP mailbox (RQ-0111). The worker must read it with
the mailbox's credentials (a secret, design §6.6), from a server the operator names, without
double-creating or losing bills. Two choices need a decision: which IMAP client (a new runtime
dependency requires an ADR, AGENTS.md §4), and how the credentials and polling are secured.

## Decision drivers

- No new runtime dependency unless it clearly pays for itself (AGENTS.md §4, directive 5).
- Secrets at rest only envelope-encrypted (ADR-0018); never returned by reads or logged.
- The mailbox is never modified by LedgerForce (no \Seen, no delete, no move): the business keeps
  its mailbox as its record.
- Exactly-once inbox items across re-polls, crashes, concurrent pollers and UIDVALIDITY resets.
- A hostile or broken IMAP server, or a hostile email, cannot exhaust the worker's memory or
  block the inbox.

## Considered options

1. **imapflow** (MIT, maintained): full client, 8 direct runtime dependencies (pino, iconv-lite,
   libmime, mailsplit, socks, …) for features the poller does not use (RQ-0177 F1).
2. **node-imap / emailjs-imap-client**: unmaintained / archived. Rejected.
3. **In-house minimal IMAP4rev1 client over `node:tls` (chosen)**: seven commands (greeting,
   LOGIN, EXAMINE, UID SEARCH, UID FETCH, LOGOUT; XOAUTH2 in T-0216), a response reader with
   literal support and hard limits, about 300 lines, no dependency.

For credentials: (a) environment variable per install — rejected, a company-scoped setting and
not rotatable per company; (b) **envelope-encrypted column per mailbox row (chosen)**, the same
pattern as the Salesforce connection (ADR-0018, migration 0017).

## Decision outcome

Chosen option 3 with sealed credentials:

1. **Transport.** Implicit TLS only (RFC 8314; port 993 default) with certificate and host-name
   verification (`rejectUnauthorized` is never disabled in product code). STARTTLS and
   plaintext are not offered. Tests inject a connector to an in-process fake server.
2. **Read-only polling.** `EXAMINE` (read-only select) and `UID FETCH … BODY.PEEK[]`; the client
   has no command that stores flags, expunges, moves or appends.
3. **Limits.** Response lines ≤ 64 KiB; a literal larger than the message ceiling (default
   25 MiB) aborts the connection; each command has a timeout (default 60 s); at most 50 messages
   per poll. Messages above the ceiling (RFC822.SIZE, fetched first) are refused without being
   downloaded.
4. **Credentials.** `app.bill_inbox_mailbox` stores host, port, username, folder and the
   password sealed with AES-256-GCM + KMS-wrapped data key, AAD
   `lf-field-v1|<tenant>|<company>|app.bill_inbox_mailbox|<id>|password`; the identity and secret
   columns are write-once for `lf_app` (a change is a new row; the old one becomes
   `superseded`). Reads return only non-secret columns; the poller is the one caller that opens
   the password, in memory, per poll. Error text recorded on the row is fixed per error class
   (never server text that could echo credentials).
5. **Exactly once.** The cursor `(uidvalidity, last_uid)` lives on the mailbox row. Each message
   is ingested in its own `withTenant` transaction that locks the mailbox row, skips the UID if
   the cursor is already past it, calls `ingestBillEmail` (idempotent on Message-ID), and
   advances the cursor. A changed UIDVALIDITY restarts at UID 0; Message-ID absorbs the
   re-reads. An oversize message or an `InboxError` advances the cursor and is counted as
   refused; any other error stops the poll with the cursor unchanged.
6. **Scheduling.** The owner-role scheduler sends one `ap.inbox.poll` job per active tenant per
   5-minute slot (job id from tenant and slot); the lf_app worker polls that tenant's active
   mailboxes inside RLS (ADR-0062 pattern).
7. **Content safety.** Unchanged from T-0051: only PDFs ≤ 10 MB are kept, archives are never
   expanded, nothing is rendered or executed server-side, and nothing posts until a person codes
   and approves the bill; the sender only *suggests* a supplier (SPF/DKIM/DMARC are the
   receiving MTA's job, RQ-0177 F5).

### Consequences

- Good: no new dependency; small, fully tested attack surface; the mailbox stays untouched;
  credentials follow the existing key-rotation path (ADR-0018).
- Bad: we own the IMAP code; Microsoft 365 needs XOAUTH2 before it works (T-0216); no IDLE, so
  a bill arrives within one poll interval (5 minutes), acceptable for AP.
- Follow-ups: T-0215 (provider inbound webhooks, AC-2 of T-0127), T-0216 (XOAUTH2 and the
  mailbox settings API/UI).

## Validation

- `packages/modules/ap/src/imap-client.test.ts` — protocol subset against the in-process fake
  server, literal handling, `n:*` edge case, size and line limits, read-only commands only.
- `packages/modules/ap/src/inbox-mailbox.db.test.ts` — SS-PLAT-154..156: one inbox item per
  message, re-poll adds nothing, UIDVALIDITY reset adds nothing, oversize/invalid mail refused
  without blocking, password sealed and AAD-bound, failures recorded without secrets.
- `apps/worker/src/inbox-poll-jobs.db.test.ts` — fan-out job ids per tenant and slot; worker
  polls in the tenant's transaction.
- `packages/db/src/rls.db.test.ts` cross-tenant suite covers `app.bill_inbox_mailbox`.

## Links

RQ-0177, RQ-0111, ADR-0018, ADR-0053, ADR-0062, DL-0691, T-0127, T-0215, T-0216, design §6.6, §7.2.
