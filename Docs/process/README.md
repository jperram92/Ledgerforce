# Process documentation

How LedgerForce is built by agents (claude and codex) with a human product owner. Canonical
rules live in [`AGENTS.md`](../../AGENTS.md); these documents expand them and must never
contradict them.

| Document | What it defines |
|---|---|
| [`loops.md`](loops.md) | The 12 loops that drive the build — session, task lifecycle, research, TDD, checkpoint/heartbeat, provider failover, cross-review, evidence, decision, success-scenario sync, human-gate escalation, periodic health — each with trigger, steps, exit, failure path and diagram |
| [`tdd.md`](tdd.md) | Test-first protocol, the test pyramid, where tests live and how they are named, accounting tests, what an appropriate expected result is per module type |
| [`definition-of-done.md`](definition-of-done.md) | Every gate (design §10.8 + directives) mapped to its `verify.sh` command and required evidence |
| [`human-gates.md`](human-gates.md) | Exactly when and how to consult the product owner, and what agents must solve themselves |

## Related

- Skills (step-by-step procedures): [`.claude/skills/`](../../.claude/skills/) — Codex reads the
  same files through [`.agents/skills`](../../.agents/README.md).
- Roles (sub-agents): [`.claude/agents/`](../../.claude/agents/).
- Commands: `bash scripts/agent/resume.sh`, `node scripts/agent/conductor.ts <claim|checkpoint|release|handover|run|status>`,
  `bash scripts/agent/verify.sh [--quick]`, `pnpm test`, `pnpm test:db`, `pnpm test:e2e`,
  `pnpm lint`, `pnpm typecheck`.
- Design: [`Docs/solution-design/solution-design.md`](../solution-design/solution-design.md) §10.

## Changing these documents

Process changes are decisions: log them (`log-decision`, category `process`). Changes to
`AGENTS.md` §0 need an ADR. Never delete a section — mark it superseded and link the replacement.
