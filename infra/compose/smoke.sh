#!/usr/bin/env bash
# SS-PLAT-23 install smoke test (T-0094): build and start the self-hosted stack exactly as an
# operator would, run tests/install/install.smoke.spec.ts against it, then remove it.
#
#   bash infra/compose/smoke.sh
#
# Needs Docker with compose v2, pnpm dependencies installed and Playwright's Chromium.
# Environment: LF_SMOKE_PROJECT (default lf-smoke), LF_SMOKE_PORT (default 18080),
# LF_SMOKE_KEEP=1 keeps the stack running afterwards; LF_BUILD_CA_FILE names a CA certificate for
# networks that inspect TLS (passed to the image builds as a build secret, never stored). Secrets are generated into
# infra/compose/secrets (git-ignored) if missing. The stack's volumes are removed at the end.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
project="${LF_SMOKE_PROJECT:-lf-smoke}"
port="${LF_SMOKE_PORT:-18080}"
public_url="http://ledgerforce.localhost:${port}"
work="$(mktemp -d)"
owner_email='owner@example.test'
owner_name='Olivia Owner'

cat >"$work/ledgerforce.env" <<EOF
LF_PUBLIC_URL=${public_url}
LF_HTTP_PORT=${port}
LF_HTTP_BIND=127.0.0.1
LF_TENANT_SLUG=harbour-co
LF_TENANT_NAME=Harbour Co
LF_OWNER_EMAIL=${owner_email}
LF_OWNER_NAME=${owner_name}
LF_SETUP_REISSUE=0
EOF

compose=(docker compose -p "$project" -f "$root/infra/compose/compose.yaml" --env-file "$work/ledgerforce.env")

cleanup() {
  local status=$?
  if [[ $status -ne 0 ]]; then
    echo "--- smoke failed (exit $status): service status and recent logs ---" >&2
    "${compose[@]}" ps -a >&2 || true
    "${compose[@]}" logs --no-color --tail 80 2>&1 | sed -E 's/(One-time password: ).*/\1[redacted]/' >&2 || true
  fi
  if [[ "${LF_SMOKE_KEEP:-0}" != 1 ]]; then
    "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
    rm -rf "$work"
  fi
  exit "$status"
}
trap cleanup EXIT

bash "$root/infra/compose/init-secrets.sh"
"${compose[@]}" config -q

echo "--- building images (tagged as compose names them: <project>-<service>)"
ca=()
if [[ -n "${LF_BUILD_CA_FILE:-}" ]]; then ca=(--secret "id=extra_ca,src=${LF_BUILD_CA_FILE}"); fi
for target in setup api worker web; do
  docker build "${ca[@]}" -f "$root/infra/docker/Dockerfile" --target "$target" -t "${project}-${target}" "$root"
done
docker build -f "$root/infra/docker/keycloak.Dockerfile" -t "${project}-keycloak" "$root"
echo "--- starting the stack"
"${compose[@]}" up -d --no-build

# setup is one-shot: wait for it and require exit code 0 (`compose wait` exits with its code).
setup_status=0
"${compose[@]}" wait setup >/dev/null || setup_status=$?
"${compose[@]}" logs --no-color --no-log-prefix setup >"$work/setup.log"
if [[ "$setup_status" != 0 ]]; then
  cat "$work/setup.log" >&2
  echo "setup exited with $setup_status" >&2
  exit 1
fi

echo "--- waiting for api, worker and web to be healthy"
deadline=$((SECONDS + 300))
for svc in api worker web; do
  while true; do
    cid="$("${compose[@]}" ps -q "$svc")"
    health="$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo starting)"
    [[ "$health" == healthy ]] && break
    if ((SECONDS > deadline)); then
      echo "$svc is not healthy ($health)" >&2
      exit 1
    fi
    sleep 3
  done
  echo "$svc healthy"
done

echo "--- setup output (one-time password redacted)"
sed -E 's/(One-time password: ).*/\1[redacted]/' "$work/setup.log"

echo "--- SS-PLAT-23 install smoke spec"
compose_json="$(node -e 'console.log(JSON.stringify(process.argv.slice(1)))' "${compose[@]}")"
(
  cd "$root"
  LF_INSTALL_PUBLIC_URL="$public_url" \
    LF_INSTALL_SETUP_LOG="$work/setup.log" \
    LF_INSTALL_COMPOSE="$compose_json" \
    LF_INSTALL_OWNER_EMAIL="$owner_email" \
    LF_INSTALL_OWNER_NAME="$owner_name" \
    pnpm exec playwright test -c tests/install/playwright.config.ts
)
