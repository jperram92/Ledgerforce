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

## T-0103 follow-up (2026-10-28): containment before provider launch
- Unchanged RED test reproduced: 25-second timeout, original taskkill PID absent. A standalone fake-hang spike with absolute Git usr/bin Bash: taskkill exited 0 and Bash emitted exit, but close remained pending until sleep finished. Native parent/child enumeration did not list sleep beneath the spawned Bash PID. PID-tree cleanup is insufficient for this MSYS process topology.
- Primary source: https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects (retrieved 2026-10-28). Job membership is inherited by children; JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE terminates all associated processes when the last handle closes. Windows 8+ supports nested jobs. No breakaway flags will be enabled.
- Implementation conclusion: start a hidden PowerShell job host, assign the host itself to a fresh non-inheritable kill-on-close job before launching the provider, and retain the job handle for its entire lifetime. Child processes therefore join before they can fork. Host exit/termination closes the handle and kills even reparented descendants. Fail closed if job creation/configuration/assignment fails. Keep POSIX process-group behavior unchanged.
- Provider arguments/stdin travel in a JSON launch record, not interpolated shell code; a small Node runner uses spawn's argument array. Existing acceptance test remains unchanged. The host is process containment, not a security sandbox or policy change. No added runtime package.
- Confidence: high in documented Windows semantics; end-to-end acceptance remains to be measured. This supersedes the earlier conclusion that taskkill /T alone suffices.
## Related state-write failure reproduced during full conductor validation
- Unchanged concurrent-reader test fails EPERM at renameSync while replacing an existing state file. Windows sharing rules can temporarily deny replacement of an open file: https://learn.microsoft.com/en-us/windows/win32/fileio/moving-and-replacing-files (retrieved 2026-10-28).
- Preserve sibling-temp + atomic rename; retry only Windows EPERM/EACCES/EBUSY briefly, then propagate the original error. Never unlink the destination or fall back to truncating it. Bound retries by count, not wall clock. Leave POSIX and non-sharing errors unchanged. Existing >100 reads/writes and zero-partial-read assertions remain intact.