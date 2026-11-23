---
id: RQ-0187
title: Bills mailbox OAuth2 for IMAP - SASL XOAUTH2, Microsoft 365 delegated vs app-only, Google, authorization code + PKCE, refresh-token storage
status: answered
opened: 2026-11-23
resolved: 2026-11-23
opened_by: claude
linked_tasks: [T-0216, T-0237, T-0238, T-0127]
linked_adrs: [ADR-0105, ADR-0095, ADR-0018, ADR-0016, ADR-0025]
superseded_by:
---

# RQ-0187 — Bills mailbox OAuth2 for IMAP

## Question

T-0127 (ADR-0095) polls the company's bills mailbox over IMAP with a username and password.
Microsoft 365 has refused passwords for IMAP since 2022 (RQ-0177 F3, S6) and Google Workspace
steers to OAuth. T-0216 must add OAuth2. Sub-questions:

- **Q1** What exactly does a client send for SASL `XOAUTH2` over IMAP, and how does a failure
  look on the wire?
- **Q2** Microsoft 365: delegated (authorization code, `IMAP.AccessAsUser.All`) or app-only
  (client credentials)? RQ-0177 S7 found sources disagreeing on app-only.
- **Q3** Google Workspace: scope and how a long-lived (offline) grant is obtained; limits.
- **Q4** How is the authorization code flow secured for a server-side (confidential) client:
  PKCE, `state`, redirect URI, binding to the signed-in administrator?
- **Q5** What is stored, where and how: refresh tokens (rotation by Microsoft), client secrets,
  pending authorization requests?
- **Q6** Which error classes does the poller record when the grant fails, and what do
  comparable products do?
- **Q7** Library or in-house? (AGENTS.md §4: a new runtime dependency needs an ADR.)

## Why it matters

Design §6 (security) and §6.6 (secrets): a mailbox OAuth grant is a standing credential to read
the company's mail. UC-05: without OAuth the bills inbox cannot work on Microsoft 365 at all.

## Sources consulted

Network note (2026-11-23): `learn.microsoft.com` and `developers.google.com` did **not resolve**
from this session (web fetcher: ENOTFOUND). Vendor facts come from web-search extracts of those
pages (marked), standards text, community reports of comparable products, and two reproducible
spikes against published test vectors.

| # | Source (URL or command) | Accessed | Kind | What it says |
|---|---|---|---|---|
| S1 | learn.microsoft.com/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth (search extract) | 2026-11-23 | primary (extract) | Delegated IMAP uses scope `https://outlook.office.com/IMAP.AccessAsUser.All` (plus `offline_access` for a refresh token); the access token is sent as SASL XOAUTH2 to `outlook.office365.com:993`. App-only: client credentials with scope `https://outlook.office365.com/.default`, application permission `IMAP.AccessAsApp`, admin consent, and the service principal registered in Exchange Online PowerShell (`New-ServicePrincipal`) and granted the mailbox (`Add-MailboxPermission`). |
| S2 | techcommunity.microsoft.com Exchange Team blog "Announcing OAuth 2.0 client credentials flow support for POP and IMAP protocols in Exchange Online" (search extract, 2022) | 2026-11-23 | primary (extract) | App-only (client credentials) **is supported** for IMAP/POP since June 2022; tokens are used in SASL XOAUTH2 format; mailbox access is granted with Exchange Online PowerShell. Older pages saying "not supported" predate this (explains RQ-0177 S7's conflict). |
| S3 | learn.microsoft.com/answers (several threads on IMAP.AccessAsUser.All / `/.default`) (search extract) | 2026-11-23 | secondary | Client-credentials requests must use the `/.default` scope; `IMAP.AccessAsUser.All` is delegated only. A Graph-audience token does not authenticate to IMAP (osTicket threads, S9, agree). |
| S4 | learn.microsoft.com/entra/identity-platform/refresh-tokens (search extract) | 2026-11-23 | primary (extract) | Default refresh-token lifetime 90 days (24 h for SPAs), not configurable; "refresh tokens are replaced with a fresh token upon every use"; the platform "doesn't revoke old refresh tokens when used to fetch new access tokens"; clients should securely delete the old refresh token after acquiring a new one. Q&A answers describe the lifetime as an inactivity window. |
| S5 | developers.google.com/gmail/imap/xoauth2-protocol (search extract) | 2026-11-23 | primary (extract) | Initial client response = base64(`user=` {user} `^A` `auth=Bearer ` {token} `^A^A`). On failure the server answers the AUTHENTICATE with a continuation `+ <base64 JSON>` (status 401, schemes Bearer, scope `https://mail.google.com/`); the client must answer with an empty line, after which the server sends the tagged `NO`. Scope `https://mail.google.com/`. |
| S6 | groups.google.com adwords-api / google-cloud-dev threads; unipile.com blog (search extract) | 2026-11-23 | secondary | Google refresh tokens of an OAuth app in "Testing" status expire after 7 days (`invalid_grant`); at most 100 refresh tokens per Google account per client id (the oldest is silently invalidated); unused refresh tokens can expire after ~6 months (unverified). |
| S7 | RFC 7636 (PKCE) §4.1–4.6 and Appendix B; RFC 6749 §4.1, §5.2, §6, §10.12; RFC 9700 (OAuth 2.0 Security BCP) §2.1.1, §4.5 | 2026-11-23 (standard text) | primary | Verifier 43–128 chars `[A-Za-z0-9-._~]`; S256 challenge = BASE64URL(SHA-256(verifier)). Test vector: verifier `dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk` → challenge `E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM`. Token errors are JSON `{error}`; `invalid_grant` = the code/refresh token is invalid, expired or revoked. `state` binds the response to the user agent's session (CSRF). The BCP recommends PKCE for confidential clients too, exact redirect-URI matching, and single-use `state`/codes. |
| S8 | RFC 4959 (IMAP SASL-IR) §3; RFC 3501 §6.2.2 (AUTHENTICATE) | 2026-11-23 (standard text) | primary | With the `SASL-IR` capability the initial response is sent on the `AUTHENTICATE` line; a server challenge is a `+` continuation; the client answers each challenge with one line; `*` cancels. |
| S9 | community.freshworks.com "Reauthorization required for Microsoft Office 365 OAuth mailbox"; support.freshworks.com "Reauthorization of custom mailbox"; docs.osticket.com OAuth2 (Microsoft deprecations 2024); forum.osticket.com threads (search extract) | 2026-11-23 | secondary (comparable products) | Freshdesk connects Microsoft 365 mailboxes by **delegated OAuth sign-in** over IMAP 993; on token failure it retries, then marks the mailbox *disconnected* and shows a *reauthorization* banner. osTicket also uses delegated authorization code; it refreshes with the stored refresh token before fetching; Graph tokens fail on IMAP. |
| S10 | Repository: `apps/api/src/auth/oidc.service.ts` + `0014_auth_oidc.sql` (`app.auth_request`), `packages/shared/src/crypto` (`sealField`, ADR-0018), `packages/modules/ap/src/inbox-mailbox.ts`, `apps/api/src/setup/bank-accounts-settings.controller.ts` | 2026-11-23 | source code | Existing patterns: authorization code + PKCE S256 + state, pre-auth row with a 10-minute TTL consumed once; envelope encryption with AAD `lf-field-v1|tenant|company|table|row|field`; settings writes need `settings.setup.manage` + 300 s step-up + Idempotency-Key + audit. |
| X1 | Spike: `node -e 'console.log(Buffer.from("user=someuser@example.com\x01auth=Bearer ya29.vF9dft4qmTc2Nvb3RlckBhdHRhdmlzdGEuY29tCg\x01\x01").toString("base64"))'` | 2026-11-23 | experiment | `dXNlcj1zb21ldXNlckBleGFtcGxlLmNvbQFhdXRoPUJlYXJlciB5YTI5LnZGOWRmdDRxbVRjMk52YjNSbGNrQmhkSFJoZG1semRHRXVZMjl0Q2cBAQ==` — identical to Google's published example (S5). Used as a unit-test vector. |
| X2 | Spike: `node -e 'console.log(require("crypto").createHash("sha256").update("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk").digest("base64url"))'` | 2026-11-23 | experiment | `E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM` — equals RFC 7636 Appendix B. Used as a unit-test vector. |

## Findings

1. **Q1 — XOAUTH2.** Send `AUTHENTICATE XOAUTH2 <base64(user=U^Aauth=Bearer T^A^A)>` in one line
   (SASL-IR, S8; both Gmail and Exchange Online advertise it). If the server answers a `+`
   continuation (Google's JSON error challenge, S5), reply with one empty line; the tagged `NO`
   follows → `auth_failed`. The username must not contain `^A`, CR, LF; the token must be
   printable ASCII without spaces. The encoding is confirmed byte-exactly (X1). Access tokens
   (Microsoft ≈ 2–3 KB) fit the 64 KiB line bound.
2. **Q2 — Microsoft 365.** Both flows work today (S1, S2; S7's conflict came from pre-2022 pages).
   App-only requires an Exchange administrator to run PowerShell (`New-ServicePrincipal`,
   `Add-MailboxPermission`) per mailbox — not doable from a browser and error-prone for an SMB
   operator. Delegated authorization code with `IMAP.AccessAsUser.All offline_access` is what
   comparable products ship (S9) and works the same way as Google. **Decision: delegated first**
   (this card); app-only is follow-up card **T-0238** for operators who prefer an unattended
   service principal. The token audience must be Outlook, not Graph (S3).
3. **Q3 — Google.** Scope `https://mail.google.com/` (S5; the only Gmail scope that allows IMAP).
   A refresh token needs `access_type=offline`; `prompt=consent` makes Google return one on
   reconnect too. Operators must publish the OAuth app ("In production"), otherwise grants die
   after 7 days (S6) — documented in the operator notes of ADR-0105. Service-account domain-wide
   delegation (JWT bearer) is an alternative for Workspace admins; folded into T-0238.
4. **Q4 — securing the code flow.** Authorization code + PKCE S256 even though the server is a
   confidential client (S7 BCP; the OIDC login already does this, S10). `state` = 256-bit random,
   stored only as its SHA-256 in a tenant-owned pre-auth row with a 10-minute TTL, consumed once,
   and **bound to the administrator's session id and user id** (a callback carrying another
   session's state is refused — login-CSRF/mailbox-swap protection). Starting the flow needs
   `settings.setup.manage` + a 300 s step-up (as other credential settings, S10); the callback
   needs the same permission and the same session. Redirect URI exact, from configuration. The
   PKCE verifier sits in the pre-auth row like `app.auth_request.code_verifier` (useless without
   the one-time code; expires in 10 minutes).
5. **Q5 — storage.** Refresh token envelope-encrypted with the existing KMS (ADR-0018) in the
   mailbox row's secret columns, AAD field **`refresh_token`** (a sealed password cannot be
   replayed as a refresh token or vice versa). Microsoft replaces the refresh token on every use
   and recommends discarding the old one (S4): the poller re-seals the new token **in place** on
   OAuth rows only (through a narrow SECURITY DEFINER function, a trigger refuses it on password rows; DL-0936); no history of old refresh tokens is
   kept (a retained old token would be a live credential for up to 90 days). Access tokens are
   never stored (one per poll, in memory). The OAuth **client id/secret are install-level
   configuration** (one app registration per provider per deployment, read from env/secret
   files like the OIDC client), never per company and never in the database.
6. **Q6 — errors.** Token endpoint `invalid_grant` (revoked, expired, Testing-status 7-day
   expiry, password reset) → `auth_failed` on the row: the administrator must reconnect
   (Freshdesk's "reauthorization" state, S9). Transport failure, timeout, 5xx or unparsable
   answer → `connect_failed` (the next poll retries). Existing error classes suffice; the
   forward-only runner cannot widen the `last_error` CHECK anyway (precedent 0073). No provider
   error text is stored or returned (it may echo the account).
7. **Q7 — in-house.** The flows are four HTTPS form POSTs/redirects (authorize URL, code
   exchange, refresh) plus SHA-256 and base64url — about 200 lines with `fetch` and
   `node:crypto`. `openid-client` (already used by apps/api) is OIDC-centred (discovery, ID
   tokens) and would become a new dependency of `@ledgerforce/ap` and the worker; not needed.
   **No new runtime dependency.** Token responses are bounded (64 KiB), time-limited (15 s), HTTPS
   only, redirects not followed; tests use recorded token responses through an injected `fetch`.

## Conclusion

Build delegated OAuth2 (authorization code + PKCE S256) for Microsoft 365 (`outlook.office365.com`,
scopes `https://outlook.office.com/IMAP.AccessAsUser.All offline_access`) and Google Workspace
(`imap.gmail.com`, scope `https://mail.google.com/`, `access_type=offline`, `prompt=consent`),
IMAP `AUTHENTICATE XOAUTH2` with SASL-IR, refresh token sealed (AAD field `refresh_token`) and
rotated in place, client credentials as install configuration, start = permission + step-up,
callback bound to the starting session. Decisions in ADR-0105 and DL-0930..DL-0935. App-only /
service-account flows: T-0238. Password-mailbox settings API, test connection, inbound address
and the screen: T-0237.

## Follow-ups

- T-0237 — mailbox settings API (password mailboxes, test connection, inbound address show and
  rotate) and the Settings screen (T-0216 AC-1, AC-2, AC-4).
- T-0238 — unattended grants: Microsoft app-only (client credentials) and Google service-account
  domain-wide delegation.
