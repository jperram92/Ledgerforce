# infra/compose

Docker Compose definition for the single-VM self-host option (design §7.2).

| Service | Status | Notes |
|---|---|---|
| `postgres` | live | `postgres:17`. On first start, `initdb/10-ledgerforce-roles.sh` applies `packages/db/bootstrap/*.sql` to create `lf_migrator` and `lf_app` and set their passwords from env |
| `keycloak` | placeholder (commented) | OIDC IdP (design §6.2). Configured in a later task |
| `api`, `worker`, `web` | placeholder (commented) | Enabled when `apps/*` exist. `api` and `worker` connect as `lf_app` only |
| `migrate` | placeholder (commented) | One-shot `lf_migrator` job that applies `packages/db/migrations` |

## Run the database

```bash
export LF_POSTGRES_PASSWORD=... LF_MIGRATOR_PASSWORD=... LF_APP_PASSWORD=...   # from your secret store
docker compose -f infra/compose/docker-compose.yml up -d postgres
DATABASE_URL="postgres://lf_migrator:${LF_MIGRATOR_PASSWORD}@127.0.0.1:5432/ledgerforce" \
  pnpm --filter @ledgerforce/db migrate
```

Postgres binds to `127.0.0.1` only. No secrets are committed: every password comes from the
environment, and compose refuses to start if one is missing.

The test suite does **not** use this file. `pnpm test:db` starts its own throw-away server
(Testcontainers, or a local `initdb` cluster when there is no Docker; DL-0007).

Validate the file without a daemon:
`LF_POSTGRES_PASSWORD=x LF_MIGRATOR_PASSWORD=x LF_APP_PASSWORD=x docker compose -f infra/compose/docker-compose.yml config -q`
