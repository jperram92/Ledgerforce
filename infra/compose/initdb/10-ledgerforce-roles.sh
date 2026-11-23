#!/usr/bin/env bash
# Runs once, on first start of an empty data directory (postgres image entrypoint).
# Applies the shared bootstrap SQL (packages/db/bootstrap) and sets role passwords.
# Passwords come from compose file secrets (LF_*_PASSWORD_FILE, T-0094) or, for the older
# environment-variable setup, from LF_MIGRATOR_PASSWORD / LF_APP_PASSWORD.
#
# Idempotent, so it is also the upgrade step for an existing install (T-0227, ADR-0106;
# Docs/ops/backup-restore.md):
#   docker compose ... exec -u postgres postgres bash /docker-entrypoint-initdb.d/10-ledgerforce-roles.sh
#
# lf_backup (nightly backup; BYPASSRLS + pg_read_all_data, read-only) gets its password from
# LF_BACKUP_PASSWORD(_FILE) and may log in only to $POSTGRES_DB from LF_BACKUP_ALLOWED_CIDR (the
# compose backup network): a managed block at the top of pg_hba.conf, replaced on every run.
# Without a password or a CIDR the role exists but cannot log in.
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
optional_secret() {
  local name="$1" file_var="${1}_FILE"
  if [[ -n "${!file_var:-}" || -n "${!name:-}" ]]; then secret "$name"; fi
}
migrator_pw="$(secret LF_MIGRATOR_PASSWORD)"
app_pw="$(secret LF_APP_PASSWORD)"
backup_pw="$(optional_secret LF_BACKUP_PASSWORD)"
backup_cidr="${LF_BACKUP_ALLOWED_CIDR:-}"
bootstrap_dir="${LF_BOOTSTRAP_DIR:-/lf-bootstrap}"
db="${POSTGRES_DB:?set POSTGRES_DB}"

# Validate everything that goes into pg_hba.conf before touching the database.
if [[ -n "$backup_cidr" ]] &&
  ! [[ "$backup_cidr" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$ || "$backup_cidr" =~ ^[0-9A-Fa-f:]+/[0-9]{1,3}$ ]]; then
  echo "10-ledgerforce-roles: LF_BACKUP_ALLOWED_CIDR must be one address/prefix (e.g. 172.30.227.0/29)" >&2
  exit 1
fi
if ! [[ "$db" =~ ^[A-Za-z0-9_]+$ ]]; then
  echo "10-ledgerforce-roles: POSTGRES_DB must be letters, digits and _ only" >&2
  exit 1
fi

run_psql() {
  psql -v ON_ERROR_STOP=1 --no-psqlrc --username "$POSTGRES_USER" --dbname "$db" "$@"
}

run_psql -f "$bootstrap_dir/01_cluster_roles.sql" -f "$bootstrap_dir/02_database_grants.sql"

# Passwords are passed as psql variables, so they are quoted with :'var' and never interpolated
# into SQL text by the shell.
run_psql -v migrator_pw="$migrator_pw" -v app_pw="$app_pw" <<'SQL'
ALTER ROLE lf_migrator PASSWORD :'migrator_pw';
ALTER ROLE lf_app PASSWORD :'app_pw';
SQL
if [[ -n "$backup_pw" ]]; then
  run_psql -v backup_pw="$backup_pw" <<'SQL'
ALTER ROLE lf_backup PASSWORD :'backup_pw';
SQL
fi

# The lf_backup block goes before every other rule (first match wins), replacing an older block.
hba="$(run_psql -At -c 'SHOW hba_file')"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp "$hba" "$work/previous"
{
  echo '# BEGIN lf_backup (T-0227, ADR-0106) - managed by 10-ledgerforce-roles.sh; edits are replaced'
  if [[ -n "$backup_cidr" ]]; then
    printf 'host    %s    lf_backup    %s    scram-sha-256\n' "$db" "$backup_cidr"
  fi
  echo 'host    all    lf_backup    all    reject'
  echo 'local   all    lf_backup    reject'
  echo '# END lf_backup'
  awk '/^# BEGIN lf_backup/ { skip = 1; next } /^# END lf_backup/ { skip = 0; next } !skip' "$work/previous"
} >"$work/next"
# Rewrite in place (keeps the file's owner and mode), then let PostgreSQL parse it before reload.
cat "$work/next" >"$hba"
errors="$(run_psql -At -c 'SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL')"
if [[ "$errors" != "0" ]]; then
  cat "$work/previous" >"$hba"
  echo "10-ledgerforce-roles: pg_hba.conf would not parse; left unchanged" >&2
  exit 1
fi
run_psql -At -c 'SELECT pg_reload_conf()' >/dev/null
echo "10-ledgerforce-roles: roles bootstrapped; lf_backup logins ${backup_cidr:+allowed from $backup_cidr}${backup_cidr:-disabled}"
