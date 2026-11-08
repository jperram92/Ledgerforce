@AGENTS.md

## Claude Code additions (may add to AGENTS.md, never contradict it)

- Skills in `.claude/skills/` and sub-agents in `.claude/agents/` load natively; prefer invoking a
  skill over re-deriving its steps.
- When you hit a usage, rate-limit or credit error, or are about to run out of context, run the
  `handover` skill immediately — the conductor will start OpenAI Codex on the same branch.
- Headless runs are launched by `scripts/agent/conductor.ts` with `claude -p`; in that mode never
  wait for interactive input — if you need the human, record it in `.agent/HANDOVER.md` under
  *Open questions for human* and mark the task `blocked`.
