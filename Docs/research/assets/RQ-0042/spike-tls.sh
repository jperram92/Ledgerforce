#!/usr/bin/env bash
# RQ-0042 spike 2: Node 22 fetch + TLS against `bao server -dev-tls`; redirect:'manual' behaviour.
set -uo pipefail
T="${T:?set T to a work dir holding release/bin/bao (scripts/test/openbao.sh downloads it)}"
BAO=$T/release/bin/bao
PORT=18298
CERTS=$T/spike-tls-certs
rm -rf "$CERTS"; mkdir -p "$CERTS"
"$BAO" server -dev-tls -dev-tls-cert-dir="$CERTS" -dev-root-token-id=spike -dev-listen-address=127.0.0.1:$PORT >"$T/spike-tls-server.log" 2>&1 &
PID=$!
trap 'kill $PID' EXIT
sleep 3
ls "$CERTS"
cat > "$T/spike-fetch.mjs" <<'EOF'
const url = process.argv[2];
try {
  const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
  console.log('status', r.status);
} catch (e) {
  console.log('error', e.name, e.message, e.cause?.code);
}
EOF
echo "== without extra CA"
env -u NODE_EXTRA_CA_CERTS -u SSL_CERT_FILE node "$T/spike-fetch.mjs" "https://127.0.0.1:$PORT/v1/sys/health"
echo "== with NODE_EXTRA_CA_CERTS=vault-ca.pem"
NODE_EXTRA_CA_CERTS="$CERTS/vault-ca.pem" node "$T/spike-fetch.mjs" "https://127.0.0.1:$PORT/v1/sys/health"
echo "== redirect manual"
cat > "$T/spike-redirect.mjs" <<'EOF'
import { createServer } from 'node:http';
let leaked = false;
const target = createServer((req, res) => { if (req.headers['x-vault-token']) leaked = true; res.end('{}'); });
await new Promise((r) => target.listen(0, '127.0.0.1', r));
const tport = target.address().port;
const src = createServer((req, res) => { res.writeHead(307, { location: `http://127.0.0.1:${tport}/v1/x` }); res.end(); });
await new Promise((r) => src.listen(0, '127.0.0.1', r));
const u = `http://127.0.0.1:${src.address().port}/v1/x`;
const m = await fetch(u, { redirect: 'manual', headers: { 'X-Vault-Token': 't' } });
console.log('manual -> status', m.status, 'type', m.type, 'leaked', leaked);
const f = await fetch(u, { redirect: 'follow', headers: { 'X-Vault-Token': 't' } });
console.log('follow -> status', f.status, 'leaked (cross-port custom header forwarded?)', leaked);
target.close(); src.close();
EOF
node "$T/spike-redirect.mjs"
