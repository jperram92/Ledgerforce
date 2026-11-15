---
adr: 0078
title: "Statement import accepts JSON bodies up to 10 MB; every other route keeps the 100 kB default"
status: Accepted
date: 2026-11-15
author: claude
category: security
human_gate: yes
supersedes: none
superseded_by: none
---

# ADR-0078: Statement import accepts JSON bodies up to 10 MB; every other route keeps the 100 kB default

## Status
Accepted under the product owner's delegation of 2026-11-13: "Yes you are authorised to make all
these decisions based off best practices" (DL-0477 item 6: "a route-scoped 10 MB JSON limit only
on statement import (RQ-0151, option A, no new dependency). Per-address write rate limits
(ADR-0054) still apply"). Category: security, because it changes the request-size limit, a
denial-of-service control of design §6.9. Card T-0161.

## Context and problem statement
`POST /bank-rec/accounts/:id/statements` receives the statement file as base64 in JSON. Every
JSON body is limited to body-parser's default of 100 kB (RQ-0151 S1, S3), so the largest file
that fits is about 75 kB and a busy month's CSV is refused with 413 (UC-08 step 1). Raising the
limit for every route would let any authenticated or anonymous caller make the API buffer
megabytes on every JSON route. The reverse proxy allows 10 MB (`client_max_body_size 10m`,
RQ-0151 S5).

## Decision drivers
- Smallest exception that meets the need: one route, one method, one content type.
- No new runtime dependency (design §10.6); `express` is not a direct dependency of apps/api.
- Keep the ADR-0054 order: security headers, rate limits and the CSRF guard (ADR-0076) run before
  any body is read.
- Bounded memory: stop reading as soon as the limit is passed.

## Considered options
1. **Path-scoped JSON reader, 10 MB, dependency-free (chosen; RQ-0151 option A).**
2. Declare `express` a direct dependency and mount `express.json({limit:'10mb'})` on the path
   (RQ-0151 option B). Same effect, but a new direct runtime dependency for one line of code.
3. Raise the global limit (`app.useBodyParser('json', {limit})`). Rejected: widens every route,
   and Nest cannot scope it to a path (RQ-0151 finding 6).
4. `multipart/form-data` with Nest's FileInterceptor. Rejected: needs multer as a direct
   dependency, changes the import contract and the web client, and adds a body format the CSRF
   and audit paths were not reviewed for (RQ-0151 finding 4).

## Decision outcome
`apps/api/src/security/statement-body.ts` is a middleware registered in `createApi` right after
`applySecurity` (headers, rate limits, CSRF) and before Nest's own parsers. It acts only on
`POST` to `/bank-rec/accounts/<id>/statements` (case-insensitive, optional trailing slash, the way
Express routes it) with `Content-Type: application/json`. Everything else passes untouched to
Nest's default parser with its 100 kB limit; a spelling that this middleware does not recognise
therefore falls back to the smaller limit (fail-safe).

For a request it handles:
- A declared `Content-Length` above 10 MB (10 485 760 bytes) is answered at once with 413
  `{error:'payload_too_large'}`; nothing is buffered.
- Otherwise the body is read with a running byte count; the first chunk that passes 10 MB stops
  buffering and the answer is 413 (this covers chunked bodies without a length).
- After a 413 the response carries `Connection: close`; the rest of the upload is read and
  discarded, not stored, so the client can read the answer.
- A `Content-Encoding` other than `identity` is 415 `{error:'unsupported_content_encoding'}`
  (no decompression, so no zip-bomb path); a `charset` other than UTF-8 is 415
  `{error:'unsupported_charset'}`.
- Malformed JSON, or a top-level value that is not an object or array (body-parser's strict
  mode), is 400 `{error:'invalid_json'}`. An empty body becomes `{}`.
- The parsed value is set as `req.body`. Nest's JSON parser then skips the request because the
  stream is already read (RQ-0151 S2).

Authentication, the `bank.statement.import` permission, the Idempotency-Key and the audit record
are unchanged: they run after the body is read, as for every other route. The per-address
`mutating` rate limit of ADR-0054 still applies to the route before any byte is read.

## Consequences
- Statement files up to about 7.5 MB (10 MB of base64 JSON) import over HTTP; this is far above a
  monthly statement (a 1 MB CSV holds about 20 000 lines).
- Peak memory per in-flight import request is bounded by about 10 MB of body plus its decoded
  copy; the rate limit bounds how many one address can send per window.
- Unauthenticated callers can make the API read up to 10 MB on this one path before the 401,
  as they could make nginx read it; the rate limit applies to them too.
- If the proxy limit changes, this limit stays at 10 MB unless a new ADR changes it.

## Validation
- `apps/api/src/bank/bank-rec.db.test.ts` (T-0161): a 30 000-line CSV of a few MB imports with
  201 and is audited once, and its replay is `duplicate_file`; a body over 10 MB is 413 and
  writes nothing; a 200 kB body to other routes (and to a path that only starts like the import
  route) is still 413; malformed JSON is 400; the permission still applies.
- `apps/api/src/security/statement-body.db.test.ts`: a declared length over the limit and a
  chunked body over the limit are 413; a compressed body and a non-UTF-8 charset are 415; the
  rate limit answers 429 before the body is read; the security headers are on the 413.

## Links
- RQ-0151, DL-0532, DL-0477 item 6, DL-0612; ADR-0054 (headers and rate limits), ADR-0076 (CSRF).
