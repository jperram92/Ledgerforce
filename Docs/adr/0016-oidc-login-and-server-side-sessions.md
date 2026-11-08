---
adr: 0016
title: "OIDC login with tenant-scoped server-side sessions, idle/absolute timeouts and revoke-all"
status: Proposed
date: 2026-10-24
author: claude
category: security
human_gate: yes
supersedes: none
superseded_by: none
---

# ADR-0016: OIDC login with tenant-scoped server-side sessions, idle/absolute timeouts and revoke-all

## Status

Proposed — security category, waiting for product-owner acceptance (PR label `adr:security`).
T-0105 and T-0011 are built to this proposal so it can be judged on working, tested code; any
change the product owner asks for supersedes it.

## Context and problem statement

Design §6.2 requires OpenID Connect throughout, a bundled open-source IdP for self-hosting,
mandatory MFA for finance roles, 12-hour absolute and 30-minute idle sessions for finance roles,
and revoke-all on password reset or role change. Design §6.7 makes the tenant the security
boundary, enforced by forced RLS on every tenant-owned table, with the context set
transaction-locally (RQ-0013).

T-0104 built an API in which every request runs in a tenant transaction. That tenant comes from
a `TenantResolver`, which until now refuses everything. This ADR decides where the resolver gets
the tenant and the user from, without weakening RLS.

The hard part is a chicken-and-egg problem. Sessions and users live in tenant-scoped,
RLS-protected tables, but a request arrives before the tenant is known. A global
"session → tenant" table would be a cross-tenant table that every request reads. Under
`packages/db/AGENTS.md`, any table without `tenant_id` is a security exception that needs an ADR.

Research: RQ-0015 (Keycloak bundled, licence; `oidc-provider` as in-process test IdP;
`openid-client` as relying party), RQ-0013 (SET LOCAL semantics, fail-closed guard).

## Decision drivers

- No global, cross-tenant lookup table on the hot path. Every per-request read goes through RLS.
- The session cookie alone must never be enough to read another tenant's data, even if forged.
- Revocation must be immediate and server-side, which rules out stateless JWT sessions for the browser.
- Testable without Docker or a JVM (CI, agent sandboxes).
- Works for self-host (Keycloak) and hosted (any compliant IdP), with discovery-based configuration.

## Considered options

1. **Stateless JWT session cookie** (signed by LedgerForce). Simple, but revoke-all needs a
   denylist anyway. Idle timeout needs re-issuing. Leaked tokens stay valid until expiry.
2. **Global `session` table** keyed by a random id, with tenant_id inside. One lookup, but it is
   a cross-tenant table read on every request, and an RLS exception on the most sensitive table.
3. **Tenant-scoped session table, cookie carries the tenant id** (chosen). The cookie is
   `<tenant_id>.<session_id>.<secret>`. The resolver opens a tenant transaction for the
   claimed tenant, reads the session under RLS, and compares `sha256(secret)` in constant time.
   A forged tenant id only finds rows in the tenant it names, where the session id and secret
   must also match.
4. **Tenant in the hostname** (`acme.ledgerforce.app`). Good for hosted SaaS later, but
   self-host is usually one host, and it still needs a lookup like option 3.

For **login**, the tenant must be known before any user lookup. Options: (a) a global identity
table mapping (issuer, subject) to tenant, or (b) a tenant-specific login URL `/t/<slug>/auth/login`
resolved by a narrow SECURITY DEFINER function that returns only the tenant id for a slug.
Chosen: **(b)**. It exposes nothing beyond whether a slug exists, and every user lookup after
that runs under RLS within the tenant.

## Decision outcome

Chosen option 3 with login option (b):

- **Relying party:** `openid-client` 6.x. Authorization code flow with PKCE (S256), `state` and
  `nonce`, configured from the issuer's discovery document. The ID token is validated by the
  library, and `iss`, `aud`, `exp` and `nonce` are checked.
- **IdP:** Keycloak bundled for self-host (infra/compose). Any compliant IdP is configured by
  issuer URL for hosted. Tests use an in-process `oidc-provider`.
- **Tenant at login:** `GET /t/:slug/auth/login`. `app.tenant_id_for_slug(text) RETURNS uuid` is
  SECURITY DEFINER, owned by `lf_migrator`, EXECUTE granted to `lf_app`, and returns the id only.
  The pre-auth record (state, nonce, PKCE verifier, tenant id) is kept server-side in
  `app.auth_request` (tenant-scoped, 10-minute expiry, single use).
- **User mapping:** in the tenant, `app.app_user` row with `(idp_issuer, idp_subject)`. Users are
  invited first (design §6.3 joiner flow). An unknown subject gets 403 and no session, so there
  is no just-in-time account creation.
- **Sessions:** table `app.session` (tenant-scoped, RLS ENABLE + FORCE). Columns: id, user_id,
  secret_sha256, created_at, last_seen_at, absolute_expires_at, idle_timeout_seconds,
  user_session_epoch, amr text[], acr text, revoked_at, revoke_reason. Cookie
  `lf_session=<tenant_id>.<session_id>.<secret>` (HttpOnly, Secure outside localhost,
  SameSite=Lax, Path=/). The secret is 32 random bytes in base64url and is never stored.
- **Timeouts:** idle 30 minutes and absolute 12 hours for every session by default. That is
  design §6.2's finance-role policy applied to all roles until roles exist (T-0012), because
  stricter is safe. `last_seen_at` slides on use, at most once a minute.
- **Revoke-all:** `app.app_user.session_epoch` (integer). A session is valid only while its
  `user_session_epoch` equals the user's current epoch. Role change, password reset and leaver
  bump the epoch (T-0012, T-0016). Logout sets `revoked_at` on the one session.
- **MFA:** `amr` and `acr` from the ID token are stored on the session. Enforcement for finance
  roles and step-up is T-0013. This ADR only guarantees the claims are captured.
- **Errors:** an expired, revoked or unknown session gives 401 with `{"error":"session_expired"}`
  or `{"error":"unauthenticated"}`. No reason leaks across tenants.

### Consequences

- Good: every per-request read is RLS-filtered. Revocation is immediate. No cross-tenant table on
  the hot path. Testable in-process.
- Good: forging the tenant id in a cookie only ever reads the forged tenant's rows, so the
  attacker must also hold a valid session id and secret for that tenant.
- Bad: one small extra query per request (the session row), and a session `UPDATE` at most once
  a minute.
- Bad: `tenant_id_for_slug` is a deliberate, minimal cross-tenant primitive. It reveals only
  whether a slug exists, so slugs must not be secret. Rate-limit the login route (§6.9).
- Follow-ups: T-0012 (roles, epoch bump on role change), T-0013 (MFA and step-up), T-0016
  (leaver), the hosted-SaaS hostname option later, and IdP back-channel logout (Phase 1).

## Compliance and verification

| Claim | Proven by |
|---|---|
| Valid session → tenant + user; RLS still filters | `apps/api/src/auth/session.db.test.ts` (SS-PLAT-20, session part) |
| Idle 31 min / absolute 12 h → 401 session_expired | same file, injected clock |
| Epoch bump revokes every session; logout revokes one | same file |
| Forged tenant id / tampered secret → 401 | same file |
| `app.session` and `app.auth_request` are covered by the generated cross-tenant suite | `packages/db/src/rls.db.test.ts` (SS-PLAT-04) |
| Login: PKCE + state + nonce, unknown subject 403, replayed state 400 | `apps/api/src/auth/oidc.db.test.ts` against in-process `oidc-provider` (T-0011) |

## Links

- Design §6.2, §6.3, §6.7; RQ-0013; RQ-0015; DL-0062; T-0105; T-0011; T-0013.
