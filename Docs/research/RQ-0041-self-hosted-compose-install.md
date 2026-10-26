---
id: RQ-0041
title: Self-hosted Docker Compose install — container runtime for agents, images, one-time owner setup without default passwords, Keycloak realm with ACR mapping
status: resolved
opened: 2026-10-26
resolved: 2026-10-26
opened_by: claude
linked_tasks: [T-0094]
linked_adrs: [ADR-0037, ADR-0016, ADR-0025, ADR-0027, ADR-0029]
superseded_by:
---

# RQ-0041 — Self-hosted Docker Compose install

## Question

Design §6.3: "a single `docker compose up` … creates the database, runs migrations, seeds
templates and prints a one-time owner setup link; no default passwords exist." §7.2: the stack is
api, worker, web, postgres, keycloak.

- Q1. The agent sandbox has the Docker CLI but no daemon. Can containers run here at all, and can
  images be pulled through the egress proxy?
- Q2. Which base images, pinned how, and how is a pnpm monorepo whose workspace packages are
  TypeScript source (`exports: ./src/index.ts`) run in a container?
- Q3. How does the first Owner get in? Users must be invited with `(idp_issuer, idp_subject)` and
  there is no JIT account creation (ADR-0016, ADR-0027). What can print a *one-time* setup link
  without SMTP and without a default password?
- Q4. HANDOVER question 13 / ADR-0025: which realm configuration makes Keycloak issue the `acr`
  that LedgerForce counts as MFA (`urn:ledgerforce:loa:mfa`), both at first login and at step-up?
- Q5. One public origin for the SPA, the API and Keycloak: how do the browser and the API
  container both reach the same OIDC issuer URL on a single VM, and which paths must not be public?
- Q6. Secrets: how do passwords reach each container without being committed or baked into images?

## Why it matters

T-0094 (SS-PLAT-23) is the MVP self-host install (design §9 MVP row). Guessing wrong on Q3 either
ships a default password (forbidden by §6.3) or an Owner who cannot log in. Q4 decides whether the
Owner, who needs MFA (design §6.2, ADR-0027), can complete the first login at all.

## Sources consulted

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S1 | `nohup dockerd &` then `docker info`, `docker run --rm node:22-bookworm-slim node -e …` | 2026-10-26 | experiment | dockerd 29.9.2 starts as root in this VM (cgroup v1, overlayfs, containerd snapshotter); `docker run` prints `run-ok v22.23.4`. The daemon inherits `HTTPS_PROXY`, so pulls work. |
| S2 | `docker pull quay.io/keycloak/keycloak:26.4` / `docker pull keycloak/keycloak:26.4`; `curl https://www.keycloak.org/...` | 2026-10-26 | experiment | quay.io is refused by the egress proxy ("Forbidden"); the same official image is published on Docker Hub as `keycloak/keycloak`, which pulls. keycloak.org is also refused, so the docs were read from the Keycloak source repository (S5–S8). |
| S3 | Docker Hub tag API (`hub.docker.com/v2/repositories/.../tags`) and `docker buildx imagetools inspect` | 2026-10-26 | primary | Current tags and multi-arch index digests: `node:22.23.4-bookworm-slim` `sha256:de170b39…f38d`; `postgres:17.11-bookworm` `sha256:858bb5e9…d80c27`; `keycloak/keycloak:26.8.1` (published 2026-10-23) `sha256:a78d6b79…dd6b`; `nginxinc/nginx-unprivileged:1.30.6-alpine` (stable line) `sha256:f5116ed4…cdf03`. |
| S4 | https://nodejs.org/api/typescript.html | 2026-10-26 | primary | Type stripping is on by default since v22.18.0; "Node.js refuses to handle TypeScript files inside folders under a `node_modules` path"; enums, runtime namespaces, parameter properties and decorators need transformation. |
| S5 | keycloak/keycloak@26.8.1 `docs/guides/server/importExport.adoc` (git sparse clone) | 2026-10-26 | primary | `--import-realm` reads `data/import`; "You are able to use placeholders to resolve values from environment variables for any realm configuration"; "If a realm already exists in the server, the import operation is skipped." |
| S6 | keycloak/keycloak@26.8.1 `docs/guides/server/bootstrap-admin-recovery.adoc` | 2026-10-26 | primary | `--bootstrap-admin-client-id/-secret` create a *temporary* admin service account "only during the initial start … when the master realm doesn't exist yet". |
| S7 | keycloak/keycloak@26.8.1 `docs/guides/server/hostname.adoc` | 2026-10-26 | primary | Set `hostname` to the full public URL so tokens cannot be issued by a fraudulent issuer; `proxy-headers` is still needed behind a reverse proxy. |
| S8 | keycloak/keycloak@26.8.1 `docs/guides/server/reverseproxy.adoc` § Exposed path recommendations | 2026-10-26 | primary | Expose `/realms/` and `/resources/`; do not expose `/admin/`; restrict `/realms/master/` to internal access. |
| S9 | Keycloak forum "Trigger reset password via REST API", "Getting verify-email action token"; github.com/ApitechFR/keycloak-execute-actions-api | 2026-10-26 | secondary | The Admin REST API has no endpoint that returns an action-token link; `execute-actions-email` only e-mails it (needs SMTP). Getting the link needs a third-party provider JAR. |
| S10 | Spike `scratchpad/t0094/spike/admin.mjs` against `keycloak/keycloak:26.8.1 start-dev --import-realm` | 2026-10-26 | experiment | Bootstrap client → `client_credentials` token 200; `POST /admin/realms/ledgerforce/users` with `requiredActions [UPDATE_PASSWORD, CONFIGURE_TOTP]` and a `temporary` password → 201 with the id in `Location`; same username again → 409; client secret from `${LF_OIDC_CLIENT_SECRET}` substituted; discovery lists `acr_values_supported` `urn:ledgerforce:loa:pwd`, `urn:ledgerforce:loa:mfa`. |
| S11 | Spike `scratchpad/t0094/spike/login.mjs` (Playwright Chromium, PKCE code flow, TOTP computed per RFC 6238) | 2026-10-26 | experiment | Realm with LoA flow (level 1 password, level 2 OTP, `acr.loa.map`) and client attribute `default.acr.values = urn:ledgerforce:loa:mfa`. First login with the temporary password: pages *configure TOTP* → *update password* → redirect with code; ID token `acr = urn:ledgerforce:loa:mfa`, no `amr`. Second login with `prompt=login&max_age=300&acr_values=urn:ledgerforce:loa:mfa` (the step-up request of ADR-0025): OTP page, `acr = urn:ledgerforce:loa:mfa`. Chromium resolved `ledgerforce.localhost` to loopback. |
| S12 | `apps/api/src/auth/oidc.service.ts`, `users.controller.ts`, migrations 0002, 0014, 0016 | 2026-10-26 | primary (repo) | Login matches `app_user` by `(idp_issuer, idp_subject)`, refuses unknown subjects (`not_invited`); first login of an `invited` user whose roles need MFA is refused unless `isMfa`; `user_role.granted_by NULL` = provisioning; `lf_app` may INSERT `app.tenant` when `app.tenant_id` is set to the new id. |
| S13 | `apps/api/src/app.ts` (`API_CONTROLLERS`), `apps/web/src/router.tsx`, RQ-0025 | 2026-10-26 | primary (repo) | The API has no global prefix (`/auth`, `/t/`, `/users`, `/sod`, …); SPA paths are `/`, `/sales`, …, `/settings/...`, `/sign-in`. RQ-0025 recommends a future `/api` prefix. |
| S14 | Docker Hub `postgres` image docs (README, "Docker Secrets") | 2026-10-26 | primary | `POSTGRES_PASSWORD_FILE` reads the superuser password from a file; init scripts in `/docker-entrypoint-initdb.d` run once on an empty data directory. |

## Findings

1. **Containers run here** (S1). `dockerd` is installed and starts; image pulls work through the
   proxy from Docker Hub (S1, S2) but not from quay.io (S2). So SS-PLAT-23 can be proven in this
   sandbox, not only in CI.
2. **Images** (S3): Node 22.23.4 (≥ 22.18, so type stripping is on — S4), PostgreSQL 17.11,
   Keycloak 26.8.1 (newest patch; HANDOVER Q13 asks to check a 2026 step-up CVE, so the newest
   patch of the current line is preferred), nginx-unprivileged 1.30.6 (stable line, runs as uid 101).
   All are pinned `tag@sha256:<index digest>`.
3. **Monorepo at runtime** (S4, inference checked by build): workspace packages must stay outside
   `node_modules` because Node refuses to strip types there. A normal `pnpm install` links them by
   symlink and Node resolves the real path (`/app/packages/db/src/…`), so the runtime image keeps
   the workspace layout instead of using `pnpm deploy` (which would copy them into
   `node_modules`). The API is the only compiled package (decorators, DL-0061); `swc` rewrites
   its relative imports to `.js`.
4. **No built-in one-time link** (S9). Keycloak can only e-mail an action link. Options:
   (a) SMTP plus a mail catcher — a fake mailbox is not a product feature; (b) a third-party
   provider JAR that returns the link — a new runtime dependency inside the IdP; (c) forge the
   action-token JWT with the realm HMAC key — depends on Keycloak internals; (d) open self-registration
   and bind the first registrant with a LedgerForce setup token — needs a migration, an API flow
   and opens registration to anyone who can reach the IdP; (e) create the Owner in Keycloak with a
   **unique, random, temporary** password plus the required actions `CONFIGURE_TOTP` and
   `UPDATE_PASSWORD`, and invite that subject in LedgerForce, using the existing invite model.
   With (e) the printed credential works once: the first sign-in forces a new password and MFA,
   after which the temporary password no longer exists (S10, S11).
5. **(e) fits the existing model exactly** (S12): the invite is an `invited` `app_user` with
   `(iss, sub)` and an `Owner` grant with `granted_by NULL` (provisioning); the first login
   activates it. No migration and no new API route are needed.
6. **ACR mapping** (S11): a browser flow with two conditional levels (`conditional-level-of-authentication`
   1 = password, 2 = OTP), realm attribute `acr.loa.map = {"urn:ledgerforce:loa:pwd":1,"urn:ledgerforce:loa:mfa":2}`
   and client attribute `default.acr.values = urn:ledgerforce:loa:mfa` gives `acr = urn:ledgerforce:loa:mfa`
   at first login (after enrolment) and at step-up. Keycloak sends no `amr` unless an amr mapper and
   per-authenticator references are configured; LedgerForce's `isMfa` accepts the `acr`, so `amr`
   is not needed. *Inference:* every user of this realm signs in with MFA, which is stricter than
   §6.2 (MFA mandatory for five roles) — Approver/Viewer accounts also get MFA.
7. **One origin** (S7, S8, S13): nginx (the `web` service) serves the SPA, proxies the API's
   prefixes and Keycloak's `/realms/` and `/resources/`, and refuses `/admin/` and
   `/realms/master/`. Keycloak's `hostname` is the full public URL, so the issuer is
   `<public URL>/realms/ledgerforce` for everyone. The API container must reach that same URL:
   for a local install the public host is `ledgerforce.localhost` (Chromium resolves `*.localhost`
   to loopback, S11) and the `web` service carries that name as a network alias on the same port,
   so the API reaches it inside the compose network. In production the public DNS name is used
   and must be reachable from the host (documented).
8. **Path list** (S13): because the API has no prefix, nginx needs an explicit list of API
   prefixes. A unit test derives the list from `API_CONTROLLERS` and fails if a controller's
   prefix is not proxied or collides with an SPA route.
9. **Secrets** (S14, S5): compose file secrets (bind-mounted at `/run/secrets/<name>`) generated by
   a script into a git-ignored folder. Postgres reads `*_FILE`; the Node services read
   `<NAME>_FILE`; Keycloak has no `_FILE` support, so a small entrypoint exports its two secrets
   from files before `exec kc.sh`. The bootstrap admin client exists only on the first start (S6).

## Conclusion / decision

- Start `dockerd` in agent sandboxes (DL-0195); prove SS-PLAT-23 here and in CI.
- One `infra/docker/Dockerfile` with targets `api`, `worker`, `setup`, `web`; a separate
  `infra/docker/keycloak.Dockerfile` (optimized Keycloak build). Base images pinned by digest,
  non-root users (DL-0196).
- First owner: option (e) — Keycloak user with a random temporary password and the required actions
  `CONFIGURE_TOTP` + `UPDATE_PASSWORD`, invited in LedgerForce as Owner; the `setup` one-shot service
  prints the tenant's sign-in link and the one-time password once (DL-0197, ADR-0037 Proposed,
  security, human gate).
- Realm: LoA flow + `acr.loa.map` + `default.acr.values` = MFA for every login; self-registration,
  password reset by e-mail and direct grants off; brute-force protection on (DL-0198, ADR-0037).
- One origin through nginx; `/admin/` and `/realms/master/` refused; local public host
  `ledgerforce.localhost` with a network alias; secrets as compose file secrets (DL-0199).

## Confidence

`high` — Q1, Q3 (e), Q4 and Q5 were executed (S1, S10, S11); Q2 follows a primary source (S4) and
a local build. The proxy blocks keycloak.org, so the Keycloak documentation was read from the
source repository at the exact release tag.

## Follow-ups

- Product owner (ADR-0037): accept a printed one-time *password* with the sign-in link as the
  "one-time owner setup link" of §6.3, or require a true single-use link (needs SMTP or a
  Keycloak extension); accept MFA for every self-hosted user.
- Inviting further users needs their Keycloak subject (ADR-0027 invite model): a self-host
  "create IdP user" helper is a later task.
- `pgboss` supervision (ADR-0029) needs an `lf_migrator` long-running instance; the compose stack
  does not run one yet (open question already with the product owner).
- Re-check Keycloak and nginx patch releases before release (image pins).

**Affects:** infra/compose, infra/docker, apps/api (config), apps/worker (main, setup), Docs/ops,
ADR-0025 (realm side of the ACR mapping), ADR-0027 (first owner).
