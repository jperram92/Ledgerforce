---
id: RQ-0042
title: OpenBao/Vault transit engine over HTTP as a KMS for envelope encryption — API, key versions, record binding, auth, TLS, errors, testing without Docker
status: answered
opened: 2026-10-26
resolved: 2026-10-26
opened_by: claude
linked_tasks: [T-0108]
linked_adrs: [ADR-0018, ADR-0038]
superseded_by:
---

# RQ-0042 — OpenBao/Vault transit KMS adapter (HTTP, no SDK)

## Question

1. Q1 — What are the exact request/response shapes of the transit `encrypt`, `decrypt`,
   `rewrap`, `datakey`, `keys` (read/rotate/config) endpoints, and the ciphertext format?
2. Q2 — How do key versions, rotation, `min_decryption_version` and `min_encryption_version`
   behave, and what does a client see for retired versions?
3. Q3 — How do we bind a wrapped data key to its record (the envelope's record-bound AAD,
   ADR-0018) so that a wrapped key copied to another row fails, *and* keep server-side rewrap
   working? `associated_data` or derived-key `context`?
4. Q4 — Authentication: static token vs AppRole; headers; namespaces.
5. Q5 — TLS with Node's built-in `fetch` (no SDK, no new runtime dependency), redirects.
6. Q6 — HTTP status codes and error body; which are transient (retry) and which are not.
7. Q7 — Can the result fit the existing schema (`dek_wrapped bytea CHECK octet_length = 60`,
   `kek_id ~ '^[A-Za-z0-9_.-]{1,64}$'`, migrations 0013 and 0017) without a migration?
8. Q8 — How to test without Docker: a contract-tested local fake, and can a real OpenBao binary
   be obtained legally and safely (pinned, checksum-verified) and run locally?

## Why it matters

T-0108 adds a second `Kms` adapter (design §6.6; ADR-0018 consequence) so operators who run a
secrets manager can keep key-encryption keys (KEKs) off the app host. Bank account numbers and
Salesforce credentials are sealed with it (design §6.1: payment redirection is the top fraud
risk). A guess here produces encryption that *looks* right but loses record binding, leaks the
token, or breaks rotation.

## Sources consulted

The openbao.org and developer.hashicorp.com sites are blocked by this session's egress proxy
(HTTP 403, `connect_rejected`). The same documentation was read from the OpenBao source tree,
fetched as the Go module zip from proxy.golang.org (module hash checked by the Go checksum
database). Behaviour was then confirmed by experiment against the official OpenBao 2.7.1 binary.

| # | Source (URL or command) | Accessed | Kind | What it says |
|---|---|---|---|---|
| S1 | `website/content/api-docs/secret/transit.mdx` in `github.com/openbao/openbao@v0.0.0-20260714213526-4771dc118499` (zip from https://proxy.golang.org, sha256 `bb43d0c8…c1c5f2`); published at https://openbao.org/api-docs/secret/transit/ | 2026-10-26 | primary (vendor docs, source) | Endpoints `POST /transit/encrypt/:name` (`plaintext` b64, `context` b64, `associated_data` b64, `key_version`, `nonce`, `batch_input`), `POST /transit/decrypt/:name` (`ciphertext`, `context`, `associated_data`), `POST /transit/rewrap/:name` (`ciphertext`, `context`, `key_version`, `nonce`, **no `associated_data`**), `POST /transit/datakey/:type/:name` (`plaintext`\|`wrapped`, `context`, `associated_data`, `bits` 128/256/512), `GET /transit/keys/:name`, `POST /transit/keys/:name/rotate`, `POST /transit/keys/:name/config` (`min_decryption_version`, `min_encryption_version` = 0 or ≥ min_decryption). Responses `{"data":{"ciphertext":"vault:v1:…"}}` / `{"data":{"plaintext":"…"}}`. Key types: `aes256-gcm96` default; `derived` requires `context` on every call |
| S2 | `website/content/docs/secrets/transit/index.mdx` (same zip) | 2026-10-26 | primary | Ciphertext `vault:v<N>:<base64(IV ‖ ciphertext)>`: `vault` = wrapped by OpenBao, `v<N>` = key version. Versions below `min_decryption_version` are archived and cannot decrypt; in an emergency it can be moved back. Datakey returns a high-entropy key encrypted with the named key, optionally also in plaintext |
| S3 | `builtin/logical/transit/path_rewrap.go` (same zip), lines 133–150 | 2026-10-26 | source code | rewrap calls `p.Decrypt(item.DecodedContext, nil, item.Ciphertext)` then `p.Encrypt(item.KeyVersion, item.DecodedContext, nil, plaintext)` — no associated data on either side. Response `{"ciphertext","key_version"}` |
| S4 | `builtin/logical/transit/path_datakey.go` (same zip), lines 85–180 | 2026-10-26 | source code | `type` must be `plaintext` or `wrapped`; `bits` 128/256/512; response `ciphertext`, `key_version`, and `plaintext` (base64) only on the plaintext path |
| S5 | `website/content/api-docs/index.mdx` (same zip) §Transport, §Authentication, §Namespaces, §Error response, §HTTP status codes | 2026-10-26 | primary | TLS expected at all times; token in `X-Vault-Token` or `Authorization: Bearer`; namespace in `X-Vault-Namespace`; errors are `{"errors":[…]}` for status ≥ 400; 400 invalid request, 403 forbidden, 404 invalid path (also used to avoid state leakage), 405, 429 (standby health), 500 internal "try again later", 502 upstream, 503 sealed/maintenance "try again later" |
| S6 | `website/content/api-docs/auth/approle.mdx` §Login with AppRole (same zip) | 2026-10-26 | primary | `POST /auth/approle/login` `{role_id, secret_id}` → `{"auth":{"client_token","lease_duration","renewable",…}}` |
| S7 | `http/util.go:205` (same zip) | 2026-10-26 | source code | rate-limit quota exceeded → HTTP 429 |
| S8 | https://github.com/openbao/openbao/releases/download/v2.7.1/checksums.txt and `openbao_2.7.1_linux_amd64.tar.gz`; tag `v2.7.1` = `a5db72cef75c24b920ade02065b18dd8eb666bac` (`git ls-remote --tags`) | 2026-10-26 | primary (release) | archive sha256 `0e2f1ce10d124e03112b50dd2fbec6b78003783253bc3a91587938f39d1e2243` matches `checksums.txt`; `bao version` → `OpenBao v2.7.1 (a5db72ce…), committed 2026-10-01`. No detached signature at `checksums.txt.sig`/`.pem` (404). Licence MPL-2.0 (LICENSE in the archive) |
| S9 | Experiment E1: `bao server -dev` (2.7.1) + curl, script and output [`assets/RQ-0042/spike.sh`](assets/RQ-0042/spike.sh), output [`spike-output.txt`](assets/RQ-0042/spike-output.txt) (data-key plaintexts redacted) | 2026-10-26 | experiment | see Findings 3–8 |
| S10 | Experiment E2: `bao server -dev-tls` + Node v22.22.0 `fetch` ([`assets/RQ-0042/spike-tls.sh`](assets/RQ-0042/spike-tls.sh), output [`spike-tls-output.txt`](assets/RQ-0042/spike-tls-output.txt)) | 2026-10-26 | experiment | see Finding 9 |
| S11 | RQ-0018, ADR-0018, migrations 0013 and 0017 (this repo) | 2026-10-26 | prior research / schema | `Kms` interface, record AAD `lf-field-v1|tenant|company|party|record|field`; wrapped DEK column is exactly 60 bytes; key id `^[A-Za-z0-9_.-]{1,64}$` |

## Findings

1. **API shapes (Q1)** are as in S1/S3/S4. All binary values travel base64-encoded in JSON;
   responses wrap results in `data`. Encrypt/rewrap/datakey also return `key_version` (S3, S4, E1).
2. **Ciphertext format (Q1, Q7):** `vault:v<N>:<base64>` (S2). For `aes256-gcm96` the base64
   decodes to nonce(12) ‖ ciphertext ‖ tag(16) — for a 32-byte DEK that is **exactly 60 bytes**
   (E1: 80 base64 characters, no padding). *Inference:* the adapter can store the decoded 60 bytes
   in `dek_wrapped` and carry the version in the key id, so the schema needs no change.
3. **Wrong context fails closed (Q3):** decrypt with another context → HTTP 400
   `{"errors":["cipher: message authentication failed"]}`; with no context on a derived key → 400
   "missing 'context' for key derivation"; a ciphertext from another key → 400 auth failure; one
   flipped character → 400 auth failure (E1). The derived key uses `"kdf":"hkdf_sha256"` (E1, keys read).
4. **`context` sent to a NON-derived key is silently ignored** — encrypt returns 200 (E1). A
   misconfigured key would therefore lose record binding without any error. *Consequence:* the
   adapter must read the key and refuse to start unless `derived: true`.
5. **Rewrap and `associated_data` do not mix (Q3):** rewrap of a ciphertext made with
   `associated_data` → 400 auth failure even when `associated_data` is sent (S3, E1). Rewrap with
   the right `context` on a derived key → 200 `vault:v2:…`, `key_version: 2`; with the wrong
   context → 400 (E1). *Conclusion:* bind the record through derived-key `context`, not AAD.
6. **Versions (Q2):** rotate → `latest_version: 2`; new encrypts use v2; v1 still decrypts until
   `min_decryption_version: 2`, after which decrypt of v1 → 400 "ciphertext or signature version
   is disallowed by policy (too old)" and `keys` lists only `{"2":…}` (E1, S2).
7. **Auth and namespaces (Q4):** bad token → 403 `{"errors":["permission denied"]}`; AppRole login
   returns `auth.client_token` with `lease_duration: 1200` (role `token_ttl: 20m`); an AppRole token
   whose policy grants only encrypt/decrypt/rewrap/read-key gets 403 on rotate (E1, S6). An unknown
   `X-Vault-Namespace` → 404 `namespace not found` (E1) — namespaces exist in OpenBao 2.7.1.
8. **Errors (Q6):** sealed → 503 `Vault is sealed` (E1); 429 for rate-limit quotas (S7) and
   standby health (S5); 500/502/503 are "try again later" (S5). 400/403/404/405 describe the
   request and do not change on retry (S5, inference).
9. **TLS and redirects (Q5):** Node 22 `fetch` verifies the server certificate (fails with
   `UNABLE_TO_VERIFY_LEAF_SIGNATURE` against `-dev-tls`) and trusts a private CA given in
   `NODE_EXTRA_CA_CERTS` (200) (E2). With `redirect: 'follow'` (the default) a 307 to another port
   **forwards the custom `X-Vault-Token` header to the new origin**; with `redirect: 'manual'` the
   307 is returned and nothing is forwarded (E2).
10. **Datakey (Q1):** `/datakey/plaintext/:name` returns plaintext + ciphertext, `/wrapped/` only
    ciphertext (S4, E1). *Inference:* it gives the same result as encrypting a DEK the app made with
    `crypto.randomBytes`, but would require changing the `Kms` interface (`sealField` creates the
    DEK). Not needed.
11. **Real binary (Q8):** the official linux_amd64 release can be downloaded and verified against
    the published SHA-256 list, needs no Docker, and `-dev`/`-dev-tls` run in memory (S8, E1, E2).
    The checksum list itself is not signed at a URL we could find, so the repository pins the
    archive's SHA-256 (trust-on-first-use, recorded here).

## Conclusion / decision

- **Binding:** use a key created with `type=aes256-gcm96, derived=true` and send
  `context = base64(utf8("lf-kek-transit-v1|" + aad))` on encrypt, decrypt and rewrap. Do not
  send `associated_data` (breaks rewrap, Finding 5).
- **Refuse misconfigured keys at start** (`GET /v1/<mount>/keys/<name>`): require
  `type=aes256-gcm96`, `derived=true`, not convergent, `supports_encryption/decryption`,
  `exportable=false`, `allow_plaintext_backup=false` (Finding 4).
- **Storage format (no migration):** `wrapped` = the 60 decoded bytes; `keyId` =
  `tr.<key name>.v<N>` (key name `[A-Za-z0-9_-]{1,48}`). Unwrap rebuilds `vault:v<N>:<base64>`.
  The key id is cross-checked against the key name; a version mismatch fails closed.
- **Versions:** `activeKeyId` follows the server's latest version (read at start, updated from
  every encrypt response). `rewrap` uses the server's rewrap endpoint with the same context, so
  the DEK never leaves OpenBao during re-keying; raise `min_decryption_version` only after all
  rows are rewrapped (Finding 6).
- **Transport:** `fetch` only; `https:` required (plain `http:` only for loopback hosts with an
  explicit opt-in, for tests and `-dev`); private CA via `NODE_EXTRA_CA_CERTS`;
  `redirect: 'manual'` and any 3xx is an error (Finding 9); per-attempt timeout; retry 429/5xx and
  network errors/timeouts with exponential full-jitter backoff (honour `Retry-After`, capped);
  never retry 4xx (Finding 8).
- **Errors:** decrypt/rewrap 400 → `DecryptionError` (fail closed, same as the local keyring);
  other failures → `TransitKmsError` with operation, kind and status only — never the server
  body, token, plaintext or context. Log events carry only op, status, attempt, duration, outcome.
- **Auth:** static token from a file, or AppRole login (`role_id`/`secret_id` from files) with
  re-login before the lease ends and once on 403. Optional `X-Vault-Namespace`.
- **Minimum ACL policy** for the app's token:
  ```hcl
  path "transit/encrypt/lf-kek" { capabilities = ["update"] }
  path "transit/decrypt/lf-kek" { capabilities = ["update"] }
  path "transit/rewrap/lf-kek"  { capabilities = ["update"] }
  path "transit/keys/lf-kek"    { capabilities = ["read"] }
  ```
  (no `create` on encrypt, so a typo never upserts a new key; rotation stays an operator action).
- **Testing:** an in-process fake transit server that follows S1–S5 and E1 byte-for-byte where
  it matters (prefix, 60-byte body, status codes, error bodies), driven by one contract suite that
  also runs against the real OpenBao 2.7.1 binary in an opt-in integration run
  (`pnpm test:openbao`, pinned SHA-256, `-dev-tls`).
- Decisions: DL-0200…DL-0204; ADR-0038 (security, Proposed).

## Confidence

`high` — primary documentation and source code at a pinned commit, confirmed by executed
experiments against the official 2.7.1 release. Vault (BUSL 1.1) shares the API (RQ-0018 S1) but
was not run; Vault compatibility is inference (`medium`).
