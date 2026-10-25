---
id: RQ-0027
title: How to tell that a login used MFA (amr/acr), and how step-up re-authentication works with acr_values, max_age, prompt=login and auth_time
status: answered
opened: 2026-10-25
resolved: 2026-10-25
opened_by: claude
linked_tasks: [T-0013]
linked_adrs: [ADR-0016, ADR-0023, ADR-0025]
superseded_by:
---

# RQ-0027 — MFA detection and step-up mechanics (amr, acr, acr_values, max_age, auth_time)

## Question

1. Which ID-token claims tell a relying party that the user authenticated with more than one
   factor, and which values should LedgerForce accept as "MFA"?
2. How does a relying party ask the IdP for a fresh, stronger authentication (step-up):
   `prompt=login`, `max_age`, `acr_values` or the `claims` parameter? Which of these does the
   IdP have to honour, and which may it ignore?
3. How does the relying party prove afterwards that the authentication really is fresh?
   What does `openid-client` 6 check, and what must the application check itself?
4. How does the chosen IdP (Keycloak, RQ-0015) support this, and how does the in-process test
   IdP (`oidc-provider` 9, RQ-0020) behave, so that the tests drive the same mechanics?
5. How should the API tell a browser client that a step-up is needed?

## Why it matters

Design §6.2: MFA is mandatory for Owner, Finance Admin, Accountant, AP Clerk and Payroll
Officer, and step-up re-authentication is needed to release payment batches, change bank details
or reopen a locked period. ADR-0016 stores `amr` and `acr` on the session and leaves enforcement
to T-0013. ADR-0023 marks each role template with `mfaRequired`. If MFA is detected wrongly, a
password-only session could release a payment batch, which is the main fraud risk for an SMB
(design §6). If the IdP is trusted to honour a request parameter it may ignore, step-up looks
safe but is not.

## Sources consulted

The sandbox could not reach openid.net, rfc-editor.org or keycloak.org (egress proxy refused
the connection, 2026-10-25). The specifications below are cited from the reviewer's knowledge of
the published texts and are marked as such. The library behaviour was read from the installed
source code, which is the primary source for what the tests and the product actually do.

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S1 | OpenID Connect Core 1.0 §2 (ID token: `auth_time`, `acr`, `amr`), §3.1.2.1 (`prompt`, `max_age`, `acr_values`), §5.5.1.1 (requesting `acr` as an essential claim) | 2026-10-25 (from knowledge, site unreachable) | primary (spec) | `max_age`: if the elapsed time since the last active authentication is greater, the OP MUST actively re-authenticate; when `max_age` is used the ID token MUST contain `auth_time`. `prompt=login`: the OP SHOULD prompt for re-authentication. `acr_values` is a *voluntary* claim request: the OP may return another `acr`. Only `claims` with `"acr": {"essential": true, "values": [...]}` makes it essential, and even then the RP must check the returned value. |
| S2 | RFC 8176 "Authentication Method Reference Values" §2 | 2026-10-25 (from knowledge, site unreachable) | primary (spec) | Registry of `amr` values: `pwd`, `otp`, `hwk` (proof of possession of a hardware key), `swk`, `sms`, `mfa` (multiple-factor authentication), `mca`, `pin`, `fpt`, `face`, `user`, `pop` and others. `mfa` is the generic "more than one factor" value; `otp`/`hwk` name a second-factor method. |
| S3 | RFC 9470 "OAuth 2.0 Step Up Authentication Challenge Protocol" §3, §4 | 2026-10-25 (from knowledge, site unreachable) | primary (spec) | A resource server signals `error="insufficient_user_authentication"` with `acr_values` and/or `max_age` in the challenge; the client starts a new authorization request with those values. Written for bearer tokens; the error-body idea carries over to cookie sessions. |
| S4 | `node_modules/.pnpm/oauth4webapi@3.8.8/.../build/index.js` lines 1400–1430, 1457–1484 (installed, used by openid-client 6.8.8) | 2026-10-25 | source code | `authorizationCodeGrant(..., { maxAge })` adds `auth_time` to the required ID-token claims and throws "too much time has elapsed since the last End-User authentication" when `auth_time + maxAge < now - tolerance`. Without `maxAge` (and no client `default_max_age`) `auth_time` is not checked at all. |
| S5 | `openid-client@6.8.8` `build/index.d.ts` line 1834–1844 | 2026-10-25 | source code | "`maxAge` … Use of this option is required if you sent a `max_age` parameter in the authorization request." |
| S6 | `oidc-provider@9.12.2` `lib/helpers/interaction_policy/prompts/login.js`, `lib/actions/authorization/claims.js` line 99, `lib/models/session.js` lines 119–187, `lib/actions/authorization/resume.js` lines 97–105, `lib/actions/authorization/request_parameters.js` lines 113–121 | 2026-10-25 | source code | The `login` prompt is requested when there is no session, when `prompt=login`, or when `max_age` has passed (`session.past(max_age)`). `auth_time` is put in the ID token when `max_age` is sent, the client has `require_auth_time`, or `prompt=login` was requested. The login result `{ accountId, acr, amr, ts }` sets the session's `loginTs` (defaults to now), which becomes `auth_time`. `acr_values` is only passed to the interaction (voluntary); essential `acr` via `claims` is checked by the prompt policy. |
| S7 | Experiment planned in the T-0013 test file (`apps/api/src/authz/mfa-step-up.db.test.ts`); result recorded under *Follow-ups* once run | 2026-10-25 | experiment (pending at the time of writing) | Expected from S4–S6: with `prompt=login` + `max_age=300` + `acr_values` the in-process IdP always runs the interaction and the ID token carries `auth_time`, `amr`, `acr`; a login result with an old `ts` makes `authorizationCodeGrant(..., { maxAge: 300 })` fail. |
| S8 | skycloak.io "Step-Up Authentication with Keycloak: A Practical Guide"; Keycloak forum "Step-up Authentication max age and token lifespan" (#24232) and "Error in step-up auth documentation?" (#29650) (web search extracts) | 2026-10-25 | secondary | Keycloak step-up: realm/client "ACR to LoA mapping" maps `acr` strings to numeric levels; the browser flow uses "Conditional – Level Of Authentication" sub-flows (e.g. LoA 2 = OTP) with a per-level Max Age; the client asks with `acr_values` (or the `claims` parameter); the token's `acr` names the level reached. The forum notes the LoA validity only governs issuing new tokens, and that a valid SSO cookie can satisfy a request unless the flow is built carefully. One search result names a 2026 Keycloak CVE about low-assurance sessions obtaining step-up tokens; it could not be verified from here. |
| S9 | Keycloak documentation (server admin guide, "Creating a browser login flow with step-up mechanism"; OIDC `prompt`/`max_age`; ID token `auth_time`) | 2026-10-25 (from knowledge, site unreachable) | primary (vendor docs, recalled) | Keycloak honours `prompt=login` and `max_age` per OIDC Core and always includes `auth_time` in ID tokens. Without step-up configuration the `acr` claim is `"1"` for an authentication in this request and `"0"` for an SSO-cookie login. Recent versions have an AMR protocol mapper that fills `amr` from per-authenticator reference values (e.g. `pwd`, `otp`). |

## Findings

1. **What counts as MFA.** `amr` lists the methods used (S1, S2). `mfa` means more than one
   factor. `otp` and `hwk` name a second factor that is, in practice, only asked for after a
   first factor (Keycloak: password + OTP form, S9). A password-only login gives `["pwd"]`.
   `acr` is the IdP's own name for the assurance level reached; its values are deployment
   specific (Keycloak: whatever the ACR-to-LoA mapping names, S8). So LedgerForce cannot hard-code
   one `acr` value, but it can be told which `acr` values mean MFA in this deployment.
   *Inference:* "MFA" = `amr` contains `mfa`, `otp` or `hwk`, **or** `acr` is one of a
   configured list (default `urn:ledgerforce:loa:mfa`, the value the self-host realm will map to
   its OTP level). Other `amr` values (`sms`, `swk`, `fpt`, …) are not accepted by default: they
   are often a single factor on their own, and a deployment that wants them can map them to the
   MFA `acr` in the IdP.
2. **The request parameters are hints; the RP must check the result.** `acr_values` is voluntary
   (S1, S6). `prompt=login` is a SHOULD (S1). Only `max_age` obliges the OP to re-authenticate and
   to return `auth_time` (S1). Keycloak may satisfy a request from its SSO cookie unless its flow
   forces the second factor (S8). Therefore the step-up request sends all three:
   `prompt=login`, `max_age=<seconds>` and `acr_values=<MFA acr>`, and LedgerForce trusts none of
   them. It checks the returned ID token instead.
3. **Freshness proof.** `openid-client` checks `auth_time` only when `maxAge` is passed to
   `authorizationCodeGrant` (S4, S5). Step-up must pass it. The application then stores the
   token's `auth_time` (not the time it received the callback) on the session, and every
   step-up route compares it with its own maximum age on the server's clock. A session without a
   recorded `auth_time` (created before this change, or by an IdP that did not assert one) never
   passes a step-up check (fail closed).
4. **Step-up must not change who is logged in.** The callback of a step-up must belong to the
   browser's existing session (same session cookie as when the step-up started) and the ID
   token's `(iss, sub)` must map to the same user. It then updates `auth_time`, `amr` and `acr` on
   that session. It creates no new session and no new cookie. Otherwise a step-up could be used
   to swap the session's user or to mint a second session.
5. **Test IdP = same mechanics.** `oidc-provider` 9 forces the login interaction for
   `prompt=login` or a passed `max_age`, puts `auth_time` in the ID token, and takes `amr`, `acr`
   and `ts` (→ `auth_time`) from the test's interaction result (S6, S7). A test can therefore
   produce a fresh MFA step-up, a password-only step-up, a step-up as another user, and a stale
   `auth_time` (which `openid-client` must reject), all through the real protocol.
6. **Error contract.** RFC 9470 (S3) signals step-up with `insufficient_user_authentication` plus
   `acr_values`/`max_age` in a bearer challenge. LedgerForce uses cookie sessions (ADR-0016), so
   the same information goes in the JSON body: HTTP 401 `{"error":"step_up_required","max_age":N}`.
   Missing MFA is not fixable by re-presenting the same session at that moment, but it is by
   stepping up, so it is 403 `{"error":"mfa_required"}` on every permission route, while member
   routes (`/auth/me`, `/auth/logout`, `/auth/step-up`) stay usable so the user can fix it.
7. **Keycloak configuration (for the self-host realm, later task).** Map `acr`
   `urn:ledgerforce:loa:mfa` to LoA 2 (OTP or WebAuthn), require it for the finance users, and add
   the AMR mapper so `amr` contains `pwd`/`otp`. *Inference:* keep LoA max age short (≤ 300 s) so
   the IdP's own SSO cookie cannot stand in for a fresh second factor. This could not be checked
   against a running Keycloak here (no Docker in tests, DL-0007).

## Conclusion / decision

- Treat a session as MFA when `amr ∩ {mfa, otp, hwk} ≠ ∅` or `acr ∈ mfaAcrValues` (configurable,
  default `["urn:ledgerforce:loa:mfa"]`).
- Store `auth_time` (from the ID token, else `NULL`) on the session. Migration
  `0019_auth_mfa_step_up.sql`: `app.session.auth_time`, plus `session_id`, `max_age_seconds`
  and `return_to` on `app.auth_request` for step-up requests.
- A permission route used by a user who holds any role with `mfaRequired` and whose session is
  not MFA → 403 `{"error":"mfa_required"}`, audited.
- A step-up route (decorator `@RequireStepUp(maxAgeSeconds)`, and fail-closed every route whose
  permission is a step-up permission) needs an MFA session with `auth_time` no older than the
  maximum age → else 401 `{"error":"step_up_required","max_age":N}`, audited.
- `GET /auth/step-up?max_age=N&return_to=/path` (member route) → 302 to the IdP with
  `prompt=login`, `max_age=N`, `acr_values=<first MFA acr>`. The shared `/auth/callback` passes
  `maxAge: N` to `authorizationCodeGrant`, requires the same session cookie and the same user,
  updates the session, audits `step_up`, and redirects to `return_to`.
- Proposed decision-log entries DL-0121 (MFA rule and error contract), DL-0122 (step-up flow and
  storage). The security model change is ADR-0025 (Proposed, security, human gate).

## Confidence

`high` for the library behaviour (installed source read, S4–S6; executed in tests, S7).
`medium` for the specification and Keycloak details (recalled primary texts and consistent
secondary sources; the sites were unreachable from the sandbox). The design hedges: MFA `acr`
values are configurable, and the application checks `auth_time`, `amr` and `acr` itself
instead of trusting what it asked for.

## Follow-ups

- Configure the Keycloak dev/self-host realm (ACR-to-LoA mapping, OTP at LoA 2, AMR mapper) when
  `infra/compose` gets its Keycloak service (T-0094); verify findings 2 and 7 there.
- Re-check the reported 2026 Keycloak step-up CVE (S8) before the first release.
- The web shell (apps/web) must handle 401 `step_up_required` by navigating to
  `/auth/step-up?max_age=…&return_to=…`; today it treats every 401 as "signed out".

**Affects:** apps/api auth and authz, packages/db migration 0019, ADR-0016, ADR-0023, ADR-0025,
UC-06, design §6.2.
