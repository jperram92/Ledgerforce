#!/usr/bin/env bash
# Runs once, on first start of an empty data directory (postgres image entrypoint).
# Applies the shared bootstrap SQL (packages/db/bootstrap) and sets role passwords from env.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -f /lf-bootstrap/01_cluster_roles.sql \
  -f /lf-bootstrap/02_database_grants.sql

# Passwords are passed as psql variables, so they are quoted with :'var' and never interpolated
# into SQL text by the shell.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v migrator_pw="$LF_MIGRATOR_PASSWORD" -v app_pw="$LF_APP_PASSWORD" <<'SQL'
ALTER ROLE lf_migrator PASSWORD :'migrator_pw';
ALTER ROLE lf_app PASSWORD :'app_pw';
SQL
