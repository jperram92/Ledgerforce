---
adr: 0054
title: "Send REST security headers on every API response, keep CORS off, and rate limit auth and mutating routes per client address"
status: Accepted
date: 2026-11-13
author: claude
category: security
human_gate: yes
supersedes: none
superseded_by: none
---

# ADR-0054: API security headers, strict CORS and rate limits

## Status
Accepted 2026-11-13 under the product owner's standing instruction to accept ADRs within risk (DL-0405, DL-0411a); previously Proposed:

Proposed — security category, awaiting the product owner (AGENTS.md §6 gate 1; security ADRs are
not covered by the DL-0263 delegation). Code is built test-first on the T-0142 branch; T-0142
cannot be `done` until this is accepted.

## Context and problem statement

Design §6.9 requires rate limiting, CSP, CSRF protection and strict CORS (OWASP ASVS L2);
apps/api AGENTS.md repeats it. Until T-0142 the API set no security headers of its own (only the
nginx SPA location did), Express advertised `X-Powered-By: Express`, nothing was rate limited and
`trust proxy` was off, so behind nginx every client had nginx's address. RQ-0141 collected the
OWASP guidance (REST, HTTP headers, DoS, authentication and CSRF cheat sheets) and the Express
5.2.1 / proxy-addr behaviour from source. CSRF is decided separately (T-0144).

## Decision drivers

- OWASP REST Security Cheat Sheet header baseline and "disable CORS headers if cross-domain calls
  are not supported" (RQ-0141 S1, S2).
- 429 on excess requests (S3); limits must not turn into an outage for everyone behind one proxy
  (S8–S10).
- No new runtime dependency without need (AGENTS.md §4); small, testable code.
- Single-VM compose MVP with one API process (design §7.2).

## Considered options

1. **In-house Express middleware** for headers and a bounded fixed-window limiter.
2. **helmet + @nestjs/throttler** (or express-rate-limit).
3. **Edge only** — headers and limits in nginx / the operator's proxy.

### Option 1 — In-house middleware

- Good, because the rules are ~20 lines of headers and a counter; no runtime dependency or ADR for
  one; exact control of the 429 body (`{error}` like every other API error) and of route classes.
- Good, because it runs before routing, guards and the database: excess requests cost nothing.
- Bad, because we own the code (mitigated by unit + DB tests) and counters are per process.

### Option 2 — helmet + throttler

- Good, because maintained defaults.
- Bad, because two runtime dependencies (ADR + supply chain) for behaviour we still have to
  configure route by route; helmet's defaults target HTML pages (e.g. a CSP with `script-src`),
  not a JSON API; throttler also keeps in-memory counters by default (S11).

### Option 3 — Edge only

- Good, because no application code.
- Bad, because the API is also reachable without nginx (tests, other topologies, hosted later) and
  the headers would then silently disappear; nginx `limit_req` cannot tell route classes apart as
  precisely without duplicating the API's route list again.

## Decision outcome

Chosen option: **Option 1, in-house middleware**, because it meets the OWASP baseline with no new
dependency and keeps the policy next to the routes it protects, testable in the API's own suites.

Rules:

1. Every API response carries `Cache-Control: no-store`,
   `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`,
   `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
   `Cross-Origin-Resource-Policy: same-origin`; no `X-Powered-By`.
2. `Strict-Transport-Security: max-age=31536000` is sent only when the public URL is https
   (no `includeSubDomains`, no `preload`: those are the operator's choice).
3. CORS is never enabled (`enableCors` / `cors` option are not used); a test pins that no
   `Access-Control-Allow-*` header is sent, even to a preflight.
4. Rate limits, fixed 60-second windows, keyed on (class, `req.ip`):
   - `auth` — `GET /t/:slug/auth/login`, `GET /auth/callback`, `GET /auth/step-up`: 30;
   - `webhook` — unsafe methods on `/webhooks/*`: 600;
   - `mutating` — any other POST/PUT/PATCH/DELETE: 300;
   - safe methods outside `auth` are not limited.
   Excess answers `429 {"error":"rate_limited"}` with `Retry-After` in whole seconds, before routing.
   The key map is bounded (oldest keys evicted).
5. `trust proxy` is the integer `LF_TRUST_PROXY_HOPS` (0–5, default 0), never `true`; compose
   passes 1 (nginx). Operators with a TLS proxy that appends `X-Forwarded-For` set 2.
6. Production configuration (`apiOptionsFromEnv`) always enables rules 1–5; `createApi` without
   the `security.rateLimits` option (unit/DB test harness) applies rules 1–3 only.

## Consequences

### Good

- OWASP REST header baseline on every route, including errors and redirects.
- Floods of OIDC starts, callbacks or writes are cut off before guards and SQL.

### Bad / accepted trade-offs

- Counters are per process and reset on restart; a multi-process hosted deployment needs a shared
  store or edge limiting (follow-up before hosted, RQ-0141 F8).
- Users behind one NAT share a bucket; the defaults are sized for an SMB pilot and configurable in
  code (`security.rateLimits`).
- A wrong `LF_TRUST_PROXY_HOPS` either merges clients into one bucket (too low) or lets clients
  pick their bucket via `X-Forwarded-For` (too high); documented in Docs/ops/install.md.

### Follow-ups

- T-0144 CSRF (Fetch Metadata + Origin) with its own security ADR.
- Shared rate-limit store or edge limiting for hosted (not MVP).

## Compliance and verification

| Check | Where | Gate |
|---|---|---|
| Header set on public, authenticated, 404 and 401 responses; no X-Powered-By; HSTS only for https | `apps/api/src/security/security-headers.db.test.ts` | verify.sh unit/db gates |
| No `Access-Control-Allow-*` on preflight or cross-origin request | same file | same |
| 429 + Retry-After per class and per address, window reset, before handlers | `apps/api/src/security/rate-limit.db.test.ts`, `rate-limit.test.ts` | same |
| Production config enables limits, parses `LF_TRUST_PROXY_HOPS`, HSTS for https | `apps/api/src/config.test.ts` | same |
| Compose passes `LF_TRUST_PROXY_HOPS` to the API | `infra/test/install-contract.test.ts` | same |

## Links

- Design: §6.9, §7.2
- Research: RQ-0141
- Decision log: DL-0462
- Related ADRs: ADR-0016 (sessions), ADR-0025 (step-up), ADR-0049 (Stripe webhook)
- External sources: OWASP Cheat Sheet Series (REST Security, HTTP Headers, Denial of Service,
  Authentication, CSRF Prevention), retrieved 2026-11-13 from the OWASP/CheatSheetSeries repository
