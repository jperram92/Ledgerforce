# T-0048 invalid calendar date regression — GREEN

- Provider: codex
- Date: 2026-11-11
- Target: `2026-99-99` is rejected as `WriteOffError` / `INVALID_WRITE_OFF` before database access.
- Command: `corepack pnpm exec vitest run --project unit packages/modules/ar/src/write-off.test.ts`
- Exit: 0
- Result: 1 test passed.
- Additional scoped checks: `corepack pnpm --filter @ledgerforce/ar typecheck` exit 0; `corepack pnpm exec eslint packages/modules/ar/src/write-off.ts packages/modules/ar/src/write-off.test.ts --max-warnings=0` exit 0; `corepack pnpm exec prettier --check packages/modules/ar/src/write-off.ts packages/modules/ar/src/write-off.test.ts` exit 0.
- Still required: database tests, full verification, and independent Codex re-review after the full verification gates can run.
