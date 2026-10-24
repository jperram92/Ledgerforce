# .agents/

This directory exists so that **OpenAI Codex** (and other tools that follow the shared
Agent Skills layout) discovers the same skills Claude Code uses.

- `.agents/skills` is a **relative symlink** to `../.claude/skills`. Codex scans `.agents/skills`
  in every directory from the working directory up to the repository root and follows
  symlinked skill folders, so every `.claude/skills/<name>/SKILL.md` is visible to Codex
  without a copy.
- The canonical files live in [`.claude/skills/`](../.claude/skills/). Edit them there, never
  through a copy — there is exactly one version of each skill.
- Sub-agent roles are in [`.claude/agents/`](../.claude/agents/); Codex reads them as plain
  markdown when told to "act as <role>" (`AGENTS.md` §7).

## If the symlink does not work

- **Windows checkouts** without symlink support (`git config core.symlinks false`) get a text
  file containing `../.claude/skills` instead of a link. Enable symlinks
  (Developer Mode + `git config core.symlinks true`, then re-checkout), or create a directory
  junction locally: `mklink /J .agents\skills ..\.claude\skills` (do not commit it).
- **Skills not listed in Codex:** check that `.agents/skills/<name>/SKILL.md` resolves
  (`ls .agents/skills/resume/SKILL.md`), restart Codex, and start a new session. As a fallback any
  agent can read a skill by path: `.claude/skills/<name>/SKILL.md`.

Never replace the symlink with copied files (two copies drift) and never delete it.
