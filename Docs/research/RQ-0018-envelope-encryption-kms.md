---
id: RQ-0018
title: Envelope encryption for bank details — self-host KMS choice, AES-GCM usage, record binding
status: answered
opened: 2026-10-24
resolved: 2026-10-24
opened_by: claude
linked_tasks: [T-0037]
linked_adrs: [ADR-0018]
---

# RQ-0018 — Envelope encryption and the self-host KMS

## Question

1. Q1 — Which key-management backend does the self-hosted MVP use: HashiCorp Vault, OpenBao, or a
   local key file / Docker secret? (T-0037 open question; design §6.6 "keys in a KMS or Vault")
2. Q2 — How is AES-GCM used safely (IV size, nonce limits, authentication), with no new
   runtime dependency?
3. Q3 — How do we stop a ciphertext being copied onto another party's row (substitution)?
4. Q4 — Which fields are encrypted, and what does masking show?

## Why it matters

Design §6.1 names payment redirection (changed supplier bank details) as the biggest real-world
risk. §6.6 requires envelope encryption of bank account numbers, decryption only in the service
that needs it, and masking to the last 3 digits. A wrong choice here is either a licence problem
for an AGPL self-hosted product (§11.2), or an encryption that looks right but lets an attacker
swap or replay ciphertexts.

## Sources consulted

| # | Source | Accessed | Kind | What it says |
|---|---|---|---|---|
| S1 | https://jorijn.com/en/blog/hashicorp-vault-vs-openbao/ ; https://www.openlogic.com/blog/hashicorp-vault-alternatives-openbao-vs-vault ; https://wz-it.com/en/blog/openbao-vs-vault-comparison/ | 2026-10-24 | secondary (consistent) | Vault moved from MPL 2.0 to BUSL 1.1 in Aug 2023 (not OSI open source; restricts competing hosted offerings). OpenBao forked from Vault 1.14 under MPL 2.0, Linux Foundation / OpenSSF, keeps the Vault API including the transit engine |
| S2 | https://web.cecs.pdx.edu/~dmcgrath/courses/Su26/secdevops/openbao.html | 2026-10-24 | secondary | transit is among the engines both share |
| S3 | NIST SP 800-38D §8.3, quoted in https://mta.openssl.org/pipermail/openssl-users/2016-May/003793.html and https://csrc.nist.gov/csrc/media/Events/2023/third-workshop-on-block-cipher-modes-of-operation/documents/accepted-papers/Practical%20Challenges%20with%20AES-GCM.pdf | 2026-10-24 | primary (quoted) / NIST workshop paper | random (RBG) IVs: total invocations per key ≤ 2^32; 96-bit IVs recommended |
| S4 | Node.js crypto docs, `createCipheriv('aes-256-gcm')`, `setAAD`, `getAuthTag` (https://nodejs.org/docs/latest-v22.x/api/crypto.html) | 2026-10-24 | primary | AES-256-GCM with AAD and a 16-byte tag in the standard library; no dependency needed |
| S5 | RQ-0006 (this repo), ABA format | 2026-10-24 | prior research | BSB `nnn-nnn`; account number 1–9 characters `[0-9A-Za-z-]` |
| S6 | Design §6.1, §6.5, §6.6, §4.2 | 2026-10-24 | design | envelope encryption; masked to last 3 digits; never from Salesforce; requester ≠ verifier (T-0053) |

## Findings

1. Vault's licence changed to BUSL 1.1 (Aug 2023); OpenBao is the MPL-2.0 fork with the same API
   (S1, S2). *Inference:* bundling Vault with an AGPL self-host distribution is a licence risk.
   OpenBao is compatible, but adds a stateful service operators must unseal and back up, which is
   heavy for an SMB single-host install (design §8 "self-hosted Compose install").
2. AES-256-GCM with a random 96-bit IV is safe while one key stays under 2^32 encryptions (S3).
   With a fresh data key (DEK) per encrypted field, a DEK is used once. The key-encryption key
   (KEK) wraps one DEK per record, so it is far below 2^32 for any SMB. Rotation adds a new KEK id
   for new wraps (S3, inference).
3. GCM's AAD authenticates context without encrypting it (S4). Binding AAD to
   tenant/company/party/record/field and a format version makes a copied ciphertext fail
   authentication on any other row (S4, inference — proven by test).
4. The BSB is a public branch identifier and is needed in clear for ABA files and display (S5).
   The account number is the secret (S6). Masking shows its last 3 characters (S6).

## Conclusion / decision

- **Interface `Kms`** (packages/shared): `activeKeyId`, `wrap(dek, aad)`, `unwrap(wrapped, keyId, aad)`.
  Adapters:
  - **MVP self-host:** `LocalKeyringKms`. KEKs are 32-byte keys from a key file or Docker secret
    (`LF_KMS_KEYRING_FILE`), JSON `{ "active": "<id>", "keys": { "<id>": "<base64>" } }`. Wrapping
    is AES-256-GCM with AAD `lf-kek-v1|<keyId>|<record aad>`. Never logged, never in the repo.
  - **Later:** an OpenBao/Vault transit adapter over HTTP, so no SDK is needed (new card), and a
    cloud KMS for hosted SaaS (Phase 1, design §8).
- **Data encryption:** per field, a fresh 32-byte DEK, AES-256-GCM, random 12-byte IV, 16-byte
  tag. AAD = `lf-field-v1|<tenant>|<company>|<party>|<record id>|<field>`. Store ciphertext, IV,
  tag, wrapped DEK, KEK id, format version 1.
- **Fields:** encrypt `account_number`; keep `bsb` and `account_name` in clear; store
  `account_number_last3` for masking without decryption.
- **Read paths:** list/read return masked data only. Decryption is a separate, explicit function
  for the payment-file service (ABA, T-0054). A plain database read can never yield the number.
- **Never from Salesforce:** `source` column restricted to ui | api | import.

## Confidence

`high` for Q2–Q4 (standard library documentation, NIST rule as quoted, verified by tests); `medium` for Q1
(licence facts consistent across several secondary sources; the KMS choice is a judgement → ADR, human gate).

## Follow-ups

- ADR-0018 (security, Proposed).
- Card: OpenBao/Vault transit KMS adapter (HTTP).
- T-0053 (bank-detail verification workflow, requester ≠ verifier, cooling-off) builds on this table.
- T-0054 (ABA export) is the only intended caller of decryption.

**Affects:** T-0037, T-0053, T-0054, packages/shared (crypto), packages/modules/parties, apps/api, design §6.6.
