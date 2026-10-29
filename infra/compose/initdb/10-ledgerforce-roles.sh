#!/usr/bin/env bash
# Runs once, on first start of an empty data directory (postgres image entrypoint).
# Applies the shared bootstrap SQL (packages/db/bootstrap) and sets role passwords.
# Passwords come from compose file secrets (LF_*_PASSWORD_FILE, T-0094) or, for the older
# environment-variable setup, from LF_MIGRATOR_PASSWORD / LF_APP_PASSWORD.
set -euo pipefail

secret() {
  local name="$1" file_var="${1}_FILE"
  if [[ -n "${!file_var:-}" ]]; then
    tr -d '\r\n' <"${!file_var}"
  elif [[ -n "${!name:-}" ]]; then
    printf '%s' "${!name}"
  else
    echo "10-ledgerforce-roles: set ${name}_FILE (or ${name})" >&2
    exit 1
  fi
}
migrator_pw="$(secret LF_MIGRATOR_PASSWORD)"
app_pw="$(secret LF_APP_PASSWORD)"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -f /lf-bootstrap/01_cluster_roles.sql \
  -f /lf-bootstrap/02_database_grants.sql

# Passwords are passed as psql variables, so they are quoted with :'var' and never interpolated
# into SQL text by the shell.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v migrator_pw="$migrator_pw" -v app_pw="$app_pw" <<'SQL'
ALTER ROLE lf_migrator PASSWORD :'migrator_pw';
ALTER ROLE lf_app PASSWORD :'app_pw';
SQL
