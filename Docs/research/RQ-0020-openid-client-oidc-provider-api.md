---
id: RQ-0020
title: openid-client 6 and oidc-provider 9 API details for the login flow, and the pre-auth binding
status: answered
opened: 2026-10-24
resolved: 2026-10-24
opened_by: claude
linked_tasks: [T-0011]
linked_adrs: [ADR-0016]
---

# RQ-0020 — openid-client 6 / oidc-provider 9 API details for T-0011

## Questions
1. Which `openid-client` 6.x calls build an authorization code + PKCE (S256) + state + nonce
   request and validate the callback, and which checks run inside the library?
2. How does a test drive the in-process `oidc-provider` 9 through login and consent without a
   browser or its development login form? How does the test IdP put `acr` and `amr` into the ID
   token?
3. ADR-0016 keeps the pre-auth record server-side, keyed by `state`. Does that alone stop login
   CSRF, where an attacker gets a victim to complete the attacker's own login?
4. Do the new packages and their transitive dependencies meet the 14-day release-age rule?

## Sources consulted
| # | Source | Accessed | What it says |
|---|---|---|---|
| S1 | `openid-client@6.8.8` `build/index.d.ts` (installed package) | 2026-10-24 | `discovery(server, clientId, metadata \| secret, clientAuth?, { execute })`, `randomPKCECodeVerifier()`, `calculatePKCECodeChallenge(v)`, `randomState()`, `randomNonce()`, `buildAuthorizationUrl(config, params)`, `authorizationCodeGrant(config, currentUrl, { pkceCodeVerifier, expectedState, expectedNonce, idTokenExpected, maxAge })`, `allowInsecureRequests` (http issuers; tests only). |
| S2 | `oidc-provider@9.12.2` `lib/provider.js`, `lib/actions/authorization/resume.js`, `lib/helpers/defaults.js`, `lib/helpers/grant_common.js` (installed package) | 2026-10-24 | `interactionFinished(req, res, { login: { accountId, acr, amr } })` finishes an interaction; `acr` and `amr` from the login result are stored on the session and the authorization code. `loadExistingGrant(ctx)` may return a saved `Grant`, which skips the consent prompt. Claims are released only if configured: `claims.openid` must list `acr` and `amr`. `features.devInteractions` is on by default. |
| S3 | Spike in the scratchpad (not committed): oidc-provider on `127.0.0.1:0`, openid-client as RP, `fetch` with a cookie jar and `redirect: 'manual'` | 2026-10-24 | The round trip works: `/auth` → 303 `/interaction/:uid` → custom handler calls `interactionFinished` → 303 `/auth/:uid` → 303 to `redirect_uri?code&state&iss`. `authorizationCodeGrant` returned an ID token with `sub`, `acr`, `amr`, `auth_time`, `nonce`. Re-using the code fails with `OAUTH_RESPONSE_BODY_ERROR` (invalid_grant). |
| S4 | OAuth 2.0 Security BCP, RFC 9700 §4.7 (CSRF) and §2.1; OpenID Connect Core 1.0 §3.1.2.1 (`state`, `nonce`) | 2026-10-24 | The client must bind `state`/PKCE to the user agent, for example through a cookie, so that one browser's authorization response cannot be completed in another browser. |
| S5 | npm registry `time` for every package that `pnpm add` added to the lockfile | 2026-10-24 | `openid-client` 6.8.8 (2026-09-05), `oidc-provider` 9.12.2 (2026-09-05), `oauth4webapi` 3.8.8 (2026-09-05), `koa` 3.2.1 (2026-05-21), `cookies` 0.9.2 (2026-09-09); all others are years old. `jose` resolved to 6.2.13 (2026-10-20, 4 days old). 6.2.12 (2026-09-05) satisfies both `^6.2.12` (openid-client) and `^6.2.10` (oidc-provider). |

## Findings
1. **RP calls** (S1). Login: `randomPKCECodeVerifier`, `calculatePKCECodeChallenge`,
   `randomState`, `randomNonce`, `buildAuthorizationUrl` with `code_challenge_method=S256`.
   Callback: `authorizationCodeGrant` with the stored verifier, `expectedState`,
   `expectedNonce`, `idTokenExpected: true`. Inside the library: the `iss` response parameter
   (RFC 9207) when the server advertises it, `state` equality, the token response, the ID token
   signature through the discovered JWKS, and `iss`, `aud`, `exp`, `iat` and `nonce`.
2. **Driving the test IdP** (S2, S3). Turn `devInteractions` off. Point `interactions.url` at
   a handler that calls `interactionFinished` with `login: { accountId, acr, amr }`. The test
   decides who logs in and with which `amr`/`acr`. A `loadExistingGrant` that creates and saves
   a Grant for the `openid` scope skips consent. `claims: { openid: ['sub', 'acr', 'amr',
   'auth_time'] }` releases the claims. Signing keys are oidc-provider's in-memory
   development keys, created at runtime. No key material is committed.
3. **Login CSRF** (S4). A record found by `state` alone does not prove that the same browser
   started the login. LedgerForce binds it with a short-lived cookie
   `lf_oidc=<tenant_id>.<state>` (HttpOnly, SameSite=Lax, Path=/auth, 10 minutes). The callback
   accepts the request only when the cookie's state equals the `state` query parameter. Then,
   under the cookie tenant's RLS, it consumes the `app.auth_request` row with that state. This
   is the same "cookie names the tenant, the row proves it" pattern that ADR-0016 uses for
   sessions. It also lets every tenant share one fixed redirect URI (`/auth/callback`), so the
   IdP client needs no per-tenant redirect URIs.
4. **Release age** (S5). Pin `openid-client` 6.8.8 and `oidc-provider` 9.12.2 exactly, and
   override `jose` to 6.2.12 in the root `pnpm.overrides`. Every new lockfile entry is then at
   least 14 days old. `pnpm audit --prod` reports no known vulnerabilities. The repository's
   lockfile already has `nan` 2.30.0 (6 days old), a `testcontainers` dev dependency
   transitive. That is unrelated to this task and recorded for the human.

## Conclusion / decision
Build T-0011 with the S1 calls and the S2/S3 test IdP set-up. Bind the pre-auth record to the
browser with the `lf_oidc` cookie and use one redirect URI, `/auth/callback`. Pin the versions
in finding 4. Decisions DL-0086 to DL-0089.

## Confidence
High. Every API detail was checked against the installed code and a working spike, and the
release dates come from the registry.

Affects: T-0011, ADR-0016 (no change to its decisions; this adds the browser binding and the
fixed callback path).
