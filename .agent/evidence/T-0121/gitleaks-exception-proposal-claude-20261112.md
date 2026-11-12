# Gitleaks history exception proposal — T-0121 (claude, 2026-11-12)

Status: **approved by owner 2026-11-12** (interactive session; recorded DL-0283). Both entries appended.

Run: https://github.com/jperram92/Ledgerforce/actions/runs/43151980363 (job 130963048294), `history: FAIL`; working tree `secrets: PASS`.

| Fingerprint | What the line is | Credential? |
|---|---|---|
| `2847774e1f6934dbaed059d4313354a899a58ba1:apps/api/src/payments/stripe-webhook.db.test.ts:generic-api-key:149` | A deliberately forged webhook signing secret, built at runtime as `whsec_` + 48 × `1`, used to prove a bad signature is rejected with 400 | No, synthetic |
| `db482717d614d5db1536a9c55a34a527f35d37fb:packages/connectors/stripe/src/stripe-webhook.contract.db.test.ts:generic-api-key:529` | an idempotency-key field holding a readable test label (t0074 eft plain, hyphenated) | No |

Both commits are only on the unmerged branch `feat/T-0074-stripe-webhooks` (2026-11-02). CI's full-history checkout scans every fetched branch.

Proposed: append exactly these two commit-scoped lines to `.gitleaksignore`, in the format the contract test enforces. No scanner, rule, threshold or workflow change. Alternatives: rewrite history (forbidden), or delete the branch (forbidden by directive 6, and it would hide rather than review the finding).
