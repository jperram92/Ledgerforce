#!/usr/bin/env bash
# RQ-0042 spike: OpenBao 2.7.1 dev server, transit behaviours the adapter relies on.
set -uo pipefail
T="${T:?set T to a work dir holding release/bin/bao (scripts/test/openbao.sh downloads it)}"
BAO=$T/release/bin/bao
PORT=18299
A=http://127.0.0.1:$PORT
TOK=spike-root-token
"$BAO" server -dev -dev-root-token-id=$TOK -dev-listen-address=127.0.0.1:$PORT >"$T/spike-server.log" 2>&1 &
PID=$!
trap 'kill $PID' EXIT
for i in $(seq 1 50); do curl -s "$A/v1/sys/health" >/dev/null && break; sleep 0.2; done
r() { # method path body
  local body="${3:-}"
  echo "--> $1 $2 $body"
  curl -s -w '  [HTTP %{http_code}]\n' -X "$1" -H "X-Vault-Token: $TOK" ${body:+-d "$body"} "$A/v1/$2"
}
b64() { printf '%s' "$1" | base64 -w0; }
r POST sys/mounts/transit '{"type":"transit"}'
r POST transit/keys/lf-derived '{"type":"aes256-gcm96","derived":true}'
r POST transit/keys/lf-plain '{"type":"aes256-gcm96"}'
r GET transit/keys/lf-derived
DEK=$(head -c 32 /dev/urandom | base64 -w0)
C1=$(b64 "lf-kek-transit-v1|recordA")
C2=$(b64 "lf-kek-transit-v1|recordB")
OUT=$(curl -s -X POST -H "X-Vault-Token: $TOK" -d "{\"plaintext\":\"$DEK\",\"context\":\"$C1\"}" $A/v1/transit/encrypt/lf-derived)
echo "encrypt derived: $OUT"
CT=$(echo "$OUT" | sed -E 's/.*"ciphertext":"([^"]+)".*/\1/')
echo "== decrypt right context"; r POST transit/decrypt/lf-derived "{\"ciphertext\":\"$CT\",\"context\":\"$C1\"}"
echo "== decrypt wrong context"; r POST transit/decrypt/lf-derived "{\"ciphertext\":\"$CT\",\"context\":\"$C2\"}"
echo "== decrypt no context"; r POST transit/decrypt/lf-derived "{\"ciphertext\":\"$CT\"}"
echo "== decrypt on other key"; r POST transit/decrypt/lf-plain "{\"ciphertext\":\"$CT\"}"
echo "== context on non-derived key"; r POST transit/encrypt/lf-plain "{\"plaintext\":\"$DEK\",\"context\":\"$C1\"}"
echo "== tampered ciphertext"; TCT="${CT%?}A"; [ "$TCT" = "$CT" ] && TCT="${CT%?}B"; r POST transit/decrypt/lf-derived "{\"ciphertext\":\"$TCT\",\"context\":\"$C1\"}"
echo "== rotate + rewrap"; r POST transit/keys/lf-derived/rotate ''
r POST transit/rewrap/lf-derived "{\"ciphertext\":\"$CT\",\"context\":\"$C1\"}"
r POST transit/rewrap/lf-derived "{\"ciphertext\":\"$CT\",\"context\":\"$C2\"}"
echo "== associated_data rewrap on plain key"; AD=$(b64 "recordA")
OUT2=$(curl -s -X POST -H "X-Vault-Token: $TOK" -d "{\"plaintext\":\"$DEK\",\"associated_data\":\"$AD\"}" $A/v1/transit/encrypt/lf-plain); echo "$OUT2"
CT2=$(echo "$OUT2" | sed -E 's/.*"ciphertext":"([^"]+)".*/\1/')
r POST transit/rewrap/lf-plain "{\"ciphertext\":\"$CT2\",\"associated_data\":\"$AD\"}"
r POST transit/decrypt/lf-plain "{\"ciphertext\":\"$CT2\",\"associated_data\":\"$AD\"}"
echo "== min_decryption_version=2 then decrypt v1"; r POST transit/keys/lf-derived/config '{"min_decryption_version":2}'
r POST transit/decrypt/lf-derived "{\"ciphertext\":\"$CT\",\"context\":\"$C1\"}"
r GET transit/keys/lf-derived
echo "== datakey plaintext derived"; r POST transit/datakey/plaintext/lf-derived "{\"context\":\"$C1\"}"
echo "== bad token"; curl -s -w '  [HTTP %{http_code}]\n' -X POST -H "X-Vault-Token: nope" -d "{\"plaintext\":\"$DEK\",\"context\":\"$C1\"}" $A/v1/transit/encrypt/lf-derived
echo "== missing key name encrypt (update-only policy would 400); root upserts"; r POST transit/decrypt/missing-key "{\"ciphertext\":\"$CT\",\"context\":\"$C1\"}"
echo "== approle"; r POST sys/auth/approle '{"type":"approle"}'
r POST sys/policies/acl/lf-transit '{"policy":"path \"transit/encrypt/lf-derived\" { capabilities = [\"update\"] }\npath \"transit/decrypt/lf-derived\" { capabilities = [\"update\"] }\npath \"transit/rewrap/lf-derived\" { capabilities = [\"update\"] }\npath \"transit/keys/lf-derived\" { capabilities = [\"read\"] }"}'
r POST auth/approle/role/lf-api '{"token_policies":"lf-transit","token_ttl":"20m","token_max_ttl":"1h","secret_id_ttl":"0"}'
RID=$(curl -s -H "X-Vault-Token: $TOK" $A/v1/auth/approle/role/lf-api/role-id | sed -E 's/.*"role_id":"([^"]+)".*/\1/')
SID=$(curl -s -X POST -H "X-Vault-Token: $TOK" $A/v1/auth/approle/role/lf-api/secret-id | sed -E 's/.*"secret_id":"([^"]+)".*/\1/')
LOGIN=$(curl -s -X POST -d "{\"role_id\":\"$RID\",\"secret_id\":\"$SID\"}" $A/v1/auth/approle/login)
echo "$LOGIN" | sed -E 's/"client_token":"[^"]+"/"client_token":"<redacted>"/; s/"accessor":"[^"]+"/"accessor":"<redacted>"/'
AT=$(echo "$LOGIN" | sed -E 's/.*"client_token":"([^"]+)".*/\1/')
echo "== approle token: rotate denied"; curl -s -w '  [HTTP %{http_code}]\n' -X POST -H "X-Vault-Token: $AT" $A/v1/transit/keys/lf-derived/rotate
echo "== approle token: read key"; curl -s -o /dev/null -w '  [HTTP %{http_code}]\n' -H "X-Vault-Token: $AT" $A/v1/transit/keys/lf-derived
echo "== namespace header (unknown ns)"; curl -s -w '  [HTTP %{http_code}]\n' -X POST -H "X-Vault-Token: $TOK" -H "X-Vault-Namespace: nope" -d "{\"ciphertext\":\"$CT\",\"context\":\"$C1\"}" $A/v1/transit/decrypt/lf-derived
echo "== sealed"; r POST sys/seal ''
curl -s -w '  [HTTP %{http_code}]\n' -X POST -H "X-Vault-Token: $TOK" -d "{\"ciphertext\":\"$CT\",\"context\":\"$C1\"}" $A/v1/transit/decrypt/lf-derived
