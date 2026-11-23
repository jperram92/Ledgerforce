---
adr: 0105
title: "Bills mailbox OAuth2: delegated authorization code + PKCE, IMAP XOAUTH2, sealed refresh token rotated in place"
status: Accepted
date: 2026-11-23
author: claude
category: security
human_gate: yes (delegated, DL-0691)
supersedes: none
superseded_by: none
---

# ADR-0105: Bills mailbox OAuth2 — delegated authorization code + PKCE, IMAP XOAUTH2, sealed refresh token rotated in place

## Status

Accepted 2026-11-23 by the building agent under the product owner's standing instruction DL-0691
(security decisions delegated on condition of research, a decision-log entry, tests and an
independent security review): research RQ-0187, decisions DL-0930..DL-0935, tests listed below.
The independent security review is part of T-0216's cross-provider review step.

Amends ADR-0095 rule 4 (credentials are write-once): on OAuth mailboxes the sealed refresh token
is replaced in place when the provider rotates it. Everything else in ADR-0095 stands.

## Context and problem statement

ADR-0095 polls the bills mailbox with a username and password. Exchange Online refuses
passwords for IMAP (RQ-0177 F3) and Google prefers OAuth, so the poller must authenticate with
OAuth2 access tokens (`AUTHENTICATE XOAUTH2`), and an administrator must be able to grant
LedgerForce a long-lived token from Settings. This touches the security model: a standing grant
to read the company's mail, a browser redirect flow, and a secret that changes on every use.

## Decision drivers

- Works for Microsoft 365 and Google Workspace without PowerShell or console work per mailbox.
- OAuth 2.0 Security BCP (RFC 9700): PKCE, single-use `state`, exact redirect URI.
- Secrets only envelope-encrypted (ADR-0018); never returned, logged or audited in clear.
- No new runtime dependency (AGENTS.md §4).
- A dead or revoked grant must be visible and recoverable (reconnect), not silently stop bills.

## Considered options

1. **Delegated authorization code + PKCE (chosen)** for both providers — the administrator signs
   in as (or for) the mailbox in the browser; comparable products ship this (RQ-0187 S9).
2. **Microsoft app-only (client credentials) / Google service-account delegation** — unattended,
   but needs Exchange PowerShell (`New-ServicePrincipal`, `Add-MailboxPermission`) or Workspace
   admin console work per deployment (RQ-0187 F2, F3). Deferred to T-0238, not rejected.
3. **Library (`openid-client`, `imapflow`)** — rejected: OIDC-centred / many transitive
   dependencies for four HTTPS calls and one SASL command (RQ-0187 F7, ADR-0095).

## Decision outcome

Chosen option 1:

1. **Providers (fixed, not operator-editable):**
   - `microsoft`: authorize/token at `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/…`
     (`<tenant>` from configuration, default `organizations`), scope
     `https://outlook.office.com/IMAP.AccessAsUser.All offline_access`, IMAP
     `outlook.office365.com:993`.
   - `google`: `https://accounts.google.com/o/oauth2/v2/auth`, `https://oauth2.googleapis.com/token`,
     scope `https://mail.google.com/`, `access_type=offline`, `prompt=consent`, IMAP
     `imap.gmail.com:993`.
   The IMAP host of an OAuth mailbox is the provider's; an access token is never sent to an
   operator-entered host.
2. **Client registration is install configuration.** One app registration per provider per
   deployment: client id, client secret (env or `_FILE`), redirect URI
   (`LF_MAILBOX_OAUTH_REDIRECT_URI`, exact). Never stored per company, never in the database.
   A provider without configuration answers 503 `oauth_not_configured`.
3. **Start** — `POST /setup/bills-mailbox/oauth/start` `{company_id, provider, username, folder?}`:
   `settings.setup.manage` + step-up (300 s) + Idempotency-Key. Creates a pre-auth row in
   `app.bill_inbox_oauth_request` (tenant-owned, RLS): SHA-256 of a 256-bit `state`, PKCE
   verifier (43 chars, S256 challenge sent), provider, username, folder, the starting user and
   session, `expires_at` = +10 min. Answers the authorization URL (with `login_hint`); the
   browser goes there. Audited (no state, no verifier).
4. **Callback** — `GET /setup/bills-mailbox/oauth/callback?code&state` (the redirect URI):
   `settings.setup.manage`; the pre-auth row is found by the state's hash and consumed once
   (`consumed_at`, unexpired) **only if it belongs to the same user and session**; then the code
   is exchanged with the verifier and the client secret; the answer must contain an access token
   and a refresh token. The mailbox is saved (rule 5) and the browser is redirected (303) to the
   Settings page with `?mailbox=connected` or `?mailbox_error=<fixed code>`; provider error text is
   never shown or stored. The callback writes its own audit row (GET requests are not audited by
   the interceptor): `ap.bills_mailbox.oauth_connected` with provider, host, username, folder.
5. **Storage.** `app.bill_inbox_mailbox` gains `auth_method` (`password` | `oauth2`, default
   `password`), `oauth_provider` and `secret_rotated_at` (migration 0084). On OAuth rows the
   existing sealed-secret columns hold the **refresh token**, AAD
   `lf-field-v1|<tenant>|<company>|app.bill_inbox_mailbox|<id>|refresh_token` (a different field
   name from `password`, so neither can be opened as the other). Connecting supersedes the active
   mailbox as before (a new row).
6. **Rotation in place.** When a refresh returns a new refresh token, the poller re-seals it into
   the same row (same AAD) and sets `secret_rotated_at`. `lf_app` gets UPDATE on the secret
   columns, and a trigger allows that update only on `oauth2` rows that are `active`, and only
   together with `secret_rotated_at`; identity columns stay non-updatable. Old refresh tokens are
   not kept (Microsoft recommends discarding them, RQ-0187 S4).
7. **Polling.** For an OAuth row the poller opens the refresh token, calls the token endpoint
   (outside any database transaction), then `AUTHENTICATE XOAUTH2` with SASL-IR; a `+` challenge
   is answered with an empty line and the tagged NO becomes `auth_failed`. Token endpoint
   `invalid_grant`/`unauthorized_client`/`invalid_client` → `auth_failed` (administrator must
   reconnect); network failure, timeout, 5xx, oversized or malformed answer → `connect_failed`.
   Token HTTP calls: HTTPS only, `redirect: 'error'`, 15 s timeout, 64 KiB answer bound.
8. **No secret leaves.** Reads (`listBillsMailboxes`) return `auth_method` and `oauth_provider`,
   never a token; access tokens are never persisted or logged; errors carry fixed text.

### Operator notes

- Microsoft: register a web app in Entra ID, redirect URI = `LF_MAILBOX_OAUTH_REDIRECT_URI`,
  delegated permission *Office 365 Exchange Online → IMAP.AccessAsUser.All* (+ `offline_access`),
  a client secret; IMAP must be enabled for the mailbox. Refresh tokens expire after 90 days
  without use — a 5-minute poll keeps them alive.
- Google: an OAuth client of type *Web application*, scope `https://mail.google.com/`, app
  published **In production** (Testing-status grants expire after 7 days).

### Consequences

- Good: Microsoft 365 and Google mailboxes work; no new dependency; the grant is revocable at
  the provider and replaceable by reconnecting; the secret model stays ADR-0018.
- Bad: delegated grants die when the signing-in user loses access or the provider revokes them —
  the row shows `auth_failed` until someone reconnects (UI hint: T-0237); the secret columns are
  now updatable on OAuth rows (narrowed by trigger).
- Follow-ups: T-0237 (settings API for password mailboxes, test connection, inbound address,
  screen), T-0238 (app-only / service-account grants).

## Validation

- `packages/modules/ap/src/mailbox-oauth.test.ts` — SS-PLAT-189: RFC 7636 vector, authorization
  URL contents per provider, code exchange and refresh against recorded token responses, error
  mapping, HTTPS/size/redirect limits, no secret in errors.
- `packages/modules/ap/src/imap-client.test.ts` — SS-PLAT-190: XOAUTH2 initial response equals
  Google's published vector; the fake server accepts a valid token and the client maps the
  JSON challenge to `auth_failed`.
- `packages/modules/ap/src/inbox-mailbox-oauth.db.test.ts` — SS-PLAT-191: an OAuth mailbox polls
  through a recorded refresh, the rotated refresh token is re-sealed in place, AAD binding,
  `invalid_grant` → `auth_failed`, trigger refuses secret updates on password rows.
- `apps/api/src/ap/bills-mailbox-oauth.db.test.ts` — SS-PLAT-192: start needs permission and
  step-up and returns a PKCE URL; callback bound to session and user, single use, expiry,
  connects the mailbox without returning a secret; audit rows.
- `packages/db/src/rls.db.test.ts` generated cross-tenant suite covers `app.bill_inbox_oauth_request`.

## Links

RQ-0187, RQ-0177, ADR-0095, ADR-0018, ADR-0016, ADR-0025, DL-0691, T-0216, T-0237, T-0238.
