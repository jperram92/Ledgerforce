#!/usr/bin/env bash
# Generate the compose file secrets for a self-hosted install (T-0094, RQ-0041 finding 9), and the
# backup keyring (T-0143).
#   bash infra/compose/init-secrets.sh [target-dir]     (default: infra/compose/secrets)
# Each secret is 48 random alphanumeric characters from /dev/urandom. Existing files are never
# overwritten, so re-running is safe. Values are never printed.
set -euo pipefail

dir="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/secrets}"
names=(
  postgres_password
  lf_migrator_password
  lf_app_password
  keycloak_db_password
  oidc_client_secret
  keycloak_admin_client_secret
)

umask 077
mkdir -p "$dir"
chmod 700 "$dir"

random_secret() {
  local s=''
  while [[ ${#s} -lt 48 ]]; do
    s+="$(head -c 96 /dev/urandom | tr -dc 'A-Za-z0-9')"
  done
  printf '%s' "${s:0:48}"
}

for name in "${names[@]}"; do
  file="$dir/$name"
  if [[ -s "$file" ]]; then
    echo "kept      $name"
    continue
  fi
  random_secret >"$file"
  # Readable inside the containers (each runs as its own non-root user); the folder stays 0700.
  chmod 644 "$file"
  echo "generated $name"
done

# The backup keyring (T-0143, ADR-0101): a LocalKeyringKms JSON keyring with one random 32-byte
# key, used only by the backup service. Keep a copy OFF this host (Docs/ops/backup-restore.md):
# without it no backup can be restored. Never overwritten; rotate by adding a key and switching
# "active" (old keys stay so old backups still open).
keyring="$dir/backup_keyring"
if [[ -s "$keyring" ]]; then
  echo "kept      backup_keyring"
else
  key_id="backup-$(date -u +%Y%m%d)"
  key="$(head -c 32 /dev/urandom | base64 | tr -d '\n')"
  printf '{"active":"%s","keys":{"%s":"%s"}}' "$key_id" "$key_id" "$key" >"$keyring"
  chmod 644 "$keyring"
  echo "generated backup_keyring"
fi
