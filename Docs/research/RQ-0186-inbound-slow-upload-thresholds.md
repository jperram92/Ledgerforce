---
id: RQ-0186
title: Slow-upload protection on the Mailgun inbound route - per-client in-flight cap, minimum transfer rate, first-byte timeout (thresholds and semantics)
status: answered
opened: 2026-11-23
resolved: 2026-11-23
opened_by: claude
linked_tasks: [T-0230, T-0215]
linked_adrs: [ADR-0099, ADR-0054]
superseded_by:
---

# RQ-0186 — Slow-upload protection on the Mailgun inbound route

## Question

The T-0215 security re-review (N1, DL-0898) showed that `POST /webhooks/mailgun/messages.mime`
can be held at 503 by a few connections that send their body very slowly: the only time limit
is the 60 s whole-body timeout, the global in-flight cap is 4, and one address may hold all
four slots. Sub-questions:

- **Q1** How do established servers and guidance bound slow request bodies (Slowloris / "slow
  POST" / R.U.D.Y.)? Which knobs exist and what do they count?
- **Q2** What thresholds suit this route (server-to-server delivery from Mailgun, bodies up to
  26 MiB), without refusing genuine deliveries?
- **Q3** Which client address is the per-client cap keyed on, given proxies in front of the API?
- **Q4** What does the client get on refusal, given Mailgun's retry rules?
- **Q5** What is left that code in the API cannot fix?

## Why it matters

Design §6.9 (rate limiting, DoS), UC-05: Mailgun retries a failing delivery for about 8 hours
and then drops it (RQ-0181 F3), so a sustained slow-upload attack loses supplier bills.

## Sources consulted

Network note (2026-11-23): `nginx.org` and `cheatsheetseries.owasp.org` did **not resolve**
from this session (allow-list). Their facts below come from search extracts of mirrors and
the project's prior knowledge of those pages and are marked so; re-verify when reachable.

| # | Source | Read | Kind | What it says (relevant part) |
|---|---|---|---|---|
| S1 | nginx `ngx_http_limit_conn_module` (https://nginx.org/r/limit_conn; mirror text via search; nginx-site commit https://freenginx.org/hg/nginx-site/rev/4931a7ba6a32; thread https://mailman.nginx.org/pipermail/nginx/2017-December/055322.html) | 2026-11-23 (search extract) | primary (mirror) | `limit_conn zone number` limits connections per key, typically `$binary_remote_addr`; the documented example is `limit_conn addr 1` (one connection per address). A connection is counted only while it has a request being processed **and the whole request header has been read**. Refused requests get `limit_conn_status` (default **503**). In HTTP/2 and HTTP/3 each concurrent request counts as a connection. |
| S2 | nginx `ngx_http_core_module` `client_body_timeout` (https://nginx.org/en/docs/http/ngx_http_core_module.html#client_body_timeout) | not reachable; prior knowledge | primary | Default **60 s**. "The timeout is set only for a period between two successive read operations, not for the transmission of the whole request body. If a client does not transmit anything within this time, the request is terminated with the **408** (Request Time-out) error." `client_header_timeout` is the same for headers. nginx has no minimum-rate knob for bodies: a client sending one byte every 59 s keeps the body open. |
| S3 | Apache httpd `mod_reqtimeout` (https://httpd.apache.org/docs/mod/mod_reqtimeout.html) | 2026-11-23 (search extract) | primary | Default `RequestReadTimeout handshake=0 header=20-40,MinRate=500 body=20,MinRate=500`: 20 s to receive the body, extended by 1 s per 500 bytes received (a **minimum rate**), answered with **408** when the client is too slow. |
| S4 | OWASP Denial of Service Cheat Sheet (https://cheatsheetseries.owasp.org/cheatsheets/Denial_of_Service_Cheat_Sheet.html); OWASP Periodic Table "DoS (connection based)" (https://wiki.owasp.org/index.php/OWASP_Periodic_Table_of_Vulnerabilities_-_Denial_of_Service_(Connection_Based)) | cheat sheet not reachable; prior knowledge + search extract | guidance | Limit resources per client (connections per IP), use short timeouts for headers and bodies and a minimum data rate, limit request size, prefer to stop early. Slow attacks tie a slot up "waiting for the rest of the data" (Qualys, S5). |
| S5 | Qualys slow HTTP research (https://blog.qualys.com/securitylabs/2011/07/07/identifying-slow-http-attack-vulnerabilities-on-web-applications); Acunetix mod_qos guide (https://www.acunetix.com/blog/articles/slow-http-dos-attacks-mitigate-apache-http-server/); Cloudflare Slowloris (https://www.cloudflare.com/learning/ddos/ddos-attack-tools/slowloris) | 2026-11-23 (search extract) | secondary | "If an http request is not complete, or if the transfer rate is very low, the server keeps its resources busy waiting." mod_qos example: minimum body rate 500 B/s, `QS_SrvMaxConnPerIP` per-address connection cap. Event-loop servers resist header Slowloris but an application-level slot (our in-flight cap) is the same scarce resource. |
| S6 | Node.js 22 `http.Server` defaults, measured locally: `node -e "…createServer()…"` on v22.23.4 | 2026-11-23 | primary (runtime) | `headersTimeout` 60 000 ms, `requestTimeout` 300 000 ms, `timeout` 0, `keepAliveTimeout` 5 000 ms. Node bounds header time but not body rate; the API sets neither. |
| S7 | RQ-0181 F3 (Mailgun status handling) | 2026-11-22 | prior research | 2xx accepted; **406 never retried**; anything else retried for about 8 hours. |
| S8 | Repository: `apps/api/src/security/inbound-body.ts`, `rate-limit.ts`, `security.ts` (`express.set('trust proxy', hops)`), `config.ts` `LF_TRUST_PROXY_HOPS`, `infra/compose/compose.yaml` (`LF_TRUST_PROXY_HOPS: ${LF_TRUST_PROXY_HOPS:-1}`) | 2026-11-23 | source code | The rate limiter keys on `req.ip` (Express resolves it from `X-Forwarded-For` only across the configured number of trusted hops; with 0 it is the socket address) with `::ffff:` stripped. Compose's nginx is one trusted hop. |

## Findings

1. **F1 (Q1) — three knobs, all standard.** Per-client concurrency (nginx `limit_conn addr 1`,
   mod_qos per-IP connections, S1/S5); an inactivity / first-data timeout (nginx
   `client_body_timeout`, S2); a minimum average rate (Apache `MinRate`, mod_qos, S3/S5). nginx
   alone has no rate floor, so a one-byte-per-59-s client survives it; Apache's rate rule is the
   one that actually stops a trickle. Both answer **408**; `limit_conn` answers **503**.
2. **F2 (Q2) — thresholds.** The sender is Mailgun's data centre, not a phone on a slow link, so
   the floor can be far higher than Apache's generic 500 B/s:
   - **per-client in flight: 1** (nginx's documented example; the card's AC-1). A genuine burst
     from one Mailgun address answers 503 and is retried (S7) — minutes of delay, no loss.
   - **first byte: 3 s** after the request headers. Covers an `Expect: 100-continue` round trip
     (Node answers 100 automatically) with wide margin; must be shorter than the rate grace or it
     adds nothing.
   - **minimum rate: 64 KiB/s averaged over the request, checked once a second from 5 s on.** A
     genuine 26 MiB message at that floor would still exceed the 60 s cap, so the floor never
     binds before the existing timeout for real traffic; a small message (most bills are
     < 1 MiB) finishes in well under 5 s and is never checked. A 1-byte-per-second trickle is
     refused at 5 s instead of 60 s.
   - unchanged: global cap 4, 64 MiB buffered, 60 s whole body, 26 MiB per message.
   All are fields of `InboundBodyLimits` (code-configurable like the existing ones); exposing
   them as environment variables goes to follow-up card T-0235.
3. **F3 (Q2) — what an attacker now needs.** Before: 4 connections at a few bytes per second from
   one address, renewed each minute. After: one slot per address; holding a slot for the full
   60 s costs ≥ 64 KiB/s (3.75 MiB per minute) per slot, so all four slots need four addresses
   and ≥ 256 KiB/s sustained; a slot that falls below the floor frees within ~6 s. Combined with
   the `inbound_email` rate class (60 requests/min per address) this turns a trivial attack into
   a distributed, bandwidth-costly one. It is not a complete fix (F5).
4. **F4 (Q3) — client address.** Use exactly the rate limiter's key: `req.ip` as Express
   resolves it under `trust proxy = LF_TRUST_PROXY_HOPS`, `::ffff:` stripped (S8). With 0 hops a
   forged `X-Forwarded-For` is ignored; with N hops only the N rightmost entries are trusted.
   One shared helper so the two can never drift. If an operator forgets the hop count behind a
   proxy, every client shares the proxy's address and uploads are serialised (still correct,
   slower) — runbook note.
5. **F5 (Q4) — answers.** Second concurrent upload from the same address: **503 `inbound_busy`
   + Retry-After**, read nothing, take no global slot (S1, Mailgun retries). No first byte:
   **408 `first_byte_timeout`**; below the rate: **408 `upload_too_slow`** (S2/S3; Mailgun
   retries 408). Every refusal keeps `Connection: close` and drops the socket (r11 F4).
6. **F6 (Q5) — outside the API.** An attacker with many addresses can still fill the global cap.
   The complete mitigations are network-level: allow only Mailgun's egress ranges to reach this
   path at the proxy, or a CDN/WAF in front; and alerting on sustained `inbound_busy`. Recorded
   as runbook guidance (AC-4), not code.

## Conclusion

Implement the three limits in `inbound-body.ts` with the thresholds of F2, keyed on the shared
trusted-proxy client address (F4), answering per F5; runbook note for F6. No new dependency, no
migration, no public API change (only new refusal codes on an existing route), so no ADR: the
ADR-0099 addendum already makes this route's reader the place where upload bounds live.
