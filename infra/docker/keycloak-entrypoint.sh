#!/bin/bash
# Keycloak has no *_FILE support: read the three secrets from compose file secrets into the
# variables Keycloak (and the realm import placeholders) expect, then start (T-0094, RQ-0041).
# The realm is imported only when it does not exist yet (Keycloak skips an existing realm).
set -euo pipefail

read_secret() {
  local var="$1" file="${!1:-}"
  if [[ -z "$file" || ! -r "$file" ]]; then
    echo "lf-entrypoint: ${var} must name a readable secret file" >&2
    exit 1
  fi
  tr -d '\r\n' <"$file"
}

KC_DB_PASSWORD="$(read_secret KC_DB_PASSWORD_FILE)"
LF_OIDC_CLIENT_SECRET="$(read_secret LF_OIDC_CLIENT_SECRET_FILE)"
KC_BOOTSTRAP_ADMIN_CLIENT_SECRET="$(read_secret KC_BOOTSTRAP_ADMIN_CLIENT_SECRET_FILE)"
export KC_DB_PASSWORD LF_OIDC_CLIENT_SECRET KC_BOOTSTRAP_ADMIN_CLIENT_SECRET
unset KC_DB_PASSWORD_FILE LF_OIDC_CLIENT_SECRET_FILE KC_BOOTSTRAP_ADMIN_CLIENT_SECRET_FILE

exec /opt/keycloak/bin/kc.sh start --optimized --import-realm "$@"
