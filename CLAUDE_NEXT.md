# Claude: continue LedgerForce from here

Updated 12 November 2026. The owner requested that the accumulated work be integrated into `main` and handed to Claude. This integration is a handoff, **not a release or a declaration that the tasks are done**. T-0121 remains unfinished; T-0048 remains blocked.

## Copy this into Claude

> Read AGENTS.md and CLAUDE_NEXT.md, then run the repository resume skill. Continue T-0121 first, using a task branch from current main. Read .agent/HANDOVER.md, .agent/state.json, .agent/backlog/T-0121.md, .agent/backlog/T-0048.md and .agent/runs/2026-11-12-codex-r01.md. Inspect commit accb6a6 and its ancestors 2ffd7b3 and 4cc7e9e. Diagnose the outstanding security workflow and local verifier failures below without weakening checks. Re-run full verification against the actual remote main, then independently review the Codex changes and Proposed ADR-0047. Complete T-0121 and unblock T-0048 only when their applicable gates and evidence pass. Then select the next dependency-ready backlog task and keep building with research, TDD, evidence and checkpoint commits. Persist repository state before stopping.

## Start here

Use Node 22 and Git Bash or native Linux. In a clean checkout:

```bash
git fetch origin
git switch main
git pull --ff-only origin main
git switch -c feat/T-0121-claude-followup
bash scripts/agent/resume.sh
node scripts/agent/conductor.ts status
```

Claim/resume T-0121 using the repository skill and update state to the new branch. Do not overwrite another agent's active lease. Use frozen-lockfile dependency installation. Do not read or edit `.env*`.

## What Codex changed

- `4cc7e9e`: write-off validation rejects impossible ISO calendar dates (T-0048).
- `2ffd7b3`: user-role DB test fixture uses database transaction time instead of mixing JavaScript and database clocks; records recovery evidence and creates T-0121.
- `accb6a6`: adds content-bound golden approval records, eleven adversarial tests and Proposed process ADR-0047. The guard requires exact committed content, ancestor history and contemporaneous decision evidence. Existing protection for content already Approved on main remains. No Approved posting was edited by this implementation.
- The main integration also brings the accumulated branch history since the previous main, not merely these three commits. Read individual task cards for earlier work; integration does not promote their statuses to done.

## Exact outstanding work, in priority order

1. **Security workflow:** [run 43151980363](https://github.com/jperram92/Ledgerforce/actions/runs/43151980363) failed at `accb6a6`. Gitleaks reports `history: FAIL`; inspect redacted finding metadata to establish whether it is a real credential or test fixture. Never copy secret values into logs, weaken the scanner, or rewrite history. Image scans for api, worker and setup report critical `CVE-2026-4738`, `zlib@1.3.2-r1`, with scanner-reported fix `1.4-r0`. Research the supported remediation before changing image inputs; these scanner results are evidence, not independent confirmation of package availability. Security ADRs still require the owner. Do not edit CI security gates to obtain green.
2. **Local agent-suite environment:** repeated native Linux run passes 92/93. `scripts/agent/test/scripts.test.ts:99`, `verify.sh runs a package.json gate when its tooling exists`, fails because the nested command cannot find `/root/.cache/node/corepack/v1/pnpm/12.18.0/bin/pnpm.cjs`. Fix the package-manager environment and re-run unchanged tests; do not increase timeouts or relax assertions. Evidence: `.agent/evidence/T-0121/agent-suite-handoff.txt`.
3. **Correct validation checkout references:** the local Linux clone was cloned from the Windows repository, whose local main was stale (`d20af5c`). Its origin/main therefore did not represent GitHub main. Fetch the actual GitHub remote and verify refs before repeating the full verifier. Do not change gate comparison logic or manufacture a baseline. GitHub main before this integration was `e39a76c`; it contains the 72.22% line baseline. Observed coverage was 74.11%, but that manual comparison does not replace a correctly based verifier run.
4. **Full verification:** `bash scripts/agent/verify.sh --task T-0121`, with all output preserved under `.agent/evidence/T-0121/`. Use one Vitest worker and the supported isolated DB harness. The prior full run is **11 PASS / 3 FAIL / 2 PENDING**, not green. Accounting/golden failures were derivative of the agent-suite failure; the approval diff guard itself passed.
5. **Independent Claude review:** read `.claude/skills/cross-review/SKILL.md` and `.claude/agents/reviewer.md`. Review Codex's date validation, DB fixture correction, approval guard and tests. Record evidence using the required review format. ADR-0047 remains Proposed; accept only after the specified CI/review conditions are satisfied. Any code Claude changes requires subsequent independent Codex review.
6. **Finish and continue building:** only after all applicable gates pass, finish T-0121, reverify/review T-0048 and update its evidence/scenario register. Select the first dependency-ready `todo` from `.agent/backlog/README.md` using the conductor; do not assume the next numerical card is eligible. Retain earlier pending reviews and human phase/security gates.

## What actually passed

| Validation | Result and limitation |
| --- | --- |
| GitHub CI at accb6a6 | [Passed](https://github.com/jperram92/Ledgerforce/actions/runs/43151980406); separate security workflow failed. |
| New approval and existing verifier focused tests | 28/28 passed. |
| Native Linux unit coverage | 684 tests passed unchanged; full verifier measured 74.11% lines. |
| Full local verifier | Static checks, DB, tenant RLS, migrations, E2E, local security, no-shortcuts, no-delete and memory passed. Local security does not replace the failed GitHub scans. |
| T-0048 earlier recovery | 963 Vitest, 8 LWC, 82 then-existing agent tests and 1,178 standalone DB tests passed. These are historical results, not validation of the final merge. |

## Useful files and environment

- Research: `Docs/research/RQ-0098-*.md`, `Docs/research/RQ-0099-approval-records-and-coverage-runtime.md`.
- Design decision: `Docs/adr/0047-content-bound-golden-approval-records.md`; decision log DL-0277 through DL-0281.
- Approval implementation: `scripts/agent/lib/golden-approvals.ts`, `scripts/agent/lib/gates.ts`, `scripts/agent/test/golden-approvals.test.ts`, `Docs/decisions/golden-approvals.json`.
- Full output: `.agent/evidence/T-0121/full-verify-accb6a6.txt`. Other RED/GREEN and Windows failure evidence is alongside it.
- On this machine, native Linux clone: `/var/tmp/ledgerforce-t0121-verification-accb6a6`; Node: `/var/tmp/ledgerforce-node-22.22.0`; browsers: `/var/tmp/ledgerforce-playwright`. These are conveniences, not portable prerequisites. Check existence and refs before reuse.
- Windows system `bash` is WSL; Git Bash is `C:/Program Files/Git/bin/bash.exe`. Native Linux avoided Windows coverage timing/manifest-lock failures without modifying tests.

The owner's main-integration request is a one-time instruction. It does not waive future review, security, release or phase gates, authorize history rewrites, or declare any pending task complete.
