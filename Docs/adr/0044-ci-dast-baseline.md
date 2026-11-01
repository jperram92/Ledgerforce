---
adr: 0044
title: "Run a passive ZAP baseline scan of the compose stack in CI and fail on High alerts"
status: Proposed
date: 2026-11-01
author: claude
category: security
human_gate: yes
supersedes: none
superseded_by: none
---

# ADR-0044: Run a passive ZAP baseline scan of the compose stack in CI and fail on High alerts

## Status
Proposed — awaiting the product owner's acceptance (security category; ADR-0043 excluded DAST and
CI security gates are human-owned per AGENTS.md §5). No workflow is changed until accepted.

## Context and problem statement
Design §6.9 requires DAST; backlog T-0096 AC-1: "CI DAST job produces a report and fails on any High
finding". ADR-0043 added SAST, secret, dependency and image scanning and states "DAST … not
implemented by this ADR". RQ-0094 establishes how ZAP's baseline scan behaves (passive only,
exit codes 0/1/2/3, every alert a WARN by default, JSON report via `-J`) and that the official
GitHub action writes issues with a write token by default.

## Decision drivers
- Find common web misconfigurations (headers, cookies, information leaks) on every PR without attacking anything.
- Keep ADR-0043's guarantees: read-only token, digest-pinned tools, fail closed, no self-granted suppressions.
- Deterministic, reviewable gate logic that does not depend on ZAP's per-rule config defaults.

## Considered options
1. `zap-baseline.py` from a digest-pinned image via `docker run`, plus a repository parser that fails on High.
2. `zaproxy/action-baseline` GitHub action.
3. ZAP full (active) scan.
4. No DAST until a hosted environment exists.

### Option 1 — direct baseline + repository parser (recommended)
- Good: passive only; read-only token; same fail-closed runner pattern as ADR-0043 (`scripts/security/`); High threshold explicit and testable.
- Bad: we maintain a small parser and a contract test; needs the compose stack up in CI (~3–5 min).

### Option 2 — official action
- Good: less code.
- Bad: creates/updates GitHub issues with `GITHUB_TOKEN` by default (write access) — conflicts with ADR-0043 rule 4; fail semantics are "any alert", not "any High".

### Option 3 — full active scan
- Good: deeper coverage.
- Bad: attacks the application (state changes, long runtimes); not appropriate for every PR; separate decision.

### Option 4 — defer
- Bad: leaves §6.9 DAST unmet.

## Decision outcome
Option 1, if accepted, with these checkable rules:
1. New job `dast` in `.github/workflows/security.yml` only (ci.yml/install-smoke.yml unchanged): build and start the compose stack as `infra/compose/smoke.sh` does, then scan the web origin.
2. ZAP image pinned by tag and digest in `infra/security/tools.json`; run as a non-root container, no host network beyond reaching the stack, `contents: read`, no issue writing, no SARIF upload.
3. Command: `zap-baseline.py -t <web origin> -I -J zap.json -r zap.html -T <minutes>` (passive; warnings do not fail by themselves).
4. `scripts/security/` parses `zap.json`: any High-risk alert → exit 1; scan exit 3, missing or invalid report → exit 2 (fail closed). Report summary lists each High alert (rule id, name, URL count).
5. Real-scanner contract tests (as in ADR-0043 rule 6) against a disposable local target: a deliberately insecure fixture produces a High alert and fails; a clean fixture passes; a broken target fails closed. JSON field names are pinned by these tests.
6. Medium/Low alerts are reported in the artifact, not gated. Any exception (ignoring a High) needs a separate human-reviewed, rule-scoped proposal.

## Consequences
### Good
- §6.9 DAST baseline on every PR with an auditable report.
### Bad / accepted trade-offs
- Extra CI time; passive scanning cannot find logic flaws or injection — not a substitute for review and tests.
### Follow-ups
- T-0096 implementation after acceptance; consider a scheduled active scan as a separate ADR.

## Compliance and verification
| Check | Where (planned) | Gate |
|---|---|---|
| Insecure fixture → High → exit 1; clean → 0; broken → fail closed | tests/security/dast.contract.test.mjs | security / scanner-contracts |
| Job has read-only token, pinned image/actions, no softeners | infra/test/security-workflow.contract.test.ts | unit |
| Report artifact produced on the clean branch | security / dast job | CI |

## Links
- Research: RQ-0094. Related: ADR-0043. Design §6.9. Task: T-0096.
