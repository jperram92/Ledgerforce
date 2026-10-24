---
id: RQ-0014
title: Terminating expired provider process trees on Windows
status: resolved
opened: 2026-10-24
resolved: 2026-10-24
opened_by: codex
linked_tasks: [T-0010, T-0003]
linked_adrs: [ADR-0011]
---

# Question

How can the conductor stop a hung provider and its children on Windows before
failing over, preserving the existing heartbeat deadline?

## Evidence and sources

- Existing `scripts/agent/test/run.test.ts` heartbeat test failed on Windows:
  `runCli` returned null after its 25-second timeout, rather than exit 0.
  The production fallback terminates the shell alone when POSIX group signals fail.
- [Microsoft taskkill reference](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill),
  accessed 2026-10-24: `/PID` selects a process, `/T` includes its child processes,
  and `/F` forces termination.

## Conclusion

Use `taskkill.exe /PID <spawned provider PID> /T /F` on Windows; retain POSIX group
signals elsewhere. Use a hidden child and argument array, never a composed shell
command. Limit execution time and refuse any delayed kill after the child's close
event. Do not use image-name or wildcard matching. The existing real-process
heartbeat test must pass unchanged, including its prompt-termination assertion.

Confidence: high for documented command semantics; actual end-to-end result is
recorded in the run log. No security policy or runtime dependency changes.

## Validation limitation

The initial implementation is **not sufficient to pass the heartbeat regression**.
Even outside the sandbox and with Git's usr/bin first in PATH, the test times out
after 25 seconds. Diagnostics report the original PID is not found while a
descendant still holds the pipes. Taskkill's documented semantics are resolved;
reliable tracking of Git Bash descendants remains implementation work. Do not
interpret this research status as a passing acceptance test. Reproduce with the
unchanged `missed heartbeat` test before changing process ownership/termination.
