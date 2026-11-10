# T-0166 validation

- Branch: feat/T-0166-gross-ecl-reconciliation; base d32dfeb.
- Golden unit runner: 5/5 passed on Windows, 2026-11-10; includes GP-038's three journals and all historical entries.
- No accounting production changes: this port adds an approved scenario and regression coverage for existing behavior. No fabricated RED/GREEN history.
- Native PostgreSQL test attempt did not start: WSL/CreateVm/HCS_E_CONNECTION_TIMEOUT. This is an environment failure, not a passing DB run. Use CI's real PostgreSQL job if the local VM remains unavailable.
- Root TypeScript check (`pnpm exec tsc -p tsconfig.json --noEmit`) and ESLint on both changed test files passed.
- DB lifecycle and full verifier remain pending. Independent cross-provider review remains required.
