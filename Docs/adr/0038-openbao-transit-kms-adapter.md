---
adr: 0038
title: "OpenBao/Vault transit KMS adapter: derived-key context binds the record, 60-byte wrapped key with versioned key id, HTTPS-only fetch with no redirects, strict key policy"
status: Proposed
date: 2026-10-26
author: claude
category: security
human_gate: yes
supersedes: none
superseded_by: none
---

# ADR-0038: OpenBao/Vault transit KMS adapter

## Status

Proposed — security category, waiting for product-owner acceptance. It adds the second `Kms`
adapter that ADR-0018 named as a consequence ("an OpenBao/Vault transit adapter over HTTP, so no
SDK is needed"). It does not change ADR-0018's envelope format, AAD or the local keyring, which
stays the MVP default. Research: [RQ-0042](../research/RQ-0042-openbao-transit-kms-adapter.md).
Task: T-0108 (Phase 1; nothing in the MVP depends on it).

## Context and problem statement

`sealField`/`openField` (packages/shared/src/crypto/envelope.ts) wrap each field's data key (DEK)
through a `Kms`. Operators who already run OpenBao (MPL 2.0) or Vault want the key-encryption key
(KEK) to stay inside it, not on the app host. The adapter has to keep every SS-PLAT-38 behaviour:
a wrapped DEK copied to another record must fail, any tampering must fail closed, and rotation
must keep old data readable. It also must not leak the OpenBao token or any plaintext.

RQ-0042 found four facts that shape the design:
- rewrap ignores `associated_data`, so AAD-bound ciphertexts cannot be rewrapped on the server;
- `context` sent to a non-derived key is silently ignored, so binding would be lost without an
  error;
- following a redirect forwards `X-Vault-Token` to the new origin;
- the existing columns hold exactly 60 wrapped bytes and a `[A-Za-z0-9_.-]{1,64}` key id.

## Decision drivers

- Record binding must hold and must not depend on operator care (fail at start, not silently).
- Server-side rewrap after rotation (the DEK never leaves OpenBao during re-keying).
- No schema change for existing sealed columns (migrations 0013, 0017); no SDK; no new runtime
  dependency.
- Secrets (token, AppRole secret id, DEK, plaintext) never in logs, errors or redirects.

## Considered options

### Option A — `associated_data` on a plain aes256-gcm96 key

The AAD maps directly to the record AAD. However, rewrap is impossible (RQ-0042 Finding 5), so
re-keying would have to decrypt the DEK into the app. Rejected.

### Option B — derived key (`derived=true`) with `context` = `lf-kek-transit-v1|<record aad>` (chosen)

HKDF-SHA256 derives a per-record key, so a wrapped DEK under another context fails GCM
authentication, and rewrap works with the same context. It needs the key created with
`derived=true`, which the adapter checks at start.

### Option C — `datakey` endpoint to generate the DEK in OpenBao

This gives the same security as encrypting a DEK made by the app's CSPRNG, but it changes the
`Kms` interface and `sealField`. It may come later; it is not needed now.

## Decision outcome

Chosen option: **B**, with these rules (all enforced in `TransitKms` and covered by SS-PLAT-87/88):

1. **Key policy at start:** `GET /v1/<mount>/keys/<name>` must show `type=aes256-gcm96`,
   `derived=true`, no convergent encryption, encryption and decryption supported,
   `exportable=false`, `allow_plaintext_backup=false`; otherwise `connect` throws.
2. **Binding:** `context = base64(utf8("lf-kek-transit-v1|" + aad))` on encrypt, decrypt and
   rewrap; `associated_data` is never sent.
3. **Storage:** `wrapped` = the 60 decoded bytes after `vault:v<N>:`; `keyId = tr.<name>.v<N>`.
   Unwrap checks the key name, rebuilds the ciphertext, and fails closed on any mismatch.
4. **Versions:** `activeKeyId` follows the server's latest version; `rewrap` uses
   `/rewrap/<name>`; `rewrapField` updates a sealed field without touching its data ciphertext.
   Operators raise `min_decryption_version` only after every row has been rewrapped.
5. **Transport:**
   - Node `fetch` only, over `https:`. Plain `http:` is allowed only for a loopback host and only
     with explicit opt-in.
   - A private CA is given through `NODE_EXTRA_CA_CERTS`.
   - `redirect: 'manual'`, and any 3xx is an error.
   - Each attempt has a timeout.
   - 429, 5xx, network errors and timeouts are retried with capped exponential full-jitter
     backoff that honours `Retry-After`. 4xx is never retried.
6. **Errors and logs:**
   - A 400 on decrypt or rewrap is a `DecryptionError`.
   - Everything else is a `TransitKmsError` that carries only the operation, kind and status,
     never the server's body.
   - Log events carry only op, status, attempt, duration and outcome.
7. **Auth:**
   - A token read from a file, or AppRole (`role_id`/`secret_id` read from files).
   - It logs in again at two-thirds of the lease, and once more after a 403.
   - `X-Vault-Namespace` is supported.
   - The minimum ACL policy is in RQ-0042: no `create` on encrypt, and no rotate.
8. **Selection:** `LF_KMS_PROVIDER=local|transit` (`kmsFromEnv`). Unset means no KMS, which is
   today's behaviour: the bank-detail routes answer 503.

## Consequences

### Good

- The KEK never leaves OpenBao. Re-keying after rotation needs no plaintext DEK in the app.
- Record binding cannot be disabled by misconfiguration: the adapter refuses to start.
- Existing schema and envelope format are unchanged; local keyring data and transit data can
  coexist (key ids `tr.*` never collide with keyring ids unless an operator names a local key so).

### Bad / accepted trade-offs

- The key must be `aes256-gcm96` (60-byte wrapped size). Other AEAD types need a schema change.
- Each seal/open is one HTTP round trip to OpenBao. OpenBao availability becomes a dependency
  for reading bank details (by design of a remote KMS).
- `NODE_EXTRA_CA_CERTS` is process-wide (read at start). A per-adapter CA would need
  `node:https` or an undici dispatcher.
- A single 400 on decrypt fails closed as `DecryptionError`, including "version too old"; the
  log event's `reason` tells operators which.

### Follow-ups

- Wire `kmsFromEnv` into `apps/api/src/main.ts` (one line; not done in T-0108 so the MVP boot
  path is untouched).
- A batch rewrap job over sealed columns after rotation (uses `rewrapField`).

## Compliance and verification

- SS-PLAT-87: the KMS contract suite (SS-PLAT-38 behaviours plus versions and rewrap) runs for
  the local keyring and for `TransitKms` against the in-process fake
  (`packages/shared/src/crypto/transit-kms.test.ts`). With `pnpm test:openbao` it also runs
  against the real OpenBao 2.7.1 binary (pinned SHA-256).
- SS-PLAT-88: transport, auth, key policy, redaction and config selection tests in the same file.

## Links

- [RQ-0042](../research/RQ-0042-openbao-transit-kms-adapter.md), [RQ-0018](../research/RQ-0018-envelope-encryption-kms.md)
- [ADR-0018](0018-envelope-encryption-local-keyring-kms.md)
- DL-0200…DL-0204
