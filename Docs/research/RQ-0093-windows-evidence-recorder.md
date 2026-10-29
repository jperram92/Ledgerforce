---
id: RQ-0093
title: Launch installed Vitest portably without a shell
status: resolved
opened: 2026-10-29
resolved: 2026-10-29
opened_by: codex
linked_tasks: [T-0114]
linked_adrs: []
superseded_by:
---

# RQ-0093 — Portable evidence recorder

## Question / why it matters
record-tests.ts invokes spawnSync('pnpm') without a shell. Windows package-manager commands are commonly cmd shims; an unsuccessful launch leaves no JSON report, then readFileSync throws an unrelated ENOENT. Evidence must preserve actual failure outcomes and arguments.

## Sources consulted
- https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows — primary Node documentation opened 2026-10-29: cmd/bat files require a command interpreter; exec/spawn shell execution changes argument interpretation.
- https://vitest.dev/guide/cli — primary Vitest documentation opened 2026-10-29: run performs one test run; CLI accepts filters/projects/reporters.
- Local installed vitest/package.json and vitest.mjs: version pinned by existing lockfile, bin entry points at vitest.mjs. Confirm export resolution in the implementation tests.

## Conclusion
Resolve the existing installed Vitest package and launch its JS CLI using process.execPath and a literal argv array on every OS. No shell, no new package, no modified lockfile. Validate real reports in end-to-end recorder tests rather than mocking spawn. Detect launch/no-report failures before reading JSON, report clearly, and never append fabricated pass evidence.

## Confidence / follow-ups
High for platform behavior; prove actual installed CLI integration with RED/GREEN tests, including spaces/metacharacters, passing/failing scenarios and a runner failure. T-0114 only; security gates untouched.
