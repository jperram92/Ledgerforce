# T-0048 verification recovery — 2026-11-11

Implementation under test: `4cc7e9e8ba68a1871edffa7c420f61c2abb20819`, branch HEAD `61307c8`.
No production code, tests, lockfile, approved postings, or security gates changed in this run.

## Environment

- Elevated Windows shell selects Node 22.22.0; sandbox shell selected Node 24.7.0.
- Restored installed dependencies using `corepack pnpm install --frozen-lockfile` (exit 0).
- WSL PostgreSQL 16: separate disposable cluster `/tmp/ledgerforce-t0048-r03`, loopback port 55448; existing main cluster untouched.
- Harness uses `LF_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55448/postgres`.
- Git Bash runs the unchanged verifier. `VITEST_MAX_WORKERS=1` reduces host contention without changing tests, timeouts, assertions, or property-run counts.

## Completed focused verification

`corepack pnpm exec vitest run --project unit --project db packages/modules/ar/src/write-off.test.ts packages/modules/ar/src/write-off.db.test.ts --maxWorkers=1`

Exit **0**: **2 files, 5 tests passed**, 15.47 seconds. Includes real PostgreSQL write-off scenarios and the impossible-date regression.

## Incomplete attempts

- Initial unit and database startup failed because `unplugin-swc` was unavailable; dependencies were then restored.
- Restored overlapping full suites were interrupted because of host contention. Unit output reported a DI timeout; DB output included a `job_common` permission error (not yet classified; the suite contains intentional denial tests). Neither interrupted run has a final result.
- Initial Git Bash verification was interrupted and its orphan test processes stopped. It is not a passing verification result.

## Full verification

One-worker full verifier completed: **10 PASS / 5 FAIL / 1 PENDING**, exit 1. Typecheck, lint, formatting, 963 Vitest tests, 8 Salesforce Jest tests, 82 agent-tooling tests, security audit, E2E/evidence, no-shortcut/no-delete checks and memory passed.

- Standalone full DB suite: **83 files / 1,178 tests passed**. See `db-20261111-r03-serial.txt`.
- Verifier DB suite: 82 files passed; user-list fixture setup failed at `user_role_check2`, leaving five tests unrun. RLS/migration gates inherit that failure. See `verify-20261111-r03-serial.txt`.
- Fixture correction: use database transaction time for revocation instead of the client clock. RQ-0098 documents the reasoning. All **five affected API tests passed**, as did targeted ESLint and Prettier. See `user-role-clock-green-20261112.txt`. No production code or constraint changed; full verifier has not been rerun after this test-only fix.
- Coverage failed at the first real ESLint-config test's unchanged 5s timeout. Idle retry also failed: **683 passed, 1 failed**. See `coverage-20261112-r03.txt`.
- Golden guard rejects Approved markers inherited since main despite recorded owner approvals DL-0256/DL-0263. It was not bypassed or modified. T-0121 tracks a researched, tested process repair.
- Claude cross-review remains pending. No coverage baseline comparison was possible because coverage did not finish successfully.

The earlier `job_common` error did not prevent the standalone DB suite passing; it is not established as a product defect. Prior interrupted results are superseded by the completed results above, not removed.

Fresh scenario evidence: `20261111-223537-tests-db.json` (recorder exit 0, four DB tests passed, SS-PLAT-106 passed; manifest appended). The recorder honestly labels HEAD `063e215c6cd9-dirty`: only task-status/documentation changes were pending, with production code unchanged from `4cc7e9e`.
