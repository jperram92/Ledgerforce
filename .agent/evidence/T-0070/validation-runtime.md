# T-0070 validation runtime

Verification checkout: `/var/tmp/ledgerforce-t0070-validation-20261106/repo`, Ubuntu WSL, commit `950c378` (production source unchanged from `564c5d1`). Results: sibling `results/verify.log`, copied to this task's `verify.log` when complete.

Prerequisites are the pinned Node 22.22.0 / pnpm 10.28.0 toolchain, native PostgreSQL 16 and Playwright's pinned Chromium plus system dependencies. Corepack's global fallback is also pinned to pnpm 10.28.0, because agent tests create temporary projects without a packageManager field. Install project dependencies with the frozen lockfile. Runtime investigation is preserved at `71da22e:Docs/research/RQ-0111-windows-validation-runtime.md`; this task adopts it under DL-0302.

The standalone branch has reserved migration gaps 0048 and 0049. Only in the local validation checkout, create `0048_local_gap_placeholder.sql` and `0049_local_gap_placeholder.sql` containing a comment and `SELECT 1;`, as instructed by the original task handoff. Never stage them; the owner's integration plan supplies the actual migrations.

From the native checkout with the pinned Linux tools first in PATH:

```bash
export VITEST_MAX_WORKERS=1
export LF_TEST_DB_MODE=local
export TMPDIR=/run/ledgerforce-t0070-tests
mkdir -p "$TMPDIR"
taskset -c 0,1 bash scripts/agent/verify.sh --task T-0070
```

`/run` is executable native tmpfs on this host. This uses real concurrent filesystem operations while avoiding the measured ext4 rename latency that prevented the atomic stress test reaching its unchanged iteration minimum. No test is skipped, mocked, shortened or given a longer deadline. CPU affinity bounds competing test processes; the 10,000-document invariant suite still runs in full. This is not evidence of a Windows-specific fix.

Keep the actual aggregate result: missing coverage baseline and independent review remain pending when the verifier says so. Standalone verification does not establish integration readiness or production worker scheduling; that wiring remains a separate follow-up in the owner plan.

## First verifier and browser follow-up

The first run returned 13 PASS / 1 FAIL / 2 PENDING. All 1,351 database tests passed (including 694 RLS tests), as did 82 agent tests. The browser gate passed 96/99: SS-PLAT-79, SS-PLAT-94 and SS-PLAT-99 reached their 30-second deadlines during navigation or accessibility scans. Initial traces and screenshots are preserved in `20261106-e2e-initial/`.

Playwright 1.63.0 installed `lib/common/index.js` computes percentage workers from `os.cpus().length`; the two-CPU taskset restriction does not reduce that count. A complete browser rerun without taskset is recorded separately in `20261106-e2e-unbound.log`. Tests, retries and deadlines are unchanged. This experiment tests CPU contention; its outcome is not yet known.

- Browser follow-up: unrestricted four-worker run passed 98/99; SS-PLAT-94 still reached the 30-second deadline. Result in 20261106-e2e-unbound.log; its trace retained in 20261106-e2e-unbound/. Full suite now running with `pnpm -s run test:e2e --workers=1`, unchanged assertions/timeouts/retries. Native output results/e2e-serial-20261106.log, session 99381.

- Serial browser result: all 99 tests PASS (8.4 minutes), including SS-PLAT-94 in 22.2 seconds and SS-PLAT-99 in 19.8 seconds. No test/deadline/retry changes. Full verifier now running via `.agent/evidence/T-0070/verify-runtime.sh`, session 67017: exported pnpm adapter adds only `--workers=1` to the exact `pnpm -s run test:e2e` invocation and forwards all other commands unchanged. This is an explicit runtime scheduling choice, not a production patch.
