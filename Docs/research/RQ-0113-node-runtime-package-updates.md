---
id: RQ-0113
title: Apply available Alpine security package updates to Node runtime images
status: resolved
opened: 2026-11-10
resolved: 2026-11-10
opened_by: codex
linked_tasks: [T-0057]
linked_adrs: [ADR-0043]
superseded_by:
---

# RQ-0113 — Node runtime package updates

## Question

How should API, worker and setup images receive fixes newer than their pinned Alpine base without weakening the image vulnerability gate?

## Sources consulted

| Source | Accessed | Kind | Finding |
| --- | --- | --- | --- |
| https://docs.alpinelinux.org/user-handbook/0.1a/Working/apk.html | 2026-11-10 | Primary, opened | apk upgrade refreshes installed packages and dependencies using configured repositories; mixing release branches is discouraged. |
| GitHub Actions run 42422632802 at 96a6b93, failed job logs via gh | 2026-11-10 | Executed scanner evidence | API, worker and setup contain zlib 1.3.2-r1; scanner reports CVE-2026-4738 Critical, fixed in 1.4-r0. This records the scanner result, not independent CVE verification. |
| infra/docker/Dockerfile and DL-0248 | 2026-11-10 | Repository source | Web already applies apk upgrade --no-cache after installing the pinned base. Shared node-runtime does not. |

## Conclusion

Apply the existing package-update policy to shared node-runtime before switching to USER node. Keep base digest, repositories, runtime user and scanner configuration unchanged. No runtime dependency is added. Add a contract ensuring the shared runtime applies updates and all three targets inherit it. Real image build and unchanged vulnerability scans must subsequently pass; the static contract alone does not prove CVE remediation.

## Confidence and follow-up

High confidence in apk behavior and observed omission. Patched package availability and final image scan remain to be verified in CI because the local Docker daemon is unavailable.
