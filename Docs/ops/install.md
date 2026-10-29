# Install LedgerForce on one server (Docker Compose)

This guide installs the self-hosted stack from design §7.2: **postgres**, **keycloak** (sign-in),
**api**, **worker** and **web**, plus a one-shot **setup** service. It follows design §6.3: one
`docker compose up` creates the database, runs the migrations, installs the job queue and prints a
one-time owner setup link. There are no default passwords.

Background and decisions: [RQ-0041](../research/RQ-0041-self-hosted-compose-install.md),
[ADR-0037](../adr/0037-self-hosted-install-owner-bootstrap-and-realm-mfa.md) (Proposed).

## What you need

- A Linux server with Docker Engine 24+ and the Compose v2 plugin, 4 GB RAM, 20 GB disk.
- A checkout of this repository on the server.
- For production: a DNS name (for example `ledger.example.com`) and a TLS reverse proxy in front
  of the web service (Caddy, nginx, Traefik or your load balancer). LedgerForce refuses plain
  `http://` for anything but a loopback host.

## 1. Create the secrets

```bash
bash infra/compose/init-secrets.sh
```

This writes six random 48-character secrets to `infra/compose/secrets/` (folder mode 0700). The
folder is ignored by git. Re-running the script never overwrites a secret. **Back these files up**
in your secret store: without them you cannot reach the database or Keycloak.

| Secret | Purpose |
|---|---|
| `postgres_password` | PostgreSQL superuser; used only once, to create the roles |
| `lf_migrator_password` | `lf_migrator`, owner of the schema; used only by `setup` |
| `lf_app_password` | `lf_app`, the application role (no superuser, no BYPASSRLS) |
| `keycloak_db_password` | Keycloak's own database role |
| `oidc_client_secret` | The LedgerForce OIDC client in Keycloak |
| `keycloak_admin_client_secret` | Keycloak's temporary admin service account, used by `setup` |

## 2. Settings

```bash
cp infra/compose/ledgerforce.env.example infra/compose/ledgerforce.env
```

Edit `infra/compose/ledgerforce.env` (also ignored by git; it holds no secrets):

| Setting | Meaning |
|---|---|
| `LF_PUBLIC_URL` | The address people use. Production: `https://ledger.example.com`. A trial on this machine: `http://ledgerforce.localhost:8080` |
| `LF_HTTP_PORT`, `LF_HTTP_BIND` | Where the web service listens (default `127.0.0.1:8080`) |
| `LF_TENANT_SLUG`, `LF_TENANT_NAME` | Your organisation's sign-in name (lower case, digits, hyphens) and display name |
| `LF_OWNER_EMAIL`, `LF_OWNER_NAME` | The first Owner. The e-mail address is their sign-in name |
| `LF_SETUP_REISSUE` | `1` for one run to issue a new one-time password (see step 5) |

## 3. Start

```bash
docker compose -f infra/compose/compose.yaml --env-file infra/compose/ledgerforce.env up -d --build
```

Start order is enforced: postgres → keycloak → **setup** (runs once and exits) → api and worker →
web. If setup fails, api and worker do not start. Follow it with:

```bash
docker compose -f infra/compose/compose.yaml --env-file infra/compose/ledgerforce.env logs -f setup
```

Setup prints:

```
========================================================================
LedgerForce owner setup
Owner setup link: https://ledger.example.com/t/harbour-co/auth/login
Sign in as: owner@example.com
One-time password: Ab3dE-fG7hJ-kM9nP-qR2sT-uV4wX
At first sign-in you set up an authenticator app (MFA) and choose your own password;
the one-time password stops working then. Keep this output private until you have signed in.
========================================================================
```

If your network inspects TLS, the image build cannot download packages. Pass your proxy's CA as a
build secret (it is not stored in the images):
`docker build --secret id=extra_ca,src=/path/to/ca.pem -f infra/docker/Dockerfile --target api .`
(the smoke script does this for every image when `LF_BUILD_CA_FILE` is set).

## 4. First sign-in (the Owner)

1. Open the owner setup link and sign in with the e-mail address and the one-time password.
2. Scan the QR code with an authenticator app and enter the code (MFA is required for everyone in
   this realm).
3. Choose your own password (12 characters or more).
4. You arrive in LedgerForce as Owner. The one-time password no longer works.

Do this soon after setup: until then the one-time password is in the setup log.

## 5. Lost the one-time password?

While the Owner has not signed in yet:

```bash
LF_SETUP_REISSUE=1 docker compose -f infra/compose/compose.yaml \
  --env-file infra/compose/ledgerforce.env run --rm setup
```

This issues a new one-time password (the old one stops working) and records it in the audit log.
After the Owner's first sign-in, setup refuses to reissue.

## Production notes

- **TLS**: terminate TLS in your reverse proxy and forward to `127.0.0.1:${LF_HTTP_PORT}` with the
  `Host` and `X-Forwarded-Proto: https` headers. Use TLS 1.2+ (1.3 preferred).
- **Reachability**: the api container must reach `LF_PUBLIC_URL` (it fetches the OIDC discovery
  document from it). With public DNS this works through your reverse proxy; check with
  `docker compose … exec api node -e "fetch(process.env.LF_PUBLIC_URL+'/realms/ledgerforce').then(r=>console.log(r.status))"`.
- **Not public**: the database, Keycloak and the API are reachable only inside the compose
  network. The web service returns 404 for Keycloak's `/admin/` and `/realms/master/`. To use the
  Keycloak admin console, publish it temporarily on loopback and use an SSH tunnel.
- **Backups**: back up the `pgdata` volume (both databases) and `infra/compose/secrets/`; test
  restores. Point-in-time recovery and encrypted off-site backups are your responsibility on a
  single server (design §6.9 targets apply to hosted).
- **Updates**: pull the new version, then `up -d --build`. Setup applies new migrations before
  the new api and worker start. Migrations are forward-only.
- **Hardening in the stack**: every service has `no-new-privileges`; app containers drop all Linux
  capabilities and run read-only as non-root users; images are pinned by digest.

## Known limits (T-0094)

- Inviting further users needs their Keycloak account first (ADR-0027 invite model); a self-host
  helper for that is a later task. Until then, create users in the Keycloak admin console.
- The worker runs as `lf_app` only; pg-boss supervision as the schema owner (ADR-0029) does not
  run in this stack yet (open question with the product owner).
- Bank-detail routes answer 503 until a key service is configured (ADR-0030, T-0108).

## Proving an install (CI)

`bash infra/compose/smoke.sh` builds the images, starts a throw-away stack, runs
`tests/install/install.smoke.spec.ts` (SS-PLAT-23: migrations, roles, sign-in page, the setup
link, the Owner's first sign-in with MFA, the spent one-time password, closed admin paths) and
removes the stack. The workflow `.github/workflows/install-smoke.yml` runs it on GitHub runners.
