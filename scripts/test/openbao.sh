#!/usr/bin/env bash
# Opt-in integration run of the transit KMS adapter against a real OpenBao (T-0108, DL-0204).
#
#   pnpm test:openbao                                   # runs the Vitest project `openbao`
#   bash scripts/test/openbao.sh <command…>             # runs <command> with the same environment,
#     e.g. LF_TASK_ID=T-0108 bash scripts/test/openbao.sh pnpm -s evidence:tests --project openbao
#
# Downloads the official OpenBao release (MPL-2.0) once into node_modules/.cache/openbao/, checks
# it against the pinned SHA-256 (RQ-0042 S8: matches the release checksums.txt), starts
# `bao server -dev-tls` on loopback (in memory, generated CA), mounts transit and AppRole, and
# runs the tests with NODE_EXTRA_CA_CERTS set to the generated CA. Any failure exits non-zero;
# nothing is skipped. Not part of `pnpm test` / `pnpm test:db`.
set -euo pipefail

VERSION=2.7.1
SHA256=0e2f1ce10d124e03112b50dd2fbec6b78003783253bc3a91587938f39d1e2243
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [ "$(uname -s)-$(uname -m)" != "Linux-x86_64" ]; then
  echo "openbao.sh: only the linux/amd64 release is pinned (got $(uname -s)-$(uname -m))" >&2
  exit 2
fi

CACHE="$ROOT/node_modules/.cache/openbao/$VERSION"
ARCHIVE="$CACHE/openbao_${VERSION}_linux_amd64.tar.gz"
mkdir -p "$CACHE"
if [ ! -f "$ARCHIVE" ]; then
  curl -sSfL -o "$ARCHIVE.part" \
    "https://github.com/openbao/openbao/releases/download/v${VERSION}/openbao_${VERSION}_linux_amd64.tar.gz"
  mv "$ARCHIVE.part" "$ARCHIVE"
fi
if ! echo "$SHA256  $ARCHIVE" | sha256sum -c --status -; then
  echo "openbao.sh: checksum mismatch for $ARCHIVE — refusing to run it" >&2
  mv "$ARCHIVE" "$ARCHIVE.rejected"
  exit 1
fi
# Always extract from the verified archive, so a modified binary in the cache is never run.
tar -xzf "$ARCHIVE" -C "$CACHE" bao
BAO="$CACHE/bao"

WORK="$(mktemp -d)"
mkdir -p "$WORK/tls"
PORT="${LF_OPENBAO_PORT:-18300}"
ROOT_TOKEN="root-$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n')"
"$BAO" server -dev-tls -dev-tls-cert-dir="$WORK/tls" -dev-root-token-id="$ROOT_TOKEN" \
  -dev-listen-address="127.0.0.1:$PORT" >"$WORK/server.log" 2>&1 &
PID=$!
cleanup() {
  kill "$PID" 2>/dev/null || true
  wait "$PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

ADDR="https://127.0.0.1:$PORT"
CA="$WORK/tls/vault-ca.pem"
for _ in $(seq 1 100); do
  if [ -f "$CA" ] && curl -sf --cacert "$CA" "$ADDR/v1/sys/health" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
curl -sf --cacert "$CA" "$ADDR/v1/sys/health" >/dev/null || {
  echo "openbao.sh: server did not become healthy" >&2
  cat "$WORK/server.log" >&2
  exit 1
}

api() { # method path [json]
  curl -sSf --cacert "$CA" -H "X-Vault-Token: $ROOT_TOKEN" -X "$1" ${3:+-d "$3"} "$ADDR/v1/$2"
}
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=process.argv[1].split(".").reduce((o,k)=>o[k],JSON.parse(s));process.stdout.write(String(v))})' "$1"; }

api POST sys/mounts/transit '{"type":"transit"}' >/dev/null
api POST sys/auth/approle '{"type":"approle"}' >/dev/null
api POST sys/policies/acl/lf-transit "$(node -e 'process.stdout.write(JSON.stringify({policy:[
  "path \"transit/encrypt/*\" { capabilities = [\"update\"] }",
  "path \"transit/decrypt/*\" { capabilities = [\"update\"] }",
  "path \"transit/rewrap/*\" { capabilities = [\"update\"] }",
  "path \"transit/keys/*\" { capabilities = [\"read\"] }"].join("\n")}))')" >/dev/null
api POST auth/approle/role/lf-api '{"token_policies":"lf-transit","token_ttl":"20m","token_max_ttl":"1h"}' >/dev/null
ROLE_ID="$(api GET auth/approle/role/lf-api/role-id | json data.role_id)"
SECRET_ID="$(api POST auth/approle/role/lf-api/secret-id | json data.secret_id)"

export LF_OPENBAO_ADDR="$ADDR"
export LF_OPENBAO_ROOT_TOKEN="$ROOT_TOKEN"
export LF_OPENBAO_ROLE_ID="$ROLE_ID"
export LF_OPENBAO_SECRET_ID="$SECRET_ID"
export LF_OPENBAO_VERSION="$("$BAO" version)"
export NODE_EXTRA_CA_CERTS="$CA"
echo "openbao.sh: $LF_OPENBAO_VERSION at $ADDR (sha256 verified)"

cd "$ROOT"
if [ "$#" -gt 0 ]; then
  "$@"
else
  pnpm exec vitest run --project openbao
fi
