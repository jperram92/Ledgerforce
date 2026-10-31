# T-0095 — Gitleaks findings on the repository and a proposed narrow exception (NOT applied)

- Author: claude, 2026-10-31 (run 2026-10-31-claude-r01). Status: **awaiting human review**.
- Scanner: `ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0…bbb7f` (digest verified on pull) via
  `node scripts/security/scan.mjs history|secrets . <out>`, `--redact=100` (every report shows
  `"Secret": "REDACTED"`).
- Result: history scan exit 1 (12 findings), working-tree scan exit 1 (8 findings), all rule
  `generic-api-key`. The new `security / secrets` job will therefore be **red** on every PR until
  this is decided. That is the correct fail-closed behaviour: ADR-0043 rule 5 says findings need
  remediation *or a separately human-reviewed, narrowly scoped exception*, and "this ADR authorizes
  no exceptions". History findings cannot be remediated without a history rewrite (AGENTS.md §0.6).

## Triage (agent opinion — every one looks like a false positive)

| File:line (tree) | Content kind | Why it is not a credential |
|---|---|---|
| `packages/connectors/salesforce/src/jwt.test.ts:14` | Salesforce consumer-key test placeholder | literal test placeholder |
| `Docs/ops/install.md:74` | example one-time password (sample setup output) in install docs | documentation sample output |
| `packages/connectors/salesforce/src/jwt-bearer.contract.test.ts:24` | same placeholder | test |
| `packages/connectors/salesforce/src/connection-store.db.test.ts:29` | same placeholder | test |
| `apps/worker/src/salesforce-writeback.outage.db.test.ts:56` | same placeholder | test |
| `apps/worker/src/sync-issues.db.test.ts:64` | same placeholder | test |
| `packages/shared/src/crypto/transit-kms.test.ts:526` | deliberately wrong AppRole secret-id test value | test |
| `salesforce/.../LFReadOnlyMirrorTest.cls:26` | Salesforce `TimeZoneSidKey` field set to a time-zone name | Salesforce time-zone field |

The human should confirm by reading those lines (the agent cannot vouch for itself — that is the
point of the gate).

## Proposed exception (for the owner to accept, amend or reject)

Option 1 — fingerprint allow-list `.gitleaksignore` at the repo root (Gitleaks reads it by
default), exactly these 20 fingerprints and nothing broader. New occurrences — even of the same
placeholder in a new file or line — still fail.

```
e0742f8702f95958f4c7b9326f5a44a6c04e65ef:apps/worker/src/sync-issues.db.test.ts:generic-api-key:64
6f73089f45f440a7287032b904851d55ecf033c0:Docs/ops/install.md:generic-api-key:74
9f0d9bf7f05289083d648565ed53edabd4929f1b:packages/shared/src/crypto/transit-kms.test.ts:generic-api-key:499
5d256127eafaf75b5ff2691e6edc61775a1e5b73:apps/worker/src/salesforce-writeback.outage.db.test.ts:generic-api-key:47
d8bb7af2b918814ad484deeaf4a48a0cc330a524:packages/connectors/salesforce/src/jwt.test.ts:generic-api-key:14
d8bb7af2b918814ad484deeaf4a48a0cc330a524:packages/connectors/salesforce/src/jwt-bearer.contract.test.ts:generic-api-key:24
d8bb7af2b918814ad484deeaf4a48a0cc330a524:packages/connectors/salesforce/src/connection-store.db.test.ts:generic-api-key:29
d8bb7af2b918814ad484deeaf4a48a0cc330a524:salesforce/force-app/main/default/classes/LFReadOnlyMirrorTest.cls:generic-api-key:26
1434ee7b4683aaeff721561205c3be15eb375933:packages/connectors/salesforce/src/jwt.test.ts:generic-api-key:14
1434ee7b4683aaeff721561205c3be15eb375933:packages/connectors/salesforce/src/jwt-bearer.contract.test.ts:generic-api-key:24
1434ee7b4683aaeff721561205c3be15eb375933:packages/connectors/salesforce/src/connection-store.db.test.ts:generic-api-key:29
1434ee7b4683aaeff721561205c3be15eb375933:salesforce/force-app/main/default/classes/LFReadOnlyMirrorTest.cls:generic-api-key:26
Docs/ops/install.md:generic-api-key:74
packages/connectors/salesforce/src/jwt.test.ts:generic-api-key:14
packages/connectors/salesforce/src/jwt-bearer.contract.test.ts:generic-api-key:24
apps/worker/src/salesforce-writeback.outage.db.test.ts:generic-api-key:56
apps/worker/src/sync-issues.db.test.ts:generic-api-key:64
packages/connectors/salesforce/src/connection-store.db.test.ts:generic-api-key:29
packages/shared/src/crypto/transit-kms.test.ts:generic-api-key:526
salesforce/force-app/main/default/classes/LFReadOnlyMirrorTest.cls:generic-api-key:26
```

Caveat: working-tree fingerprints contain the line number, so editing those files above the
flagged line will re-flag them (fails closed, needs a fingerprint refresh). Note the scanner runs
the directory scan with `/src` paths; the runner must strip that prefix or the ignore file must use
the `/src/...` form — to be confirmed by test when (if) the exception is accepted.

Option 2 — remediate the working tree (rename the placeholders so they no longer look like keys)
**and** accept fingerprint exceptions for the 12 history entries only.

Option 3 — reject; the secrets gate stays red until a different approach is proposed.
