---
id: RQ-0002
title: Claude Code headless mode (claude -p), errors, CLAUDE.md imports, AGENTS.md, skills and subagents
status: resolved
opened: 2026-10-24
resolved: 2026-10-24
opened_by: claude
linked_tasks: []
linked_adrs: []
---

# RQ-0002 — Claude Code headless mode

## Question

Q1. `claude -p` flags relevant to an unattended conductor (`--output-format`, `--permission-mode`
/ `--dangerously-skip-permissions`, `--max-turns`, `--append-system-prompt`, `--resume`).
Q2. Exit codes and error text on usage limit / credit / rate limit.
Q3. How CLAUDE.md `@imports` work.
Q4. Does Claude Code read AGENTS.md? (design §10.2 claims a fallback since 2.1.277.)
Q5. Where project skills and subagents live and their frontmatter fields.

## Why it matters

Claude is the primary builder launched by the conductor (design §10.4). `CLAUDE.md` is a
one-line `@AGENTS.md` import (DL-0002). Skills/agents are the shared process library.

## Sources consulted

| # | Source | Accessed | Kind | What it says |
|---|---|---|---|---|
| S1 | `claude --help` (installed Claude Code 2.1.310) | 2026-10-24 | experiment | Flag list; `-p` skips the workspace-trust dialog; `--max-turns` not shown in `--help` but documented (S2). |
| S2 | https://code.claude.com/docs/en/cli-reference.md | 2026-10-24 | primary | `--max-turns`: "Limit the number of agentic turns (print mode only). Exits with an error when the limit is reached." `--dangerously-skip-permissions` ≡ `--permission-mode bypassPermissions`. `--resume` by id, name or transcript path. |
| S3 | https://code.claude.com/docs/en/headless.md | 2026-10-24 | primary | "exits with code 0 on success and a non-zero code when the run fails … When a failure happens inside the run … Claude Code prints the failure as the result on stdout." "With Claude Code v2.1.302 or later, `claude -p` runs start in Manual mode when nothing sets a permission mode" (calls needing approval are denied). `system/api_retry` events with `error` categories incl. `billing_error`, `rate_limit`, `overloaded`. |
| S4 | https://code.claude.com/docs/en/errors.md | 2026-10-24 | primary | Exact usage-limit messages (quoted below); `CLAUDE_CODE_RETRY_WATCHDOG`. |
| S5 | https://code.claude.com/docs/en/agent-sdk/typescript.md | 2026-10-24 | primary | Result message `subtype`: `success`, `error_max_turns`, `error_during_execution`, `error_max_budget_usd`; `is_error: boolean`. |
| S6 | https://code.claude.com/docs/en/memory.md | 2026-10-24 | primary | `@path` imports; AGENTS.md section ("Reading `AGENTS.md` directly requires Claude Code v2.1.277 or later"). |
| S7 | https://code.claude.com/docs/en/skills.md | 2026-10-24 | primary | Skill locations and SKILL.md frontmatter table. |
| S8 | https://code.claude.com/docs/en/sub-agents.md | 2026-10-24 | primary | Subagent locations and frontmatter table. |
| S9 | https://code.claude.com/docs/en/permission-modes.md | 2026-10-24 | primary | `-p` + `--permission-mode auto` supported; which mode a non-interactive run starts in. |

## Findings

1. **Headless flags (S1, S2).** `claude -p "<prompt>"` (or prompt on stdin, ≤10 MB) with:
   `--output-format text|json|stream-json` (stream-json needs `--verbose`);
   `--permission-mode default|manual|acceptEdits|auto|dontAsk|bypassPermissions|plan`;
   `--dangerously-skip-permissions`; `--allowedTools/--disallowedTools`; `--max-turns N`;
   `--max-budget-usd X`; `--append-system-prompt[-file]`; `--resume <id|name>`, `--continue`,
   `--session-id <uuid>`, `--fork-session`; `--json-schema`; `--add-dir`; `--setting-sources`;
   `--no-session-persistence`. **Do not use `--bare`**: it skips CLAUDE.md auto-discovery.
2. **Default permission mode changed:** since v2.1.302, `-p` starts in Manual mode and denies
   anything that would prompt (S3). An unattended run **must** set a mode, otherwise edits /
   Bash calls are silently denied and the run "succeeds" having done nothing.
3. **Exit codes (S3, S5):** `0` success, non-zero on failure (no per-cause codes). With
   `--output-format json` the final object has `is_error` and `subtype`
   (`error_max_turns`, `error_during_execution`, `error_max_budget_usd`). Failures inside the run
   are printed **on stdout as the result**, not only stderr.
4. **Limit / credit messages (S4)** (straight apostrophe):
   `You've hit your session limit · resets 3:45pm`, `You've hit your weekly limit · resets …`,
   `You've hit your Opus limit …`/`Sonnet limit`, `Credit balance is too low`,
   `API Error: Request rejected (429) · …`, `Server is temporarily limiting requests (not your usage limit)`,
   `API Error: Repeated 529 Overloaded errors. …`, `You've hit your monthly spend limit` /
   `individual spend limit` / `org's monthly spend limit` / `individual usage limit`,
   `spend limit reached`. Stream-json emits `system/api_retry` with `error: rate_limit |
   billing_error | overloaded | …` before retries.
   **The current `.agent/config.yaml` patterns do not match "session limit", "weekly limit",
   "spend limit" or "Opus/Sonnet limit".**
5. **`@imports` (S6):** `@path/to/file` anywhere in CLAUDE.md (outside code spans/fences);
   relative to the importing file; recursive, **max depth four hops**; imports outside the working
   directory need a one-time approval (interactive) — keep imports inside the repo.
6. **AGENTS.md (S6) — design claim confirmed.** Official docs: Claude Code reads `AGENTS.md`
   directly from v2.1.277, by default **only when no `CLAUDE.md`, `.claude/CLAUDE.md` or
   `CLAUDE.local.md` exists in cwd or above**; a `CLAUDE.md` that imports `AGENTS.md` is the
   documented way to share one file. A `CLAUDE.local.md` would *also* suppress AGENTS.md
   reading. Our `CLAUDE.md` = `@AGENTS.md` + additions is the correct pattern.
7. **Skills (S7):** project `.claude/skills/<name>/SKILL.md` (also nested
   `<subdir>/.claude/skills/`); personal `~/.claude/skills/`. Frontmatter: `name`, `description`
   (recommended; listing truncates description+`when_to_use` at 1,536 chars),
   `argument-hint`, `arguments`, `disable-model-invocation`, `user-invocable`, `allowed-tools`,
   `disallowed-tools`, `model`, `effort`, `context: fork`, `agent`, `background`, `hooks`,
   `paths`, `shell`, `metadata`, `license`, `compatibility`. Symlinked skill folders are
   followed. Claude Code does **not** document `.agents/skills`.
8. **Subagents (S8):** `.claude/agents/<name>.md` (project) or `~/.claude/agents/`.
   Frontmatter: `name` (required), `description` (required), `tools`, `disallowedTools`,
   `model`, `permissionMode`, `maxTurns`, `autoCompactWindow`, `skills`, `mcpServers`, `hooks`,
   `memory`, `background`, `omitClaudeMd`, `effort`, `isolation: worktree`, `color`,
   `initialPrompt`, `experimental`.

## Conclusion / decision

Conductor command for Claude (build role):

```bash
claude -p --output-format stream-json --verbose \
  --permission-mode acceptEdits \
  --allowedTools "Bash(pnpm *) Bash(node *) Bash(git add *) Bash(git commit *) Bash(bash scripts/agent/*) Read Edit Write Glob Grep" \
  --max-turns 200 --max-budget-usd <from config budgets> \
  --append-system-prompt-file .agent/runs/<run>-context.md  < prompt.md
```

(Use `--permission-mode bypassPermissions` only inside an isolated container; it is the
equivalent of Codex's bypass flag.)
- Parse the final `result` event (`is_error`, `subtype`) and scan **stdout and stderr**,
  case-insensitively, for: `hit your (session|weekly|opus|sonnet|.*spend|.*usage) limit`,
  `credit balance is too low`, `rate.?limit`, `429`, `529`, `overloaded`,
  `temporarily limiting requests`, `spend limit`.
- Keep `CLAUDE.md` as `@AGENTS.md` (+ additive notes). Never add a `CLAUDE.local.md` that
  assumes AGENTS.md fallback.
- Skills canonical in `.claude/skills/`, agents in `.claude/agents/` using the field names
  above; mirror skills to Codex via `.agents/skills` symlink (RQ-0001).

## Confidence

High — official docs fetched today and the installed CLI (2.1.310). Version-sensitive behaviour
(Manual default since 2.1.302) is called out; conductor should log `claude --version`.

## Follow-ups

- Propose `failure_patterns` additions to the human (config is human-owned).
- Conductor self-test: `claude -p --output-format json "reply OK"` must return `is_error:false`.

**Affects:** conductor, `.agent/config.yaml`, `CLAUDE.md`, `.claude/skills/*`, `.claude/agents/*`,
design §10.2, §10.4.
