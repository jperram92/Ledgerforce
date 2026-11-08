---
id: RQ-0005
title: Salesforce integration auth in 2026 — External Client Apps vs Connected Apps, JWT bearer, PKCE, refresh token rotation
status: resolved
opened: 2026-10-24
resolved: 2026-10-24
opened_by: claude
linked_tasks: []
linked_adrs: [ADR-0007]
---

# RQ-0005 — Salesforce auth for integrations (2026)

## Question

Q1. Status of External Client Apps (ECA) vs Connected Apps today.
Q2. JWT bearer flow requirements (RSA only? pre-authorisation? refresh tokens?).
Q3. Authorization code + PKCE requirements.
Q4. Refresh token rotation behaviour and its impact on a token store.

## Why it matters

ADR-0007 (seed) commits to "ECA with JWT bearer (self-host) and auth code + PKCE (hosted)".
Design §5.2 and threat model §6.1 (token theft).

## Sources consulted

`help.salesforce.com` / `developer.salesforce.com` were not directly fetchable (proxy 403);
facts below come from WebSearch extracts that quote those pages, cross-checked against vendor
notices. Confidence is set accordingly.

| # | Source | Accessed | Kind | What it says |
|---|---|---|---|---|
| S1 | https://www.concret.io/blog/why-new-connected-app-is-greyed-out-in-salesforce-and-how-to-fix-it ; https://truesolv.com/connected-apps-salesforce/ (via WebSearch) | 2026-10-24 | secondary | New Connected App creation disabled by default (Spring '26 for all orgs); existing and packaged Connected Apps keep working; Winter '27 release update "Migrate All Connected Apps to External Client Apps"; support ends Summer '27 (apps keep working, no fixes). |
| S2 | https://help.salesforce.com/s/articleView?id=005390912 "Refresh Token Rotation is Enforced on New External Client Apps" (via WebSearch) | 2026-10-24 | primary (extract) | Dated 2026-10-22: "Enable Refresh Token Rotation" is checked by default **and locked** on every newly created ECA. |
| S3 | https://developer.salesforce.com/docs/platform/isvforce/guide/secure-code-ac-eca.html (via WebSearch) | 2026-10-24 | primary (extract) | Four required controls for partner Connected Apps/ECAs (due 11 May 2026): PKCE, refresh token rotation, 30-day idle refresh-token timeout, refresh-token IP allowlist; non-compliance can lead to de-listing / suspension. Reusing a rotated refresh token → `invalid_grant` and invalidation of the current token family. |
| S4 | https://help.salesforce.com/s/articleView?id=release-notes.rn_security_refresh_token_rotation.htm (via WebSearch) | 2026-10-24 | primary (extract) | RTR: each refresh issues a new refresh token and invalidates the old one. |
| S5 | https://docs.withampersand.com/customer-guides/salesforce-jwt (via WebSearch) | 2026-10-24 | secondary | JWT bearer: RSA ≥2048-bit certificate, RS256; ECDSA not supported; subject user must be pre-authorised (admin-approved + permission set); **no refresh token returned**; misconfiguration surfaces as `invalid_grant`. |
| S6 | https://airbyte.com/agentic-data/salesforce-oauth-saas-integrations (design source) | 2026-10-24 | secondary | ECAs do not support the username-password flow. |

## Findings

1. **ECA is the only forward path (S1).** Connected App *creation* is off by default; ECAs are
   the recommended replacement; Connected App support ends Summer '27. Design choice confirmed.
2. **JWT bearer (S5, design §5.2 claim confirmed):** sign an assertion (`iss` = consumer key,
   `sub` = integration username, `aud` = login/test URL, `exp` ≤ 3 min) with an **RSA** private
   key (RS256, ≥2048 bit); upload the X.509 cert to the ECA; set "Admin approved users are
   pre-authorized" and assign the integration user's permission set. Response has an access token
   and **no refresh token** — re-sign on 401/expiry. Requires no client secret.
3. **Auth code + PKCE (S3):** S256 challenge mandatory for partner apps; enable "Require PKCE"
   on the ECA used for hosted installs. Keep the JWT ECA separate from the PKCE ECA (the PKCE
   setting is irrelevant to JWT and some guides advise leaving it off on JWT apps).
4. **Refresh token rotation (S2–S4):** forced on new ECAs. Every refresh returns a *new* refresh
   token; using an old one returns `invalid_grant` and revokes the family. Partner apps also face
   a 30-day idle timeout and IP allowlisting.
5. Username-password flow is unavailable on ECAs (S6) — irrelevant to us but rules out shortcuts
   in tests; use JWT against scratch orgs.

## Conclusion / decision

- ADR-0007 stands: **ECA + JWT bearer** (self-host) and **ECA + auth code + PKCE** (hosted).
- Token store must implement **single-flight refresh per org** (row lock on the org's
  credential row), persist the rotated refresh token in the same transaction that consumes the
  old one, and treat `invalid_grant` as "re-consent required" (Sync issues inbox + alert), not as
  a retryable error.
- Run a scheduled no-op refresh at least every 25 days per hosted org to beat the 30-day idle
  expiry; record the hosted egress IP range for the allowlist.
- JWT: RSA-2048+ certificates, 12-month rotation with overlap (design §5.2), no refresh tokens
  stored for self-host.

## Confidence

Medium-high. Direction (ECA, RSA-only JWT, RTR forced) is consistent across Salesforce extracts
and vendor notices dated Oct 2026; exact UI labels may differ — verify in a scratch org.

## Follow-ups

- Scratch-org spike producing a recorded token exchange (JWT + PKCE) as contract-test fixtures.
- Security ADR addendum (human gate): token storage, rotation, re-consent UX.

**Affects:** `packages/connectors/salesforce` auth, secrets/KMS module, setup wizard step 5,
design §5.2, §6.1, ADR-0007.
