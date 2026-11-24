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
# LF_BACKUP_PASSWORD(_FILE) and may log in only to $POSTGRES_DB from LF_BACKUP_ALLOWED_CIDR (compose:
# the backup container's own address as a /32, ADR-0109): a managed block at the top of
# pg_hba.conf, replaced on every run. Without a password or a CIDR the role exists but cannot log
# in. The password is set only after the block is loaded (T-0244).
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

# Validate everything that goes into pg_hba.conf before changing anything (T-0244, ADR-0109):
# first the exact shape (the value is written into pg_hba.conf, so nothing else may get through),
# then PostgreSQL's own inet parser: a non-zero prefix inside loopback or private address space.
cidr_rule="LF_BACKUP_ALLOWED_CIDR must be one private or loopback address/prefix (compose: the backup container address as a /32, e.g. 172.30.227.6/32)"
if [[ -n "$backup_cidr" ]]; then
  if ! [[ "$backup_cidr" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$ || "$backup_cidr" =~ ^[0-9A-Fa-f:]+/[0-9]{1,3}$ ]]; then
    echo "10-ledgerforce-roles: $cidr_rule" >&2
    exit 1
  fi
  if [[ "${backup_cidr##*/}" =~ ^0+$ ]]; then
    echo "10-ledgerforce-roles: LF_BACKUP_ALLOWED_CIDR=$backup_cidr refused: /0 would allow lf_backup from every address" >&2
    exit 1
  fi
fi
if ! [[ "$db" =~ ^[A-Za-z0-9_]+$ ]]; then
  echo "10-ledgerforce-roles: POSTGRES_DB must be letters, digits and _ only" >&2
  exit 1
fi

run_psql() {
  psql -v ON_ERROR_STOP=1 --no-psqlrc --username "$POSTGRES_USER" --dbname "$db" "$@"
}

if [[ -n "$backup_cidr" ]]; then
  # A read-only query; an unparsable value (300.1.1.1/32, /33) is a psql error and is refused too.
  private="$(
    run_psql -At -v cidr="$backup_cidr" 2>/dev/null <<'SQL' || true
SELECT (masklen(i) > 0 AND (i <<= inet '10.0.0.0/8' OR i <<= inet '172.16.0.0/12'
        OR i <<= inet '192.168.0.0/16' OR i <<= inet '127.0.0.0/8'
        OR i <<= inet 'fc00::/7' OR i <<= inet '::1/128'))::text
  FROM (SELECT inet :'cidr' AS i) s;
SQL
  )"
  if [[ "$private" != "true" ]]; then
    echo "10-ledgerforce-roles: LF_BACKUP_ALLOWED_CIDR=$backup_cidr refused: $cidr_rule" >&2
    exit 1
  fi
fi

run_psql -f "$bootstrap_dir/01_cluster_roles.sql" -f "$bootstrap_dir/02_database_grants.sql"

# Passwords are passed as psql variables, so they are quoted with :'var' and never interpolated
# into SQL text by the shell.
run_psql -v migrator_pw="$migrator_pw" -v app_pw="$app_pw" <<'SQL'
ALTER ROLE lf_migrator PASSWORD :'migrator_pw';
ALTER ROLE lf_app PASSWORD :'app_pw';
SQL

hba="$(run_psql -At -c 'SHOW hba_file')"

# While the file has any error PostgreSQL keeps its last valid rules, so nothing written now could
# take effect. Say so, name the lines, and leave the file, the lf_backup rule and its password as
# they are (a role created by this run has no password and cannot log in anywhere). Exit 0: the
# roles are done and a first start or an upgrade is not blocked; the backup's start-up check then
# reports the missing login by name (LF_BACKUP_LOGIN_FAILED / LF_BACKUP_LOGIN_REJECTED).
existing="$(run_psql -At -c "SELECT 'line ' || line_number || ': ' || error FROM pg_hba_file_rules WHERE error IS NOT NULL ORDER BY line_number")"
if [[ -n "$existing" ]]; then
  {
    echo "10-ledgerforce-roles: WARNING: $hba already has errors, so PostgreSQL ignores every change to it until they are fixed:"
    printf '  %s\n' "$existing"
    echo "10-ledgerforce-roles: the lf_backup rule and password were left unchanged. Fix the file, then run this script again."
  } >&2
  echo "10-ledgerforce-roles: roles bootstrapped; lf_backup logins unchanged (pg_hba.conf has errors)"
  exit 0
fi

# The lf_backup block goes before every other rule (first match wins), replacing an older block.
# From the moment the file is rewritten until the new rules are loaded, any failure (a parse
# error, psql losing its connection, the reload failing) puts the previous file back.
work="$(mktemp -d)"
restore=0
cleanup() {
  local status=$?
  if [[ "$restore" == 1 ]]; then
    cat "$work/previous" >"$hba"
    echo "10-ledgerforce-roles: pg_hba.conf restored to its previous content" >&2
  fi
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT
cp "$hba" "$work/previous"
{
  echo '# BEGIN lf_backup (T-0227, ADR-0106, ADR-0109) - managed by 10-ledgerforce-roles.sh; edits are replaced'
  if [[ -n "$backup_cidr" ]]; then
    printf 'host    %s    lf_backup    %s    scram-sha-256\n' "$db" "$backup_cidr"
  fi
  echo 'host    all    lf_backup    all    reject'
  echo 'local   all    lf_backup    reject'
  echo '# END lf_backup'
  awk '/^# BEGIN lf_backup/ { skip = 1; next } /^# END lf_backup/ { skip = 0; next } !skip' "$work/previous"
} >"$work/next"
# Rewrite in place (keeps the file's owner and mode), then let PostgreSQL parse it before reload.
restore=1
cat "$work/next" >"$hba"
errors="$(run_psql -At -c 'SELECT count(*) AS lf_backup_hba_validation FROM pg_hba_file_rules WHERE error IS NOT NULL')"
if [[ "$errors" != "0" ]]; then
  echo "10-ledgerforce-roles: the new lf_backup block would not parse" >&2
  exit 1
fi
run_psql -At -c 'SELECT pg_reload_conf()' >/dev/null
restore=0

# Only now, with the rule in force, may lf_backup get a password and log in.
if [[ -n "$backup_pw" ]]; then
  run_psql -v backup_pw="$backup_pw" <<'SQL'
ALTER ROLE lf_backup PASSWORD :'backup_pw';
SQL
fi
echo "10-ledgerforce-roles: roles bootstrapped; lf_backup logins ${backup_cidr:+allowed from $backup_cidr}${backup_cidr:-disabled}"
