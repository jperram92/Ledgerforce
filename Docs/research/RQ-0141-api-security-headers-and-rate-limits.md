---
id: RQ-0141
title: Which security headers, CORS policy and rate limits must the LedgerForce API apply, and how (in-house or a library)?
status: resolved
opened: 2026-11-13
resolved: 2026-11-13
opened_by: claude
linked_tasks: [T-0097, T-0142, T-0144]
linked_adrs: [ADR-0054]
superseded_by:
---

# RQ-0141 — API security headers, CORS and rate limits

## Question

- Q1. Which HTTP response headers should every LedgerForce API response carry (design §6.9,
  apps/api AGENTS.md "Security headers, CSP, strict CORS, rate limiting")?
- Q2. What does "strict CORS" mean for an API served on the same origin as the SPA (nginx, T-0094)?
- Q3. Which routes are rate limited, keyed on what, with what response, and how is the client
  address found behind the nginx proxy (and an operator's TLS terminator)?
- Q4. Build the headers and the limiter in-house, or add `helmet` / `@nestjs/throttler` /
  `express-rate-limit` (a new runtime dependency needs an ADR, AGENTS.md §4)?
- Q5. What CSRF protection does a cookie-session API need beyond `SameSite=Lax` (input for T-0144)?

## Why it matters

Design §6.9 requires "Rate limiting, CSP, CSRF protection, strict CORS" and OWASP ASVS L2. Before
this record the API sent none of these headers itself (only nginx's SPA `location` did, see
`infra/docker/nginx/default.conf.template`), Express advertised `X-Powered-By: Express`, there was
no rate limiting and `trust proxy` was off. Guessing the client address wrong behind a proxy either
puts every user in one bucket (a self-inflicted outage) or lets clients spoof their bucket.

## Sources consulted

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S1 | https://raw.githubusercontent.com/OWASP/CheatSheetSeries/master/cheatsheets/REST_Security_Cheat_Sheet.md §"Security Headers" | 2026-11-13 | primary (OWASP) | "The following headers should be included in all API responses that may be consumed by browser clients": `Cache-Control: no-store`, `Content-Security-Policy: frame-ancestors 'none'`, `Content-Type`, `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`. For defence in depth when unsure whether HTML may be returned: `Content-Security-Policy: default-src 'none'`, `Permissions-Policy`, `Referrer-Policy: no-referrer`. |
| S2 | same, §"CORS" | 2026-11-13 | primary | "Disable CORS headers if cross-domain calls are not supported/expected." |
| S3 | same, §"API Keys" and status-code table | 2026-11-13 | primary | "Return `429 Too Many Requests` HTTP response code if requests are coming in too quickly"; 429 "is used when there may be DOS attack detected or the request is rejected due to rate limiting". |
| S4 | https://raw.githubusercontent.com/OWASP/CheatSheetSeries/master/cheatsheets/HTTP_Headers_Cheat_Sheet.md | 2026-11-13 | primary | X-Powered-By: "Remove all `X-Powered-By` headers". HSTS recommendation `max-age=63072000; includeSubDomains; preload` with the warning that a misconfigured HSTS or a TLS problem can lock users out; CORP `same-site` ("Limit current resource loading to the site and sub-domains only"); X-Frame-Options `DENY`. |
| S5 | https://raw.githubusercontent.com/OWASP/CheatSheetSeries/master/cheatsheets/Denial_of_Service_Cheat_Sheet.md §"Rate limiting" | 2026-11-13 | primary | Rate limiting "can be implemented on infrastructure as well as on an application level … based on (offending) IPs". |
| S6 | https://raw.githubusercontent.com/OWASP/CheatSheetSeries/master/cheatsheets/Authentication_Cheat_Sheet.md §"Login Throttling" | 2026-11-13 | primary | Login throttling; lockout counters "should be associated with the account itself, rather than the source IP address"; lockouts must not become a DoS on other users. |
| S7 | https://raw.githubusercontent.com/OWASP/CheatSheetSeries/master/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.md §"Fetch Metadata headers", §"Using Standard Headers to Verify Origin" | 2026-11-13 | primary | Reject unsafe methods with `Sec-Fetch-Site: cross-site`; treat `same-site` as untrusted unless sibling subdomains are trusted; "a fallback to standard origin verification … is a mandatory requirement"; when headers are absent "Fail-safe (recommended for sensitive endpoints): … block the request"; "Missing headers and `Origin: null` are not evidence of a same-origin request"; target origin is best configured server-side; X-Forwarded-Host only from trusted proxies. |
| S8 | `node_modules/.pnpm/express@5.2.1/node_modules/express/lib/application.js` lines 94, 99; `lib/utils.js` `compileTrust`; `lib/request.js` `ip` getter | 2026-11-13 | source code | Express 5.2.1 enables `x-powered-by` and sets `trust proxy` to `false` by default; a numeric `trust proxy` trusts that many hops (`function(a, i){ return i < val }`); `req.ip` = `proxyaddr(req, trust)`. |
| S9 | `node_modules/.pnpm/proxy-addr@2.0.8/node_modules/proxy-addr/index.js` `alladdrs` | 2026-11-13 | source code | Addresses are the socket address followed by `X-Forwarded-For` right to left; walking stops at the first untrusted hop, so with N trusted hops the client address is the (N+1)-th from the right — entries further left (client-supplied) are ignored. |
| S10 | `infra/docker/nginx/default.conf.template` (repo) | 2026-11-13 | source code | nginx sets `X-Forwarded-For $proxy_add_x_forwarded_for` (appends `$remote_addr`) and is the only ingress to `api:3000` in compose; Docs/ops/install.md puts TLS termination in front of nginx. |
| S11 | `curl https://registry.npmjs.org/{helmet,@nestjs/throttler,express-rate-limit}/latest` | 2026-11-13 | primary (registry) | helmet 8.3.0 (no deps); @nestjs/throttler 6.7.1 (peer Nest ≤12); express-rate-limit 8.7.4 (deps `debug`, `ip-address`). All three keep counters in process memory by default; shared stores are separate packages. |
| S12 | `node_modules/@nestjs/core` `NestFactory.create` options (repo, Nest 12.1.2) and `apps/api/src/app.ts` | 2026-11-13 | source code | CORS is only enabled when `cors` is passed to `NestFactory.create` or `app.enableCors()` is called; `createApi` does neither, so no `Access-Control-Allow-*` header is ever sent. |

Accessed through the session's proxy: the OWASP site, rfc-editor.org and expressjs.com were not
reachable (DNS refused), so the OWASP cheat sheets were read from their source repository and the
Express behaviour from the installed source (S8, S9) instead of its guide.

## Findings

1. **Headers (Q1).** S1 lists the REST baseline; S1's defence-in-depth table applies because some
   API routes redirect (OIDC) and a future route may return HTML. S4 adds: remove `X-Powered-By`
   (Express sends it by default, S8), CORP. *Inference:* CORP `same-origin` is stricter than S4's
   `same-site` and fits because the SPA and API share one origin (S10).
2. **HSTS (Q1).** HSTS is honoured only over https and misconfiguration can lock users out (S4).
   *Inference:* send it only when `LF_PUBLIC_URL` is https; `max-age=31536000` without
   `includeSubDomains`/`preload`, because a self-hoster's sibling subdomains and preload-list
   membership are the operator's choice, not ours.
3. **CORS (Q2).** Cross-domain calls are not expected (the SPA is same-origin via nginx), so CORS
   stays disabled (S2); Nest already sends no CORS headers (S12). A regression test pins this.
4. **Rate limiting (Q3).** OWASP asks for 429 on excess (S3) and allows IP-based application-level
   limiting (S5). Login lockout by account (S6) does not apply: LedgerForce has no passwords —
   Keycloak owns credentials and brute-force detection (RQ-0041); the API's auth routes start and
   finish OIDC flows, so per-address throttling of those routes protects the API and the
   pre-auth table from floods.
5. **Client address (Q3).** With `trust proxy` off every request behind nginx has nginx's address
   (S8, S10) — one bucket for everyone. A numeric hop count trusts exactly that many proxies and
   ignores client-supplied entries further left (S9). Compose's topology is nginx (1 hop), plus 1
   when the operator's TLS proxy appends `X-Forwarded-For` — so the hop count is deployment
   configuration (`LF_TRUST_PROXY_HOPS`), never `true`.
6. **Library vs in-house (Q4).** The rules needed are about 20 lines of header setting and a
   fixed-window counter (S11 shows the libraries also keep in-memory counters per process by
   default). In-house code avoids a runtime-dependency ADR and supply-chain surface; the counter
   must be bounded (evict oldest keys) so an address-rotation flood cannot exhaust memory.
7. **CSRF (Q5, for T-0144).** `SameSite=Lax` is defence in depth only; OWASP's Fetch-Metadata
   policy with a mandatory Origin fallback and a fail-safe on missing headers is recommended (S7).
   Bearer-token requests carry no ambient credential and are not CSRF targets.
8. **Multi-instance caveat.** In-process counters are per API process. The MVP is a single-VM
   compose install with one API process (design §7.2), so the limits hold; a scaled hosted
   deployment needs a shared store or edge limiting (follow-up, not MVP).

## Conclusion / decision

- Add an Express middleware, first in the chain, that sets on every response:
  `Cache-Control: no-store`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`,
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
  `Cross-Origin-Resource-Policy: same-origin`, and `Strict-Transport-Security: max-age=31536000`
  when HSTS is on; disable `x-powered-by`. Never call `enableCors`.
- Add an in-house fixed-window limiter keyed on (class, `req.ip`), before routing:
  `auth` = the OIDC login/callback/step-up routes; `webhook` = `/webhooks/*`; `mutating` = any other
  POST/PUT/PATCH/DELETE. Excess answers `429 {"error":"rate_limited"}` with `Retry-After` (whole
  seconds). GET/HEAD/OPTIONS are not limited (except the auth routes). Bounded key map.
- Production defaults (per client address per 60 s): auth 30, mutating 300, webhook 600; set
  `trust proxy` to `LF_TRUST_PROXY_HOPS` (integer 0–5, default 0; compose passes 1).
- Record it in a **security** ADR (ADR-0054, Proposed, human gate). CSRF goes to T-0144 with its
  own ADR.

## Confidence

`high` for the header set, CORS and Express proxy semantics (OWASP primary text and executed
library source). `medium` for the numeric defaults (30/300/600 per minute): there is no normative
number; they are sized for an SMB pilot (≤ ~20 users behind one address) and are configurable.

## Follow-ups

- T-0144 CSRF guard (Finding 7). T-0143 backups (separate RQ-0142).
- Shared-store or edge rate limiting before a multi-process hosted deployment (Finding 8).
- Re-check the OWASP cheat sheets when the ASVS 5 mapping is done for the hosted offering.

**Affects:** apps/api (app.ts, config.ts, new `security/`), infra/compose, Docs/ops/install.md, ADR-0054.
