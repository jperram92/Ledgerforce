---
id: RQ-0024
title: Salesforce JWT bearer token exchange — exact request, response, error codes and certificate handling
status: resolved
opened: 2026-10-24
resolved: 2026-10-24
opened_by: claude
linked_tasks: [T-0063]
linked_adrs: [ADR-0007, ADR-0018]
superseded_by:
---

# RQ-0024 — Salesforce JWT bearer token exchange (self-host connection)

## Question

Q1. What exactly does the JWT bearer assertion contain (header, `iss`, `sub`, `aud`, `exp`), and
which audience values are valid?
Q2. What is the token request (endpoint, method, encoding, parameters)?
Q3. What does a successful response contain, and does it carry an expiry or a refresh token?
Q4. Which errors does the token endpoint return, and what does each mean for an operator?
Q5. Which key and certificate rules apply (algorithm, size, expiry), and how do we learn the
certificate expiry without contacting Salesforce?

## Why it matters

T-0063 builds the self-host connection of ADR-0007 (design §5.2) and stores its secrets with
envelope encryption (§6.1 "integration token theft", §6.6, ADR-0018). A wrong claim or endpoint
only shows up against a real org, which CI never contacts, so the offline contract must follow
the published behaviour as closely as we can establish it.

## Sources consulted

Direct fetches of `help.salesforce.com`, `developer.salesforce.com` and `www.rfc-editor.org`
failed in this session (DNS failure in WebFetch; proxy `CONNECT` 403 with curl). Every fact below
therefore comes from WebSearch extracts quoting those pages, plus secondary sources. RQ-0005 hit
the same limit.

| # | Source | Accessed | Kind | What it says |
|---|---|---|---|---|
| S1 | https://developer.salesforce.com/docs/platform/named-credentials/references/named-credentials-reference/jwt-claims.html (via WebSearch) | 2026-10-24 | primary (extract) | `aud` is the authorization server's URL: `https://login.salesforce.com`, `https://test.salesforce.com`, or the site URL for Experience Cloud. `exp` is seconds since the epoch; Salesforce allows 3 minutes for clock skew. |
| S2 | https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_jwt_flow.htm (via WebSearch; design §5.2 source) | 2026-10-24 | primary (extract) | Server-to-server flow; the JWT is signed with the private key of the certificate uploaded to the app; the app must be pre-authorised; no client secret is sent. |
| S3 | https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_flow_errors.htm (via WebSearch) | 2026-10-24 | primary (extract) | `invalid_grant` causes for the JWT bearer flow: invalid user credentials, invalid user, invalid assertion, invalid audience, IP restricted or invalid login hours, user hasn't approved the connected app. Refers to RFC 7523 for JWT bearer errors. |
| S4 | https://www.authlete.com/developers/jwt_authorization_grant ; https://docs.authlib.org/en/1.7.1/oauth2/specs/rfc7523.html (via WebSearch) | 2026-10-24 | secondary (quotes RFC 7523) | RFC 7523 §2.1: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` with `assertion=<JWT>`; an invalid JWT gives `error=invalid_grant`; RFC 7523 adds no response parameters. |
| S5 | https://www.apexhours.com/salesforce-oauth-2-0-jwt-bearer-flow/ ; https://medium.com/@dcheng_93016/understanding-salesforce-oauth-2-0-flows-a-practical-guide-ab2986eca610 ; https://gist.github.com/booleangate/30d345ecf0617db0ea19c54c7a44d06f (via WebSearch) | 2026-10-24 | secondary | Claims: `iss` = consumer key (client id), `sub` = username, `aud` = login URL, `exp`; token endpoint `https://login.salesforce.com/services/oauth2/token`; **no refresh token** is issued, a new JWT is sent for another access token. |
| S6 | https://sfdcdevelopers.com/2026/09/14/salesforce-webhook-integration-with-jwt-bearer-flow/ (via WebSearch) | 2026-10-24 | secondary | Use the `instance_url` from the token response for later API calls rather than a hard-coded My Domain. |
| S7 | https://www.useparagon.com/integration-error-solutions/salesforce-invalid-grant-audience-is-invalid ; https://trailhead.salesforce.com/trailblazer-community/feed/0D54V00007ZB3sdSAD ; https://help.boomi.com/docs/Atomsphere/Data_Integration/Sources/Applications/Salesforce/jwt-bearer-salesforce (via WebSearch) | 2026-10-24 | secondary / community | Error strings seen in practice: `invalid_grant` "user hasn't approved this consumer" (not pre-authorised, or user lacks the permission set/profile); "audience is invalid" (production vs sandbox `aud`, or token request sent to the wrong host); "invalid assertion" (clock skew so `exp` is past, expired certificate, or key does not match the uploaded certificate); `unsupported_grant_type` (app lacks OAuth settings with digital signatures/certificate). |
| S8 | https://salesforcedictionary.com/errors/invalid-oauth-grant ; https://www.useparagon.com/integration-error-solutions/salesforce-ip-invalid-grant-ip-restricted (via WebSearch) | 2026-10-24 | secondary | "inactive user" (deactivated or frozen user); "ip restricted or invalid login hours" (app or profile IP policy). |
| S9 | RQ-0005 (S5: Ampersand) | 2026-10-24 | secondary | RSA certificates only (RS256), ≥ 2048-bit; ECDSA unsupported. |
| S10 | Node.js 22 `node:crypto` (`createSign('RSA-SHA256')`, `createPrivateKey().asymmetricKeyDetails.modulusLength`, `X509Certificate.validTo/.publicKey/.fingerprint256`) — executed locally | 2026-10-24 | experiment | Everything needed to sign RS256, check the key size, read the certificate expiry and check that the private key matches the certificate is in the standard library. |

## Findings

1. **Assertion (S1, S2, S5, S9).** Header `{"alg":"RS256"}` (`typ` "JWT" is conventional);
   claims `iss` = External Client App consumer key, `sub` = integration username, `aud` =
   `https://login.salesforce.com` (production, developer edition) or `https://test.salesforce.com`
   (sandbox, scratch org), `exp` = epoch seconds. S1 says Salesforce allows 3 minutes; secondary
   sources read it as "at most 3 minutes in the future". We take the strict reading (design §5.2
   and ADR-0007 say ≤ 3 min). RSA ≥ 2048 bits; ECDSA is not accepted.
2. **Request (S4, S5).** `POST <login URL>/services/oauth2/token`,
   `Content-Type: application/x-www-form-urlencoded`, body
   `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<JWT>`. No client secret.
3. **Response (S5, S6).** JSON with `access_token` and `instance_url`; commonly also `id`,
   `token_type` ("Bearer"), `scope` and `issued_at` (ms since epoch, as a string). *Inference:*
   no `expires_in` and no `refresh_token` — the access token lives as long as the org's session
   timeout, and a new assertion is signed when it is rejected. We could not confirm the full
   field list from a primary page, so only `access_token` and `instance_url` are required by the
   parser; other fields are optional.
4. **Errors (S3, S4, S7, S8).** HTTP 400 with `{"error": "...", "error_description": "..."}`.
   Codes the connector distinguishes:

   | `error` | `error_description` contains | Meaning | LedgerForce code | Retry? |
   |---|---|---|---|---|
   | invalid_grant | user hasn't approved this consumer | app not pre-authorised for the user / permission set missing | `not_preauthorized` | no — admin action |
   | invalid_grant | audience is invalid | `aud` ≠ login/test URL, or wrong host | `invalid_audience` | no — config |
   | invalid_grant | invalid assertion | bad signature, wrong key, expired certificate, `exp` past (clock skew) | `invalid_assertion` | no — config/clock |
   | invalid_grant | inactive user / invalid user / user is not active | user deactivated, frozen or unknown | `invalid_user` | no — admin action |
   | invalid_grant | ip restricted or invalid login hours | IP policy or login hours | `ip_restricted` | no — admin action |
   | invalid_grant | anything else | unclassified grant failure | `invalid_grant` | no |
   | invalid_client_id / invalid_client | — | unknown consumer key | `invalid_client` | no |
   | unsupported_grant_type | — | app lacks OAuth + digital signature settings | `unsupported_grant_type` | no |
   | (HTTP 5xx, network error, non-JSON body) | — | endpoint unavailable | `token_endpoint_unavailable` | yes, with back-off |
   | (2xx without `access_token`/https `instance_url`) | — | malformed response | `malformed_response` | no |

   Exact description wording varies between sources (S3 table vs. strings seen in S7/S8), so the
   match is case-insensitive on a substring, and anything unrecognised still maps to a stable
   code. The description is kept (truncated) for the operator; it never contains the assertion.
5. **Certificate (S2, S9, S10).** The certificate is uploaded to the External Client App; the
   private key stays with LedgerForce. The certificate's `notAfter` is public data and can be read
   offline with `X509Certificate`, so the expiry alert needs no call to Salesforce. Uploading a key
   that does not match the certificate is the usual cause of "invalid assertion" (S7), so the
   connector checks the pair before saving (S10).
6. **Packaging (inference, RQ-0022).** The ECA itself (consumer key, certificate, pre-authorised
   permission set `LF_Integration_User` from T-0062) is created by the org admin; its OAuth
   settings embed an org-specific certificate, so it is not part of the unlocked package.

## Conclusion / decision

- Sign with `node:crypto` (`RSA-SHA256`), header `{"alg":"RS256","typ":"JWT"}`, claims
  `iss`, `sub`, `aud`, `iat`, `exp` with `exp − now ≤ 180 s` (default 180), plus a random `jti`
  (harmless, RFC 7523 allows it). Refuse non-RSA and < 2048-bit keys before signing.
- `aud` and the token host are one configured value: `https://login.salesforce.com` or
  `https://test.salesforce.com`; the endpoint is `<aud>/services/oauth2/token`. No other host is
  stored, so a misconfigured row cannot send assertions elsewhere.
- Parse only `access_token` and an `https://` `instance_url` as required; map errors per the
  table above.
- Store the private key and the access token with envelope encryption (ADR-0018), the
  certificate's `notAfter` and SHA-256 fingerprint in clear; no refresh token exists for this flow.
- Re-sign when the cached token is older than the cache window or after a 401 (cache window:
  DL-0106).

## Confidence

Medium. Claims, endpoint, grant type and the absence of refresh tokens are consistent across a
Salesforce page extract (S1), the RFC (via S4) and several secondary sources. Exact
`error_description` strings and the optional response fields come from extracts and community
reports, so the mapper is substring-based with a safe default, and the fixtures are labelled
*documented* (written from these sources), not *recorded*.

## Follow-ups

- Scratch-org spike (needs a human-authorised org): record and redact one success and the
  `not_preauthorized`, `invalid_audience` and `invalid_assertion` responses into
  `packages/connectors/salesforce/fixtures/recorded/`, and confirm the response field list.
- Re-try `help.salesforce.com` / `developer.salesforce.com` when the proxy allows them.
- Scheduled job + notification for the expiry alert (later connector task).

**Affects:** `packages/connectors/salesforce`, migration 0017, ADR-0007 (compliance rows for JWT),
ADR-0018 (new sealed fields), design §5.2, §6.1, §6.6.
