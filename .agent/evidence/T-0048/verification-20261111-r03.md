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

One-worker full verifier is running; final result pending. Typecheck and lint have passed.
