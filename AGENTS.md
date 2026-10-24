# AGENTS.md — LedgerForce canonical agent instructions

This file is the single source of truth for every AI agent working in this repository
(Claude Code, OpenAI Codex, or any other tool). `CLAUDE.md` imports this file and may only
*add* Claude-specific notes; it may never contradict it. If anything here conflicts with a
task card, this file wins. If anything here conflicts with an Accepted ADR, the ADR wins and
this file must be updated in the same branch.

LedgerForce is an open-source, double-entry accounting system (SMB ERP) for businesses that run
on Salesforce. The full solution design is versioned at
[`Docs/solution-design/solution-design.md`](Docs/solution-design/solution-design.md).
Read §3 (ledger), §6 (security) and §10 (agentic build system) before your first task.

---

## 0. Prime directives (from the product owner — non-negotiable)

1. **The repository is the only memory.** Never rely on chat history. Read state at start,
   write state before you stop. Any model must be able to resume any task from a git checkout.
2. **Test-driven, always.** Before you write production code for any module or task, the
   expected result exists as a failing test (and, for accounting, a golden posting). No test,
   no code. See [`Docs/process/tdd.md`](Docs/process/tdd.md).
3. **No shortcuts.** Never stub, mock away, skip, weaken or delete a test or a check to get
   green. Never mark a step done that you have not verified.
4. **Research before build.** If a requirement, API, regulation or library behaviour is unclear,
   open a research record (`Docs/research/RQ-NNNN-*.md`) and resolve it *before* writing code.
   You must be able to say *why* you are doing it and *how* it works, with sources.
5. **Solve technology blocks; don't stop at them.** If a capability isn't publicly available
   (no library, no docker, no API), build the module, harness or adapter yourself — inside the
   project scope — and record the decision. Only escalate to the human for things *outside*
   the scope of the solution design or for human gates (§6).
6. **Never delete anything.** No `rm` of tracked files, no `git rm`, no history rewrites, no
   dropping tables/columns in migrations, no deleting tasks, ADRs, research, runs or evidence.
   Replace by *superseding*: mark the old item `Superseded by …` and add the new one.
   (Untracked build output such as `node_modules/`, `dist/`, `coverage/` may be regenerated.)
7. **Log every decision.** Every decision — big (ADR) or small (decision-log entry) — goes into
   [`Docs/decisions/decision-log.md`](Docs/decisions/decision-log.md).
8. **Prove it with evidence.** Every task that changes behaviour leaves evidence: test output in
   the run log and, for anything with a UI or a report, Playwright screenshots in
   `.agent/evidence/<task-id>/`. See the `evidence` skill.
9. **Two providers, one process.** Claude is the primary builder; OpenAI Codex is the failover
   and the cross-reviewer (and vice versa). Both follow this file identically.

---

## 1. Repository map

| Path | What lives there | Owner |
|---|---|---|
| `AGENTS.md` / `CLAUDE.md` | Agent instructions (this file / Claude import) | human + agents (ADR to change §0) |
| `Docs/solution-design/` | The solution design, versioned | human |
| `Docs/adr/` | Architecture Decision Records (MADR) | agents propose, human accepts accounting/security |
| `Docs/decisions/decision-log.md` | Chronological log of *every* decision | agents append |
| `Docs/research/` | Research records RQ-NNNN, resolved before build | agents |
| `Docs/specs/` | Use-case specs UC-NN + success-scenario register | agents draft, human signs off |
| `Docs/accounting/postings.md` | **Golden postings — human-owned. Agents may not edit once Approved.** | human |
| `Docs/process/` | Loops, TDD protocol, definition of done | agents + human |
| `Docs/ui/` | UI principles, design tokens, mockups | agents + human |
| `.agent/config.yaml` | Provider order, budgets, leases, gates | human |
| `.agent/state.json` | Current task, branch, step, lease, last green commit | agents (via scripts) |
| `.agent/HANDOVER.md` | Resume note — rewritten at every checkpoint | agents |
| `.agent/backlog/` | Task cards `T-NNNN.md` + `README.md` index | agents |
| `.agent/runs/` | One log per agent session | agents |
| `.agent/evidence/` | Playwright screenshots + test reports per task | agents |
| `scripts/agent/` | Conductor (failover loop), resume, checkpoint, verify | agents |
| `.claude/agents/` | Sub-agent role definitions (also readable by Codex as plain markdown) | agents |
| `.claude/skills/` | Skills (`SKILL.md` per skill) — canonical, shared with Codex via `.agents/skills` | agents |
| `apps/`, `packages/`, `salesforce/`, `infra/` | Product code (see design §7.3) | agents |

> **Docs path note:** the design says `docs/`; this repo uses the pre-existing `Docs/`
> directory instead so that macOS/Windows checkouts (case-insensitive) never see two
> colliding folders. See decision DL-0003.

---

## 2. Session protocol (every session, every provider)

### Primary continuation prompt (Codex or Claude)

> Resume from the repository, not the chat. Read `AGENTS.md`, run the resume skill,
> then read `.agent/HANDOVER.md`, `.agent/state.json`, the active task card and the
> latest run log. Inspect `git status`, branch and the latest commit including its
> body. Explain what the last commit changed, why, what was actually tested and
> what remains unfinished. Follow the handover's next action with the research,
> TDD, evidence and cross-provider review gates intact. Never infer completion
> from a checkbox or a previous conversation. Before stopping, persist the exact
> next action and validation results in the repository.

Every commit must have a body explaining **What changed**, **Why**, **Validation**
(commands/results, including failures or checks not run), and **Next action**.
Explain the commit to the user after creating it. Put a current, copyable
**Codex continuation prompt** near the top of `.agent/HANDOVER.md`, naming the task,
branch, relevant commit and next command. This applies to WIP and documentation
commits as well as completed features; never label unverified work green.

```
START ─▶ resume ─▶ claim ─▶ research gate ─▶ TDD loop ─▶ verify ─▶ review ─▶ finish
            ▲                                    │ checkpoint every green step
            └──────────── handover ◀─────────────┘ (on any stop, incl. credit/quota errors)
```

1. **Resume.** Run `bash scripts/agent/resume.sh` and read its output (HANDOVER, state, active
   task card, open research, recent decisions). Skill: `resume`.
2. **Claim.** If no task is active, pick the first `todo` card in `.agent/backlog/README.md`
   whose `depends_on` are all `done`. Claim it with
   `node scripts/agent/conductor.ts claim T-NNNN --provider <claude|codex>` (writes lease to the
   card and `state.json`). One branch per task: `feat/T-NNNN-<slug>`.
3. **Research gate.** Read the card's *Open questions*. Any unresolved question → `research`
   skill → `Docs/research/RQ-NNNN-*.md` with sources and a conclusion. A task may not enter
   `in_progress` while any linked RQ is `open`.
4. **TDD loop** (skill `tdd-cycle`): for each acceptance criterion
   *write failing test → run it, confirm it fails for the right reason → implement minimum →
   green → refactor → checkpoint*.
5. **Checkpoint** (skill `checkpoint`) after every green step: commit
   `wip(T-NNNN): step k/n — <what>`, update the card's steps, `last_checkpoint`, lease and
   `.agent/HANDOVER.md`. A dead session must lose minutes, not hours.
6. **Verify** (`bash scripts/agent/verify.sh`): the definition of done in
   [`Docs/process/definition-of-done.md`](Docs/process/definition-of-done.md). All gates green.
7. **Evidence** (skill `evidence`): screenshots / reports into `.agent/evidence/T-NNNN/`, linked
   from the card and the success-scenario register.
8. **Cross-provider review** (skill `cross-review`): code built by one provider is reviewed by
   the other against the checklist in `.claude/agents/reviewer.md`.
9. **Finish.** Card `status: done`, success-scenario register updated, decision log updated,
   run log written (skill `run-log`), HANDOVER rewritten, lease released.

**Stopping for any reason** (end of budget, credit/quota error, blocked, context full):
run the `handover` skill *first*. If you cannot finish it, the conductor will stash your work
into a `wip/` commit and the next provider resumes from `last_checkpoint`.

---

## 3. Task status model

`todo → claimed → researching → in_progress → verifying → review → done`, plus `blocked`.
`blocked` requires a reason and, if it needs the human, an entry in
`.agent/HANDOVER.md` under *Open questions for human*. After 3 failed attempts across providers
a task is `blocked` automatically by the conductor.

---

## 4. Engineering rules

- **Stack** (design §7.1): TypeScript on Node.js 22 LTS, pnpm workspaces, NestJS, PostgreSQL 17
  (16 accepted locally — see DL log), Kysely + plain SQL migrations, pg-boss, decimal.js,
  CEL for rules, React + Vite + TanStack + shadcn/ui, Vitest, fast-check, Playwright.
- **Money:** `NUMERIC(19,4)` in DB, `decimal.js` in code. **Floating-point arithmetic on money is
  banned** (lint rule). Rates `NUMERIC(18,8)`.
- **Ledger writes only through the posting engine.** No module writes `journal_*`,
  `account_balance`, `subledger_entry` or `allocation` directly.
- **Posted = immutable.** Corrections by reversal only. Never add an UPDATE/DELETE path.
- **Tenant isolation:** every tenant-owned table has `tenant_id`, RLS `ENABLE` + `FORCE`, and is
  covered by the cross-tenant test suite. Migrations run as `lf_migrator`; the app runs as
  `lf_app` (no `BYPASSRLS`, no trigger-disable privilege).
- **Migrations are forward-only and additive.** Never drop or rename in place (directive 6):
  add new, backfill, mark old deprecated in a comment and an ADR.
- **Dependencies:** a new runtime dependency needs an ADR (design §10.6). Dev-only tooling needs
  a decision-log entry.
- **Commits:** Conventional Commits with the task id — `feat(ar): batch billing preview [T-0057]`;
  checkpoints `wip(T-0057): step 2/4 — <what>`. Never push to `main`.
- **Secrets:** never commit secrets; never read or edit `.env*`. Dev uses Salesforce scratch
  orgs and Stripe test mode only.

---

## 5. Guardrails (design §10.9 + product-owner directives)

- Never edit `.env` files, secrets, CI security gates, or **Approved** golden files in
  `Docs/accounting/`.
- Never disable, skip (`.skip`, `.todo`, `xit`), or weaken a test to make CI pass; mark the task
  `blocked` instead.
- Never delete files, tasks, ADRs, research, logs or evidence (directive 6).
- Never push to `main`; one branch per task; merge only with green CI and cross-review.
- Never write to ledger tables outside the posting engine.
- Add a runtime dependency only with an ADR.
- Update `HANDOVER.md`, the task card and the run log before ending any session — including
  when stopping for errors or credit limits.

---

## 6. Human gates — the only reasons to consult the product owner

Configured in `.agent/config.yaml → human_gates`:

1. ADRs in category **accounting** or **security** (status stays `Proposed` until accepted).
2. **Golden postings** (`Docs/accounting/postings.md`) — creation of new expectations or changes.
3. **Releases** and **phase gates** (design §9).
4. Anything **outside the scope** of the solution design, or a choice listed in design §11.2
   (open decisions) that has not yet been made.

Everything else — technical unknowns, missing libraries, environment problems — is yours to
research and solve. Record it, don't escalate it.

---

## 7. Skills and sub-agents

Skills live in `.claude/skills/<name>/SKILL.md` (Claude Code loads them natively; Codex reads
them via `.agents/skills` or by path). Each is plain markdown any model can follow.

| Skill | Use it when |
|---|---|
| `resume` | Starting any session |
| `claim-task` | Picking up the next task |
| `research` | Any unclear requirement / API / regulation |
| `tdd-cycle` | Implementing any acceptance criterion |
| `checkpoint` | After every green step |
| `verify` | Before moving to `verifying`/`review` |
| `evidence` | Capturing Playwright screenshots and reports |
| `write-adr` | Any decision that needs an ADR (design §10.6) |
| `log-decision` | Any decision at all (decision log) |
| `golden-posting` | Anything touching posting behaviour |
| `cross-review` | Reviewing the other provider's work |
| `handover` | Before stopping, for any reason |
| `run-log` | End of every session |
| `new-task-card` | Splitting or adding backlog work |
| `migration` | Writing a database migration |
| `ui-screen` | Building any UI screen |

Sub-agent roles live in `.claude/agents/*.md` (architect, researcher, ledger-engineer,
test-author, db-engineer, salesforce-engineer, ui-engineer, qa-evidence, security-reviewer,
reviewer, scribe). Codex: when a task says "act as <role>", read that file and follow it.

The loops that drive the whole process (session, TDD, research, failover, review, evidence,
decision, backlog-sync) are documented in [`Docs/process/loops.md`](Docs/process/loops.md).
