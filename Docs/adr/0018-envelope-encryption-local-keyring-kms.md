---
adr: 0018
title: "Envelope encryption of bank account numbers with a pluggable KMS; local keyring for self-host MVP"
status: Proposed
date: 2026-10-24
author: claude
category: security
human_gate: yes
supersedes: none
superseded_by: none
---

# ADR-0018: Envelope encryption with a pluggable KMS; local keyring for the self-host MVP

## Status

Proposed — security category, awaiting product-owner acceptance. T-0037 is built to this
proposal so it can be judged on working, tested code.

## Context and problem statement

Design §6.6 requires envelope encryption for bank account numbers (and later tax file numbers,
Salesforce tokens and API secrets), "keys in a KMS or Vault", decryption only in the service that
needs them, and masking to the last 3 digits. §6.1 ranks payment redirection as the top risk.
The MVP is self-hosted via Docker Compose (design §8). Research: RQ-0018.

## Decision drivers

- No secret readable from a database dump alone, or from any read path except the one that needs it.
- Licence compatibility with an AGPL self-hosted distribution (§11.2).
- Operable by an SMB on one host, with key rotation.
- No new runtime dependency (node:crypto only).
- A ciphertext cannot be moved to another record.

## Considered options

1. **Pluggable `Kms` interface; MVP adapter = local keyring from a key file or Docker secret (chosen).**
2. HashiCorp Vault transit: BUSL 1.1 since 2023, a licence risk to bundle (RQ-0018 F1).
3. OpenBao transit: MPL 2.0, compatible, but another stateful service to unseal and back up. Good
   as an optional adapter later.
4. pgcrypto in the database: the key would travel to, or live in, the database, defeating the dump
   protection.

## Decision outcome

Option 1:

- `Kms` interface (`activeKeyId`, `wrap`, `unwrap`) in `packages/shared/src/crypto`. Adapter
  `LocalKeyringKms` reads `{ active, keys: { id: base64(32 bytes) } }` from a file path (Docker secret).
  Old keys stay in the ring for unwrapping, so rotation is "add a key, switch active".
- Per field: fresh DEK, AES-256-GCM, random 96-bit IV, AAD binding tenant/company/party/record/field
  and a format version. DEK wrapped by the KEK with AAD including the key id.
- `app.party_bank_account` stores BSB, account name and last 3 digits in clear; the account number
  as ciphertext, IV, tag, wrapped DEK, KEK id and version. lf_app may INSERT and SELECT, and UPDATE
  only `status`. Changes are new rows (verification workflow T-0053).
- Read APIs return masked values. `revealAccountNumber()` is the only decrypting call, for payment
  files (T-0054).

### Consequences

- Good: a database dump or a SQL read exposes no account numbers. Ciphertexts can't be swapped.
  Rotation without re-encrypting data (new wraps use the new KEK).
- Good: an OpenBao/Vault or cloud KMS adapter can replace the keyring without changing data or callers.
- Bad: with the local keyring, the KEK sits on the same host as the app. A full host compromise
  reveals data. That is the accepted MVP trade-off, mitigated by file permissions and the
  Docker secret mount. Hosted SaaS uses a cloud KMS (Phase 1).
- Bad: losing the keyring file loses the data. Operators must back it up separately from the
  database (install docs).

## Compliance and verification

| Claim | Proven by |
|---|---|
| Ciphertext at rest; API returns only the last 3 digits | `packages/modules/parties/src/bank-accounts.db.test.ts`, `apps/api/src/parties/bank-accounts.db.test.ts` (SS-PLAT-22) |
| A ciphertext copied to another row fails to decrypt | same db test |
| Wrong or missing key fails closed; rotation keeps old data readable | `packages/shared/src/crypto/envelope.test.ts` |
| Bank details can't be sourced from Salesforce | db test (source check) |

## Links

- RQ-0018; design §4.2, §6.1, §6.6, §8; T-0037, T-0053, T-0054.
