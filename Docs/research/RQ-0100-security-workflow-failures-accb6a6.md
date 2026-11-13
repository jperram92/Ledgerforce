---
id: RQ-0100
title: Security workflow failures at accb6a6 (Gitleaks history, Alpine zlib CVE-2026-4738) and nested pnpm
status: resolved
opened: 2026-11-12
resolved: 2026-11-12
opened_by: claude
linked_tasks: [T-0121]
linked_adrs: [ADR-0043]
superseded_by:
---

# RQ-0100 — Security workflow failures at accb6a6 and the nested pnpm failure

## Questions
1. Are the Gitleaks history findings in run 43151980363 real credentials or test fixtures?
2. What is the supported remediation for CVE-2026-4738 (zlib 1.3.2-r1) in the api/worker/setup images?
3. Why did `scripts/agent/test/scripts.test.ts:99` fail in Codex's Linux clone?

## Evidence

| Source inspected | Date | Finding |
|---|---|---|
| Job 130963048294 log (run 43151980363) | 2026-11-12 | `history: FAIL`, two `generic-api-key` fingerprints: `2847774…:apps/api/src/payments/stripe-webhook.db.test.ts:149` and `db48271…:packages/connectors/stripe/src/stripe-webhook.contract.db.test.ts:529`. Working-tree `secrets: PASS`. |
| `git show` of both lines (values redacted when printed) | 2026-11-12 | Line 149 builds a deliberately **forged** webhook secret at runtime, to prove a bad signature answers 400. Line 529 is an idempotency-key field holding a readable test label (t0074 eft plain, hyphenated). Neither is a credential. |
| `git merge-base --is-ancestor`, `git branch -a --contains` | 2026-11-12 | Both commits are only on `origin/feat/T-0074-stripe-webhooks` (unmerged, 2026-11-02), not on main. CI checks out with `fetch-depth: 0` and Gitleaks' git mode scans all fetched refs, so pushed task branches enter the main history scan. |
| ADR-0043 rule 5; DL-0244; DL-0247 | 2026-11-12 | Findings need remediation or a separately human-reviewed, narrowly scoped exception. History cannot be rewritten (AGENTS.md §0.6). Precedent: commit-scoped `.gitleaksignore` fingerprints after `git show` verification. |
| Jobs 130963048714 / …602 / …513 logs | 2026-11-12 | api, worker, setup: one Critical, `CVE-2026-4738 zlib@1.3.2-r1 (apk) fixed in: 1.4-r0`. web (Alpine, `apk upgrade --no-cache`, DL-0248) **passed** at the same commit. |
| [OSV ALPINE-CVE-2026-4738](https://osv.dev/vulnerability/ALPINE-CVE-2026-4738) | 2026-11-12 | Alpine zlib: all versions before 1.4-r0 affected; fixed in 1.4-r0. |
| Public remediation PRs, e.g. [OpenBankingUK/conformance-suite-v2#278](https://github.com/OpenBankingUK/conformance-suite-v2/pull/278), [archestra-ai/archestra#10429](https://github.com/archestra-ai/archestra/pull/10429), [owine/labelprint#37](https://github.com/owine/labelprint/pull/37) | 2026-11-12 | Current Alpine branches (3.22–3.24, edge) ship zlib 1.4-r0; official node/nginx alpine images lag. Remediation used: `apk upgrade --no-cache` (or `zlib`) in the runtime stage. Not independently confirmed against the Alpine CDN (blocked from this sandbox); CI rebuild is the proof. |
| `.agent/evidence/T-0121/agent-suite-handoff.txt`; this session | 2026-11-12 | Codex's failure: `Cannot find module '/root/.cache/node/corepack/v1/pnpm/12.18.0/bin/pnpm.cjs'`. The test's temp repo has no `packageManager` pin, so a Corepack shim resolved its default pnpm (12.18.0), which was not in the cache. In this session `pnpm` is a direct install (10.28.0, `/opt/node-tools`), and the unchanged suite passes 93/93 (`agent-suite-claude-20261112.txt`). |

## Conclusion
1. **Test fixtures, not credentials.** Remediation without history rewrite needs two commit-scoped `.gitleaksignore` fingerprints, which ADR-0043 requires a human to approve. A proposal is in `.agent/evidence/T-0121/gitleaks-exception-proposal-claude-20261112.md`; the scanner, its config and its thresholds are not changed. Other pushed branches could surface more fingerprints; each must be verified the same way.
2. **Remediate in the image, not the gate:** `RUN apk upgrade --no-cache` in the Alpine `node-runtime` stage before `USER node`, the pattern already proven on the web stage. Contract test added RED→GREEN; image verdict comes from CI.
3. **Environment, not code:** use a pnpm that does not depend on an uncached Corepack download (direct install, or `corepack install -g pnpm@10.28.0` with network). No test, timeout or verifier change.
