---
adr: 0007
title: "Salesforce auth: External Client App with JWT bearer (self-host) and authorization code + PKCE (hosted)"
status: Proposed
date: 2026-10-24
author: claude
category: security
human_gate: yes
supersedes: none
superseded_by: none
---

# ADR-0007: Salesforce auth — External Client App with JWT bearer (self-host) and authorization code + PKCE (hosted)

## Status

Proposed — design-committed (§5.2). It defines how integration credentials are held, so it is
both an integration contract and a **security** decision: the `adr:security` gate applies.
Awaiting product-owner acceptance. Platform facts below must be re-verified in a research
record (RQ) by the connector task before implementation, because Salesforce is actively
changing this area.

## Context and problem statement

The connector subscribes to CDC/Platform Events via Pub/Sub API and writes back via REST
(§5.1). It needs an OAuth identity in each customer org, using a dedicated API-only
integration user with a least-privilege permission set (§5.1). Two deployment shapes exist:
self-hosted (one org, the customer controls the server) and hosted SaaS (many orgs, one
LedgerForce installation, §7.2). "Integration token theft" is in the threat model (§6.1).

Facts (checked 2026-10-24; see Links):

- **JWT bearer flow:** the client posts a JWT signed with its private key; no client secret or
  password is sent; the app must be pre-authorised for the user. Salesforce accepts RSA
  certificates (RS256) for this flow; ECDSA is not supported (design source: Ampersand docs).
- **Authorization code + PKCE:** an admin consents interactively once per org; a refresh token
  is issued and must be stored securely. Salesforce's External Client App OAuth settings
  require PKCE by default.
- **Connected Apps vs External Client Apps (ECAs):** Salesforce's developer documentation
  states that creating connected apps is now disabled by default because connected apps are
  being deprecated, and that re-enabling creation needs Salesforce Support to turn on an org
  permission (Spring '26). Existing connected apps keep working.
- **Username-password flow:** the design (Airbyte source) states ECAs do not support it.
  Secondary sources (PTC, Salesforce Dictionary, 2026) report that Salesforce disabled the
  "Allow OAuth Username-Password Flows" setting for new orgs and plans to retire the flow for
  connected apps in Winter '27. *Not yet confirmed against an official Salesforce release note
  in this session* — to be closed by the connector RQ.

## Decision drivers

- No passwords or long-lived shared secrets in configuration (§6.1, §6.6).
- Must keep working as Salesforce deprecates Connected App creation and username-password.
- Self-host: no interactive step on a headless server; hosted: one-click admin consent per org.
- Least privilege: tokens scoped to the integration user.
- Rotation and expiry alerts (certificates rotate every 12 months, alert 30 days before, §5.2).

## Considered options

Flow:

1. **Username-password OAuth flow** (+ security token).
2. **JWT bearer flow** (certificate-based, server-to-server).
3. **Authorization code + PKCE** with stored refresh token.
4. **Client credentials flow** (run-as user configured on the app).

App type:

- **A. Legacy Connected App.**
- **B. External Client App (ECA).**

### Flow options

- *Username-password* — Good: trivial to set up. Bad: stores a real password; blocked by MFA
  policies; being retired/disabled by Salesforce; reportedly unsupported on ECAs. **Rejected.**
- *JWT bearer* — Good: no secret transmitted, private key can live in KMS/Vault, ideal for a
  single self-hosted org and headless restarts. Bad: requires uploading a certificate to the
  org and pre-authorising the integration user; RSA only; certificate rotation to manage.
- *Auth code + PKCE* — Good: standard admin-consent UX for multi-org SaaS; no certificate per
  org; PKCE defends the code exchange. Bad: refresh tokens are high-value secrets (must be
  envelope-encrypted, §6.6); consent can be revoked by the org admin (needs detection/alert).
- *Client credentials* — Good: simple server-to-server, recommended by Salesforce for some
  integrations. Bad: requires a client secret stored per org and a run-as user configured on the
  app; for hosted multi-org we would still need a per-org secret exchange; keep as a fallback
  to evaluate in the RQ rather than the primary choice.

### App type options

- *Connected App* — Good: familiar, widely documented. Bad: creation disabled by default from
  Spring '26 and on a deprecation path. **Rejected for new work.**
- *External Client App* — Good: Salesforce's current model, packageable metadata
  (`ExtlClntAppGlobalOauthSettings` etc.), supports JWT bearer and auth code + PKCE. Bad: newer,
  fewer community examples; some settings/headless registration not yet supported.

## Decision outcome

Chosen (design-committed): **External Client App** for both deployments, with:

- **Self-hosted, one org:** OAuth 2.0 **JWT bearer** flow; RSA private key kept outside the
  repo (file/KMS/Vault); certificate rotated every 12 months with overlap; alert 30 days before
  expiry.
- **Hosted SaaS, many orgs:** OAuth 2.0 **authorization code + PKCE** at install by an org
  admin; refresh token stored with envelope encryption (§6.6); short-lived access tokens.
- Both: dedicated API-only integration user with a least-privilege permission set; never a
  person's login. Username-password flow is never used.

## Consequences

### Good

- No passwords stored; aligned with Salesforce's direction; least privilege.

### Bad / accepted trade-offs

- Two flows to implement and test.
- Certificate lifecycle (self-host) and refresh-token custody (hosted) are new operational duties.
- ECA ecosystem is younger; the connector RQ must confirm current limits before build.

### Follow-ups

- Connector task opens an RQ to confirm against official Salesforce docs: ECA supported flows,
  username-password status, JWT key algorithms, Pub/Sub API auth with ECA tokens, packaging ECA
  in an unlocked package.

## Compliance and verification

| Check | Where | Gate |
|---|---|---|
| No code path requests `grant_type=password` (grep/lint test) | connector unit test | §10.8 gate 1/2 |
| JWT assertion built with RS256, correct `iss`/`sub`/`aud`/`exp` (≤ 3 min) | connector unit test against fixtures | gate 2 |
| PKCE `code_verifier`/`code_challenge` (S256) generated and verified | connector unit test | gate 2 |
| Refresh tokens are only persisted encrypted (column holds ciphertext; plaintext never logged) | security test + log-redaction test | gates 2, 7 |
| Secret scanning finds no keys/tokens in repo | CI secret scan | gate 7 |
| Certificate-expiry alert fires at 30 days | worker scheduled-job test | gate 2 |

## Links

- Design: §5.1, §5.2, §6.1, §6.6
- Related ADRs: ADR-0006, ADR-0003
- External (retrieved 2026-10-24):
  - Salesforce, "Create a Connected App in Your Org" (creation disabled by default) —
    https://developer.salesforce.com/docs/platform/sfdx-dev/guide/sfdx-dev-auth-connected-app.html
  - Salesforce Metadata API, `ExtlClntAppGlobalOauthSettings` (PKCE required by default) —
    https://developer.salesforce.com/docs/atlas.en-us.api_meta.meta/api_meta/meta_extlclntappglobaloauthsettings.htm
  - Salesforce Help, OAuth 2.0 JWT bearer flow —
    https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_jwt_flow.htm&language=en_US&type=5
  - Ampersand, Salesforce JWT provider guide (RSA only) — https://docs.withampersand.com/provider-guides/salesforce-jwt
  - Airbyte, Salesforce OAuth for SaaS integrations (ECA, no username-password) —
    https://airbyte.com/agentic-data/salesforce-oauth-saas-integrations
  - Secondary: PTC Service Board ECA article; Salesforce Dictionary "External Client Apps
    migration 2026" (username-password retirement timing — unconfirmed)
