#!/usr/bin/env bash
# Generate the compose file secrets for a self-hosted install (T-0094, RQ-0041 finding 9).
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
