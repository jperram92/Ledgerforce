# T-0080 validation runtime

Source checkout: `/var/tmp/ledgerforce-t0080-validation-20261107/repo` at `c859544`; product code is unchanged from `81137b4`. This is native Ubuntu WSL validation, not a Windows-specific fix.

Reuse pinned Node 22.22.0, pnpm 10.28.0 (including Corepack global fallback), PostgreSQL 16 and Playwright Chromium from the runtime documented at `71da22e:Docs/research/RQ-0111-windows-validation-runtime.md`. Install from the frozen lockfile using the shared native pnpm store. No dependency versions are changed.

The standalone branch lacks migration 0050. The original task handoff permits a local-only `0050_local_gap_placeholder.sql` containing a comment and `SELECT 1;`. Never commit it; the integration plan supplies the real migration.

Run `verify-runtime.sh` in this evidence directory after preparing the checkout. It sets `VITEST_MAX_WORKERS=1`, `LF_TEST_DB_MODE=local` and executable native tmpfs `TMPDIR=/run/ledgerforce-t0080-tests`. Its exported package-manager adapter adds only `--workers=1` to the exact browser-suite invocation, forwarding every other command unchanged. All tests, assertions, retries and deadlines remain unchanged. This scheduling choice passed T-0070's full verifier at `3ba5481` after the original concurrent browser failures were preserved and diagnosed.

## Current run

Full log: `results/verify-serial-20261106-230201.log` in the native runtime. Started at 2026-11-06T23:02:01Z. Static and unit/agent gates passed; the database gate is running. Complete gate logs are copied to this directory by the companion capture process before verifier cleanup. The aggregate result is pending.

## Limits to retain

The original run `.agent/runs/2026-11-02-claude-r12.md` explicitly records that API tests were written after the controller. Passing current tests does not establish historical API test-first provenance. Preserve that finding for independent review; do not fabricate an earlier RED run. Module, CSV, golden and period-mirror RED logs remain preserved.

Missing main coverage baseline and independent review remain pending unless actually resolved. T-0080 delivers the opening-balance backend; the broader setup wizard and other deferred behaviors remain in T-0123 through T-0126. Approved GP-037 is unchanged by this continuation.
