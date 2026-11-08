---
id: RQ-0001
title: OpenAI Codex CLI non-interactive mode (codex exec), AGENTS.md discovery, skills, errors
status: resolved
opened: 2026-10-24
resolved: 2026-10-24
opened_by: claude
linked_tasks: []
linked_adrs: []
---

# RQ-0001 — Codex CLI non-interactive mode

## Question

Q1. Exact `codex exec` usage for an unattended conductor: working dir, sandbox / approval mode
(full-auto, workspace-write), model selection, JSON / structured output, exit codes.
Q2. How Codex reads `AGENTS.md` (global, nested, override files, size limits).
Q3. What error text appears on quota / rate-limit / insufficient credit.
Q4. Does Codex support `SKILL.md` skills, and from which repository directory?

## Why it matters

`scripts/agent/conductor.ts` launches Codex as failover builder and cross-reviewer
(design §10.4, `.agent/config.yaml`). Wrong flags mean a run that silently cannot edit, cannot
commit, or is never detected as quota-failed.

## Sources consulted

The official docs host `developers.openai.com` was **not reachable** from this sandbox (proxy
403); the repo's own `docs/*.md` only link there. Facts were therefore taken from the CLI binary
and its source code, which are more authoritative than prose docs for exact flags.

| # | Source | Accessed | Kind | What it says |
|---|---|---|---|---|
| S1 | `npm install @openai/codex@0.164.0` (published 2026-10-23) then `codex exec --help`, `codex --help` | 2026-10-24 | experiment | Full flag list reproduced below. `codex exec --full-auto` → `error: unexpected argument '--full-auto' found`. |
| S2 | https://github.com/openai/codex (shallow clone, commit 970111f6, 2026-10-23) `codex-rs/core/src/agents_md.rs` | 2026-10-24 | source code | AGENTS.md discovery algorithm, `AGENTS.override.md`, fallback filenames, byte budget. |
| S3 | same repo, `codex-rs/core/src/config/mod.rs` | 2026-10-24 | source code | `AGENTS_MD_MAX_BYTES = DEFAULT_PROJECT_DOC_MAX_BYTES; // 32 KiB` |
| S4 | same repo, `codex-rs/ext/skills/src/host_roots.rs`, `codex-rs/skills/src/interface.rs` | 2026-10-24 | source code | Skill roots: `.agents/skills` in every dir from project root to cwd; project config folder `skills`; `$HOME/.agents/skills`; deprecated `$CODEX_HOME/skills`. Name ≤ 64 chars, description ≤ 1024. |
| S5 | same repo, `codex-rs/exec/src/lib.rs` | 2026-10-24 | source code | Headless default `approval_policy: Some(AskForApproval::Never)`; `std::process::exit(1)` on any error; "Not inside a trusted directory and --skip-git-repo-check was not specified." |
| S6 | same repo, `codex-rs/protocol/src/error.rs`, `codex-rs/codex-api/src/api_bridge.rs` | 2026-10-24 | source code | Error strings for usage limit / quota / overload (quoted below). |
| S7 | same repo, `codex-rs/protocol/src/permissions.rs` | 2026-10-24 | source code | `PROTECTED_METADATA_PATH_NAMES = [".git", ".agents", ".codex", ".aws"]` — "Top-level workspace metadata paths that stay protected under writable roots." |
| S8 | same repo, `codex-rs/config/src/types.rs`, `config_toml.rs` | 2026-10-24 | source code | `sandbox_workspace_write.network_access` (default false → network restricted); default sandbox resolves to `ReadOnly` unless configured or the project has a trust decision. |
| S9 | same repo, `codex-rs/exec/src/exec_events.rs` | 2026-10-24 | source code | JSONL event types `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.started`, `item.updated`, `item.completed`, `error`. |
| S10 | WebSearch "codex exec non-interactive flags …" (mintlify mirror of Codex docs) | 2026-10-24 | secondary | Claims distinct exit codes 1–4,130 and that `--full-auto` exists — **contradicted by S1/S5**. |

## Findings

1. **Invocation (S1).** `codex exec [OPTIONS] [PROMPT]`; prompt may come from stdin (`-` or
   omitted). Relevant flags (v0.164.0):
   - `-C, --cd <DIR>` working root; `--add-dir <DIR>` extra writable dirs.
   - `-s, --sandbox read-only|workspace-write|danger-full-access`.
   - `--dangerously-bypass-approvals-and-sandbox` (no sandbox, no approvals; "intended solely for
     environments that are externally sandboxed"; also skips the git-repo check).
   - `--approve-for-me` routes approvals through automatic review in workspace-write.
   - `-m, --model <MODEL>`; `-p, --profile`; `-c key=value` TOML overrides.
   - `--json` (JSONL events on stdout); `--output-schema <FILE>` (JSON Schema for the final
     message); `-o, --output-last-message <FILE>`.
   - `--skip-git-repo-check`, `--ephemeral`, `--ignore-user-config`, `--color never`.
   - Sub-commands `exec resume [--last|<id>]`, `exec fork`, `exec review`.
2. **`--full-auto` no longer exists** in 0.164.0 (S1). Third-party pages that still document it
   are stale (S10). Approval policy in `exec` is hard-wired to *never ask* (S5), so "full auto"
   is now just `-s workspace-write`.
3. **Default sandbox is read-only** unless `sandbox_mode` is configured or the project has a
   trust decision (S8). The conductor must pass `-s workspace-write` explicitly.
4. **workspace-write cannot write `.git`, `.agents`, `.codex` (S7)** and has **no network** unless
   `-c sandbox_workspace_write.network_access=true` (S8). Consequence: a Codex run in
   workspace-write **cannot `git commit`** (checkpoint skill) and cannot `pnpm install`.
5. **Exit codes (S5):** `0` success, `1` for every failure (config, auth, turn failure, error
   event). There are no distinct codes for quota vs other errors — classification must come from
   output text / JSONL `turn.failed` / `error` events.
6. **Quota / rate-limit text (S6)** — note the curly apostrophe `’`:
   - `You’ve hit your usage limit. …` (several variants, may end `… or try again at <time>.`)
   - `Quota exceeded. Check your plan and billing details.` (API `insufficient_quota`; raw API
     message: `You exceeded your current quota, please check your plan and billing details.`)
   - `Selected model is at capacity. Please try a different model.` (overload)
   - `We’re currently experiencing high demand, which may cause temporary errors.`
   - `exceeded retry limit, last status: 429 …`
   - `To use Codex with your ChatGPT plan, upgrade to Plus: …`
7. **AGENTS.md discovery (S2, S3).** Project root = nearest ancestor with a marker (default
   `.git`). For each directory from root down to cwd (inclusive), Codex takes the first existing
   of `AGENTS.override.md`, `AGENTS.md`, then any `project_doc_fallback_filenames`, and
   concatenates them root→cwd. User-level `~/.codex/AGENTS.md` (or override) is prepended.
   Total budget 32 KiB (`project_doc_max_bytes`); excess is **truncated with only a log warning**.
   Projects explicitly marked *untrusted* load no project docs. Nested AGENTS.md below cwd are
   **not** loaded at start (only root→cwd).
8. **Skills (S4).** Codex supports `SKILL.md` skills. Repo-scoped roots: `.agents/skills/` in
   every directory from project root to cwd, plus `<repo>/.codex/skills/` (project config layer).
   User: `~/.agents/skills/`, legacy `$CODEX_HOME/skills/`. Symlinked skill directories are
   followed. **Codex does not read `.claude/skills/`.**
9. Current repo state: `AGENTS.md` is 12,241 bytes (< 32 KiB) — fine today, but growth past
   32 KiB would silently truncate Codex's copy of the rules.

## Conclusion / decision

Conductor command for Codex (build role):

```bash
codex exec --cd "$REPO" --sandbox workspace-write \
  -c sandbox_workspace_write.network_access=true \
  --json -o .agent/runs/<run>-last.md --color never - < prompt.md
```

- Because workspace-write protects `.git`, **the conductor (not Codex) performs checkpoint
  commits** after each Codex step, *or* Codex runs with
  `--dangerously-bypass-approvals-and-sandbox` only inside an externally sandboxed
  container. Pick one in the conductor ADR; default: conductor commits.
- Do not pass `--full-auto`. Do not pass `-m` (DL-0006: no pinned models).
- Classify failure from **stdout JSONL + stderr**, case-insensitively; exit code alone is `1`.
  Add patterns: `hit your usage limit`, `quota exceeded`, `exceeded your current quota`,
  `at capacity`, `high demand`, `exceeded retry limit`.
- Expose skills to Codex with a committed symlink `.agents/skills -> ../.claude/skills`
  (canonical stays `.claude/skills`, per AGENTS.md §7).
- Add a CI check that `AGENTS.md` stays under 32 KiB.

## Confidence

High for flags, defaults, discovery and error strings (binary + source of the version published
the day before). Medium for future stability: Codex releases weekly — re-run `codex exec --help`
in the conductor's self-test.

## Follow-ups

- Conductor self-test: assert `codex exec --help` contains `--sandbox` and `--json`; fail loudly
  if a flag disappears.
- Create `.agents/skills` symlink (owner of `.claude/skills` / scaffold task).
- Propose `.agent/config.yaml` pattern update to the human (file is human-owned).

**Affects:** conductor (`scripts/agent/conductor.ts`), `.agent/config.yaml failure_patterns`,
checkpoint/handover skills, `.agents/skills` layout, design §10.2, §10.4.
