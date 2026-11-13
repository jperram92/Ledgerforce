# T-0166 validation

- Branch: feat/T-0166-gross-ecl-reconciliation; base d32dfeb.
- Golden unit runner: 5/5 passed on Windows, 2026-11-10; includes GP-038's three journals and all historical entries.
- No accounting production changes: this port adds an approved scenario and regression coverage for existing behavior. No fabricated RED/GREEN history.
- Native PostgreSQL test attempt did not start: WSL/CreateVm/HCS_E_CONNECTION_TIMEOUT. This is an environment failure, not a passing DB run. Use CI's real PostgreSQL job if the local VM remains unavailable.
- Root TypeScript check (`pnpm exec tsc -p tsconfig.json --noEmit`) and ESLint on both changed test files passed.
- DB lifecycle and full verifier remain pending. Independent cross-provider review remains required.

## First CI on 57750a5

- CI 42726352115: static/unit, browser and 10,000-document invariants PASS. DB 1291 PASS / 1 FAIL: GP-038 omitted customer attribution on allowance line. Exact failure saved in ci-first-db-failure.log.
- Security 42726352427: PASS.
- DL-0311 adds GP-039 correcting canonical party and tax placement without editing GP-038. Strengthened regression verifies the tagged GST debit; canonical GST-ADJ reports its debit amount, not an explicit tax_amount field. Pending rerun.

## Second CI on eb356f9

- CI 42728847404: static/unit, browser and invariants PASS; DB 1291 PASS / 1 FAIL. Correct party and GST marker passed; exact comparison exposed a test binding error: AU services uses GST collected 2310, not the golden's illustrative Ref 2200.
- Fixed only the test's chart binding to 2310, as independently specified by the existing canonical template and golden binding registry. All exact line, party and tax assertions remain. No golden or production changes required for this correction. Pending rerun.

## Passing product CI on ad56bb9

- https://github.com/jperram92/Ledgerforce/actions/runs/42729484847 : static/unit, database/RLS, browser/evidence and fresh-seed 10,000-document invariant jobs PASS. The new GP-039 lifecycle executes all assertions including accrual 1B 125.00, cash 1B zero, and no GST from the subsequent release.
- Full verifier and security were still running when this section was recorded. Independent review is not supplied by these tests.
- golden-preservation.log proves all historical content (Git-normalized LF) remains an unchanged prefix, including the initial GP-038 entry.

- Completed DB job 129543568451: 96 test files, 1292 tests passed; exact output in ci-passing-tests.log. Security run 42729484502 also completed SUCCESS.

## Full verifier on ad56bb9

CI verifier: 12 PASS / 3 FAIL / 1 PENDING. Gate 4 rejects historical Approved additions versus main; gate 9 reports browser/evidence and missing T-0166 manifest; gate 12 sees the tested card still in_progress. Cross-provider review is PENDING. The follow-up adds the actual passing CI manifest and updates state; it does not waive approval or review gates. See final-verifier-summary.log. This branch is not fully green and not done.

Clarification after reading verifier implementation/full output: the browser command passed; gate 9 failed only because its manifest was absent. Coverage passed 73.39% against origin/main's 72.22% baseline at e39a76c. Earlier handover claims that main has no baseline referred to stale local main d20af5c and are superseded. No baseline was invented or changed.
