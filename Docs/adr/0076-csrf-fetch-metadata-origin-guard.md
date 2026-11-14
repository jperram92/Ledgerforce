---
adr: 0076
title: "CSRF guard: cookie-authenticated unsafe requests must prove they are same-origin (fail-safe)"
status: Accepted
date: 2026-11-14
author: claude
category: security
human_gate: yes
supersedes: none
superseded_by: none
---

# ADR-0076: CSRF guard: cookie-authenticated unsafe requests must prove they are same-origin

## Status
Accepted under the product owner's delegation of 2026-11-13: "Yes you are authorised to make all these decisions based off best practices" (DL-0477 item 7). Category: security. Card T-0144.

## Context and problem statement
The browser authenticates with the `lf_session` cookie (SameSite=Lax). Design §6.9 and OWASP ASVS L2 require CSRF protection. RQ-0141 F6–F8 cites the OWASP CSRF Prevention Cheat Sheet. Fetch Metadata (`Sec-Fetch-Site`) is the primary defence; a fallback to standard `Origin` verification is mandatory; and when both headers are missing, the fail-safe choice is to block. Missing headers and `Origin: null` are not evidence of a same-origin request. Bearer API tokens carry no ambient credential and are not CSRF targets.

## Decision drivers
- Fail closed for state-changing requests that carry the session cookie.
- No new runtime dependency; a small Express middleware alongside the ADR-0054 hardening.
- Do not affect token clients, webhooks or safe methods.

## Considered options
1. **Fail-safe.** Requests with neither header are rejected. (Chosen)
2. **Fail-open.** Requests with neither header are allowed. This leaves the guard bypassable by clients that strip headers, and OWASP advises against it for sensitive endpoints.
3. **Synchronizer tokens.** These would need a token in every form and API call, and change the web client widely; Fetch Metadata plus Origin meets the OWASP recommendation without that.

## Decision outcome
The guard runs before routing. For any request whose method is not GET, HEAD or OPTIONS and that carries the `lf_session` cookie:
- `Sec-Fetch-Site: same-origin` or `none` → allowed.
- `Sec-Fetch-Site: same-site` or `cross-site` (or any other value) → 403 `{error:'csrf_rejected'}`. Sibling subdomains are not trusted.
- No `Sec-Fetch-Site`: allowed only if `Origin` exactly equals the configured public origin (from `LF_PUBLIC_URL`). A foreign origin, `null`, or a missing Origin → 403.

A request without the session cookie is not inspected: Bearer tokens, webhooks and anonymous requests. The handler never runs on a rejection, and the 403 carries no detail beyond the error code.

## Consequences
- The DB test helpers that send the session cookie now also send `Sec-Fetch-Site: same-origin`, as a browser does. No assertion changes.
- An old browser that sends neither header cannot make writes. Every browser LedgerForce supports sends Fetch Metadata, and all send Origin on cross-origin and POST requests.
