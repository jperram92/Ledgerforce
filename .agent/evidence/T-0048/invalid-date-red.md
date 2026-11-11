# T-0048 invalid calendar date regression — RED

- Provider: codex
- Date: 2026-11-11
- Target: `2026-99-99` must be rejected as `WriteOffError` / `INVALID_WRITE_OFF` before any database access.
- Command: `corepack pnpm exec vitest run --project unit packages/modules/ar/src/write-off.test.ts`
- Exit: 1 (expected before implementation)
- Result: 1 test failed. Expected `{ name: "WriteOffError", code: "INVALID_WRITE_OFF" }`; received `TypeError: Cannot read properties of undefined (reading 'selectFrom')`. This proves the format-only validation let the impossible date proceed into database work instead of returning the documented domain error.
