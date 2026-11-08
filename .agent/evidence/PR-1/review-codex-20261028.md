# PR #1 merge-readiness review — NOT READY

Reviewer: codex. Reviewed head: `8bce763c05a9afe1657cd6125b90f3c286d6d35c`.
Local baseline: `feat/T-0010-tenant-context` at `f7af6bb`. Date: 2026-10-28.

## Comparison and scope

The PR contains every local commit: `git rev-list --left-right --count HEAD...origin/claude/app-framework-agents-dzmkya` returned `0 262`. No local changes need cherry-picking. Against main, this PR adds 137,396 lines in 2,255 files with no deleted files. Its sprint-0 title no longer describes its scope.

Reviewed the exact head in an isolated worktree (`.tmp/pr1-review`), installed frozen dependencies, ran tests/typecheck, inspected CI and the production manual-journal posting path. This is a merge-readiness review, not an exhaustive audit or cross-provider PASS of all tasks. Earlier Codex-authored work still requires another provider's review.

## Findings

1. **P1 — Both workflows use an unavailable expression context.** `.github/workflows/ci.yml:109` and `.github/workflows/install-smoke.yml:32` set `LF_EVIDENCE_DIR: ${{ runner.temp }}/evidence` in job-level `env`. GitHub does not allow `runner` in `jobs.<job_id>.env`; it does allow it in step-level env. Move this setting to the consuming steps, or populate it from `$RUNNER_TEMP` through `$GITHUB_ENV`. [Official context availability](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#context-availability). At this exact head, [CI run 40348063587](https://github.com/jperram92/Ledgerforce/actions/runs/40348063587) and [install-smoke run 40348065435](https://github.com/jperram92/Ledgerforce/actions/runs/40348065435) both failed with zero jobs and zero check runs. The invalid expression is consistent with these pre-job failures; the API did not expose a diagnostic explicitly attributing the failures to it. AGENTS.md section 5 prohibits CI security-gate edits, so this review does not change the workflows.

2. **P1 — Manual journal posting silently omits the transactional outbox.** `apps/api/src/journals/manual-journals.controller.ts:401-406` calls `postManualJournal` without `outbox`. `packages/modules/journals/src/manual-journals.ts:388` consequently passes no hook, and `packages/ledger/src/posting-engine.ts:683` selects `NO_OUTBOX` (a no-op at lines 138-140). Therefore successful API posts create neither the `ledger.entry.posted` event nor its delivery job. This violates the atomic posting/outbox contract in design section 3 and leaves downstream consumers unaware of posts. Wire the real `ledgerOutbox(boss)` through API dependencies. First add an API/DB regression asserting one event and job on success, no duplicate on replay, and rollback of the journal when enqueue fails. This finding is from the complete static call path, not a newly executed DB reproduction. T-0030's deferred question about requiring the hook does not make omission in a production caller safe.

3. **P2 — Install contract test fails on this Windows checkout.** `infra/test/install-contract.test.ts:312-315` passes a Windows absolute path to the selected `bash`. Both the full run and isolated rerun fail at line 317: `/bin/bash: C:UsersjamesLedgerforce.tmppr1-reviewinfracomposeinit-secrets.sh: No such file or directory`, exit 127. Select the supported shell and convert paths consistently; preserve the secret generation/idempotency assertions. This is a Windows harness failure, not evidence that the Linux deployment itself fails.

## Validation

| Command | Result |
| --- | --- |
| `corepack pnpm install --frozen-lockfile` | PASS; dependencies unchanged |
| `corepack pnpm typecheck` | PASS across workspaces |
| `corepack pnpm test` | FAIL: 902 passed, 3 failed, 67 files; two 5-second timeouts plus Windows install test |
| `corepack pnpm exec vitest run --project unit apps/api/src/di.test.ts packages/testing/eslint-rules/no-float-money.config.test.ts infra/test/install-contract.test.ts` | FAIL: 19 passed, 1 failed; lint test passes, Windows install failure repeats; API test belongs to a different project |
| `corepack pnpm exec vitest run --project api-unit apps/api/src/di.test.ts` | PASS: 1/1; original metadata timeout does not reproduce |

The two timeouts occurred under the full concurrent run and passed unchanged in isolation; they are not asserted to be deterministic product bugs. Full-suite status remains red. LWC tests were not reached after Vitest failed. DB, browser, lint, formatting, security scans and the full verifier were not rerun on this PR head; no PASS is claimed for those. Initial sandbox access errors were resolved by rerunning outside the sandbox; final results above use those reruns.

## Merge decision and next action

Do not merge: green CI and complete independent review are required by AGENTS.md sections 2 and 5. There are no GitHub reviews recorded at the inspected head. Proposed accounting/security ADRs and draft golden postings also require their existing human gates before dependent work is accepted; this review grants none of those approvals.

Next, fix findings 1–3 on the PR branch with the required authorization for protected CI changes and test-first evidence for behavior changes. Rerun CI, full verification and task-level cross-provider reviews at the resulting head. Refresh the PR title/body to describe its actual scope. Recheck ancestry before merging; do not replace or discard local work.
