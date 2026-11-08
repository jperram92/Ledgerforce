# infra/compose/secrets

Compose file secrets for the self-hosted install. Each file holds one value and is mounted at
`/run/secrets/<name>` only into the services that need it (see `compose.yaml`).

Generate them once with `bash infra/compose/init-secrets.sh`. The script never overwrites an
existing file. Everything in this folder except this README and `.gitignore` is ignored by git.
Do not commit these files, and keep a copy in your secret store or backup.

| File | Used by |
|---|---|
| `postgres_password` | postgres (superuser, bootstrap only; never used by the application) |
| `lf_migrator_password` | postgres, setup (migrations and queue install) |
| `lf_app_password` | postgres, setup, api, worker (application runtime) |
| `keycloak_db_password` | postgres, keycloak |
| `oidc_client_secret` | keycloak (realm import), api (OIDC client) |
| `keycloak_admin_client_secret` | keycloak (temporary bootstrap admin client), setup |
