# Definition of done

A task is `done` only when **every gate below is green** on the head commit of its branch
`feat/T-NNNN-<slug>`, the evidence exists, and a cross-provider review has passed. Gates 1–8 are
design §10.8; gates 9–12 add the product owner's directives (`AGENTS.md` §0).

- Run all gates: `bash scripts/agent/verify.sh` (exit 0 = all green).
- Inner TDD loop only: `bash scripts/agent/verify.sh --quick` (gates 1 and 2a/3/4 unit-level;
  never sufficient for `verifying`/`review`/`done`).
- Skill: [`verify`](../../.claude/skills/verify/SKILL.md). Reviewer checklist:
  [`.claude/agents/reviewer.md`](../../.claude/agents/reviewer.md).

| # | Gate (design §10.8 expanded) | Command (what `verify.sh` runs) | In `--quick` | Evidence required |
|---|---|---|---|---|
| 1 | **Static:** typecheck; lint incl. the *no-float-money* and *no-direct-ledger-write* rules; format check | `pnpm typecheck`, `pnpm lint` | yes | exit codes in run log |
| 2a | **Unit, property, golden and contract tests** pass | `pnpm test` | yes | summary line (passed/failed counts) in run log |
| 2b | **DB integration tests** pass (real PostgreSQL 16/17, DL-0007) | `pnpm test:db` | no | summary in run log |
| 2c | **Coverage does not drop** versus `main` | coverage report produced by `pnpm test`, compared by `verify.sh` with the `main` baseline | no | coverage delta in run log |
| 3 | **Accounting invariants** (fast-check over random documents): every posted entry balances; trial balance nets to zero; AR subledger = AR control; AP subledger = AP control; reversing any entry restores prior balances | part of `pnpm test` (`*.prop.test.ts`) and `pnpm test:db` (trigger-level) | unit part | property names + run count in run log |
| 4 | **Golden postings:** each standard event (design §3.8) produces exactly the Approved journal in `Docs/accounting/postings.md`; golden file unchanged without human approval | part of `pnpm test` (`*.golden.test.ts`); `verify.sh` flags any diff in `Docs/accounting/` versus `main` (allowed only as a `Draft` proposal with PR label `golden_postings`) | unit part | GP ids exercised; diff check result |
| 5 | **Cross-tenant RLS suite** covers every tenant-owned table and passes | part of `pnpm test:db` | no | table count covered = tenant-owned table count |
| 6 | **Migrations apply forward** on a copy of the previous release's schema; additive only | part of `pnpm test:db`; `verify.sh` greps new `*.sql` for `DROP`/`RENAME`/`TRUNCATE`/`DISABLE TRIGGER` | no | migration list + grep result |
| 7 | **Security scans** clean: secrets, dependencies, SAST | secret scan of the diff, `pnpm audit --prod`, SAST (full suite in CI; `verify.sh` runs what is installed locally and says which were skipped) | no | scanner names + results |
| 8 | **Cross-provider review** approved | review report `.agent/evidence/<T-ID>/review-<provider>-<YYYYMMDD-HHMMSS>.md` with verdict PASS by a provider ≠ card `claimed_by` | no | report file path |
| 9 | **E2E + evidence:** every success scenario of the card passes and has screenshots | `pnpm test:e2e`; manifest check of `.agent/evidence/<T-ID>/manifest.json` | no | manifest entries with `result: "passed"` |
| 10 | **No shortcuts:** no new `.skip`/`.only`/`.todo`/`xit`/`xdescribe`, no lowered `numRuns`, no unlogged suppressions | `verify.sh` greps the diff versus `main` | yes | grep result |
| 11 | **Nothing deleted:** no deleted tracked files; no deleted tasks/ADRs/RQs/runs/evidence | `git diff --diff-filter=D --name-only main...HEAD` is empty | yes | command output |
| 12 | **Memory up to date:** card steps all ticked and `status` correct; decisions in `Docs/decisions/decision-log.md`; linked RQs not `open`; success-scenario register updated; run log and `.agent/HANDOVER.md` written | `verify.sh` checks card frontmatter and RQ statuses; the rest is reviewer items C9–C12 | no | review report |

## Order of finishing a task

1. All acceptance criteria green (TDD loop) → card `status: verifying`.
2. `bash scripts/agent/verify.sh` green (gates 1–7, 9–12 except the review itself).
3. Evidence captured (`evidence` skill) → card `status: review`.
4. Other provider runs `cross-review` → PASS (gate 8).
5. Register, decision log, run log, HANDOVER updated →
   `node scripts/agent/conductor.ts release T-NNNN --status done`.

## Human-gated conditions

A task whose result depends on a `Proposed` accounting/security ADR or a `Draft` golden posting
cannot be `done`, even with every gate green; it is `blocked` until the product owner decides
(see [`human-gates.md`](human-gates.md)).
