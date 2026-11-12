---
id: RQ-0099
title: Content-bound approval records and consistent coverage runtime
status: resolved
opened: 2026-11-12
resolved: 2026-11-12
opened_by: codex
linked_tasks: [T-0121]
linked_adrs: [ADR-0047]
superseded_by:
---

# RQ-0099 — Content-bound approval records and consistent coverage runtime

## Questions and evidence

| Source inspected | Date | Finding |
|---|---|---|
| `scripts/agent/lib/gates.ts`, `git.ts` | 2026-11-12 | Golden guard scans all changes since main and has no representation of an approved change. Git wrapper exposes success/failure of ancestor and object lookups. |
| DL-0256 at commit `65561c1523563cfd8e91097a58c4916fdeeb0205` | 2026-11-12 | Owner approval of the researched golden postings is recorded. |
| DL-0258 at commit `334a3f90997af48e8331247d0e4d8fdba91ce89d` | 2026-11-12 | A later additive GP-036 supersession is explicitly recorded under DL-0256. Current posting file has no changes since that commit. |
| AGENTS.md section 6; ADR-0012; DL-0263 | 2026-11-12 | Approval remains an independently reviewable decision; accounting delegation does not permit editing approved expectations. |
| Prior coverage failures and unchanged focused reproduction | 2026-11-12 | Prior 5s timeouts reproduced twice, but focused coverage now passes all three tests in 2.05s. No deterministic assertion failure established. |
| Full coverage reproduction; `infra/test/install-contract.test.ts:309-336` | 2026-11-12 | Lint test passed, but installer test timed out after a synchronous WSL call (12.885s). The test explicitly invokes `wsl.exe --exec bash -s` on Windows regardless of PATH. Cold WSL startup is a possible cause, not yet proved. |

## Conclusion

Use an explicit reviewable approval-record file outside `Docs/accounting/`, separate from golden content. Each record names the protected path, full ancestor commit containing its exact approved content, and nonempty decision-log references present at that commit. Missing commits, non-ancestors, missing decisions, duplicate paths, malformed records and any content change fail closed. Normalize CRLF only; do not trim whitespace. The existing guard still applies to files without a valid record. Recorded approvals are review inputs, not a cryptographic claim that arbitrary commit authors are the product owner; their authority must be independently reviewed against the cited decisions.

Seed only the existing researched approval/supersession at `334a3f9`, referencing DL-0256 and DL-0258. Require at least one referenced decision to be newly introduced in that commit; a later content-changing commit cannot recycle old decision IDs. Retain the original rejection of modifications to content already Approved at the comparison base. Do not introduce approval for any new accounting expectation. This changes representation of previously authorized decisions, not the requirement for authorization. ADR-0047 remains Proposed until independent review and CI.

Coverage must run with Node 22, working WSL (the install test needs native Linux permissions), Git Bash for the verifier, and one Vitest worker as in the successful verifier runtime. Keep all test assertions and timeouts unchanged. The exact cause of prior timing variability is not proven; report that limitation instead of claiming a code defect is fixed.

## Validation update

Native Linux Node 22.22.0 on a copied checkout with frozen-lockfile dependencies passed the original full coverage command: 53 files, 684 tests, 43.85s. The real lint-config test took 2.849s with its 5s timeout intact. Windows warm-WSL coverage got past that test and the installer contract but encountered an EPERM in concurrent manifest lock-directory creation. This supports a host-specific validation limitation; it does not establish that the Windows concurrency issue is fixed. No existing tests or coverage exclusions were changed.
