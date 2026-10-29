---
adr: 0043
title: "Fail-closed CI scans with local rules and verified tooling"
status: Proposed
date: 2026-10-29
author: codex
category: security
human_gate: yes
supersedes: none
superseded_by: none
---

# ADR-0043: Fail-closed CI scans with local rules and verified tooling

## Status
Proposed — awaiting product-owner acceptance and explicit authorization for protected CI additions. No security workflow has been changed.

## Context and problem statement
Design §6.9/§10.8 requires SAST, dependency, container and secret scanning plus release SBOMs. T-0095 covers those scans. Current CI's verifier acknowledges missing SAST. RQ-0092 verifies available tool behavior. AGENTS.md §5 protects security gates; the earlier approval only covered LF_EVIDENCE_DIR and does not authorize this change.

## Decision drivers
- Catch defects and leaked credentials before merge, and prove failures with real scanners.
- Preserve all existing checks and avoid source upload or privileged execution of PR code.
- Produce auditable image inventories; distinguish scanner failure from a clean result.

## Considered options
1. Local CLI tools with pinned releases and repository-owned rules.
2. Hosted security services and repository security integrations.
3. Existing regex secret scan and pnpm audit only.

### Option A — local CLI tools (recommended)
- Good: reproducible invocation, no required vendor account/source upload, inspectable rules and artifacts.
- Bad: maintain rule coverage, version pins, vulnerability databases and triage discipline.

### Option B — hosted services
- Good: managed updates and review UI.
- Bad: account, data-sharing, permission and licensing decisions exceed this bounded change; requires a separate proposal.

### Option C — existing checks only
- Good: no new tooling or CI work.
- Bad: does not satisfy container/SAST/SBOM requirements; cannot be represented as complete.

## Decision outcome
Propose option A with these checkable rules:
1. Add `.github/workflows/security.yml`, repository-owned scanner configuration under `infra/security/`, a runner under `scripts/security/`, and real-scanner contracts under `tests/security/`. Retain ci.yml/install-smoke.yml checks and permissions. Any change to existing security-gate behavior requires further explicit authorization.
2. Use Semgrep CE with local reviewed rules, `--metrics=off --error --strict`; Gitleaks CLI history/working-tree scans with full redaction; existing pnpm audit at high severity for production dependencies; Syft CycloneDX JSON for each shipped image and Grype with a high-or-critical failure threshold. Report lower severities without declaring them absent. Include dev-dependency audit reporting.
3. Pin actions to verified full SHAs and scanner binaries/images to checked hashes/digests. No mutable latest tags or pipe-to-shell installs. Record versions, image digests and vulnerability DB metadata in artifacts.
4. PR jobs use `contents: read`, no production secrets, no privileged pull_request_target checkout, no package/image publishing, and no write-token SARIF upload. Publish redacted JSON/SARIF/SBOM files as ordinary run artifacts only.
5. Scanner/configuration/download/database failures are failures. Missing or malformed reports fail. Never use continue-on-error, ignore-registry-errors, ignore-unfixed or blanket suppressions to obtain green. Findings require remediation or a separately human-reviewed, narrowly scoped exception proposal; this ADR authorizes no exceptions.
6. Tests run the actual pinned scanners on isolated synthetic fixtures and assert exits, redaction and parsed output. Test secrets are generated in temporary git repos, not real credentials. Vulnerable dependency/image fixtures are scanned, never started as applications.

## Consequences
### Good
- Explicit scan coverage, least-privilege jobs and evidence that negative cases fail.
- SBOMs tied to built image digests support later release attestations.
### Bad / accepted trade-offs
- Additional CI time/network downloads; advisory DB changes can surface new failures on unchanged code.
- CE rules are not a guarantee of whole-program security; reviewer and tenant/accounting tests remain essential.
### Follow-ups
- T-0095: pin actual tool versions, test seeded failures before implementing workflow, review results and obtain independent cross-provider review.
- DAST and image signing/publication are not implemented by this ADR; retain release/hardening gates. No claim of ASVS certification.

## Compliance and verification
| Check | Where (planned) | Gate |
|---|---|---|
| Synthetic secret causes nonzero exit and is redacted | tests/security/scanners.contract.test.ts | security contract |
| Vulnerable dependency/image causes nonzero exit; clean fixture succeeds | tests/security/scanners.contract.test.ts | dependency/container |
| Unsafe SAST fixture fails; malformed rule/scanner failure fails | tests/security/scanners.contract.test.ts | SAST |
| SBOM parses, identifies packages and matches built image | tests/security/scanners.contract.test.ts | SBOM |
| Read-only token, immutable pins, no skipped checks | infra/test/security-workflow.contract.test.ts | workflow contract |

## Links
- Design: §6.9, §10.8, §10.9 in Docs/solution-design/solution-design.md.
- Research: RQ-0092 (primary URLs and retrieval date 2026-10-29).
- Decision log: DL-0240.
- Related ADRs: ADR-0003 and ADR-0007 remain unchanged; no tenant/auth policy changes.
