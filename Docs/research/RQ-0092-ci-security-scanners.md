---
id: RQ-0092
title: Select fail-closed CI scanners and prove negative fixtures
status: resolved
opened: 2026-10-29
resolved: 2026-10-29
opened_by: codex
linked_tasks: [T-0095]
linked_adrs: [ADR-0043]
superseded_by:
---

# RQ-0092 — CI security scanner selection

## Question
Which tools cover design §6.9/§10.8 without uploading source or granting untrusted PR jobs write credentials, and how do tests prove they actually fail?

## Why it matters
Current verify.sh runs an audit and a regex secret scan, but explicitly reports SAST unavailable. No dedicated security workflow exists. A green job is not proof that unimplemented scanners ran. T-0095 is a protected security-gate change and needs human acceptance/authorization before workflow implementation.

## Sources consulted
All accessed with the web tool on 2026-10-29; primary documentation, not third-party recommendations.

| ID | Source | Fact supported |
|---|---|---|
| S1 | https://docs.semgrep.dev/cli-reference | Local scan supports explicit rules, --error for findings and --strict for warning-level errors; metrics can be disabled. Default scan findings alone do not fail. |
| S2 | https://github.com/gitleaks/gitleaks | CLI git/dir/stdin modes, nonzero findings status and --redact=100; detect/protect are deprecated aliases. |
| S3 | https://github.com/anchore/syft | Generates CycloneDX/SPDX SBOMs from images/filesystems and interoperates with Grype. |
| S4 | https://oss.anchore.com/docs/reference/grype/cli/ | Scans images/filesystems/SBOMs; supports a severity failure threshold. Documentation generated with 0.119.0; pin and verify the chosen release during implementation. |
| S5 | https://docs.github.com/en/actions/reference/security/secure-use | Minimize token permissions, avoid privileged untrusted checkout, pin third-party actions to full commit SHAs. |
| S6 | https://pnpm.io/cli/audit | Audit queries registry advisories, offers severity filtering and JSON; --ignore-registry-errors suppresses registry failures and must not be used for this gate. |

## Findings
1. Explicit fail flags matter (S1/S4/S6). Tests must assert nonzero exits for seeded findings, not merely parse printed output.
2. Full history scanning plus a working-tree scan catches different secret exposure surfaces (S2). Fixture secrets must be synthetic, generated in isolated temporary repositories, never embedded in product files or globally ignored.
3. Inference from S3/S4: producing the image SBOM first provides a reviewable input for vulnerability scanning and a release artifact. Scan the exact built image, not only its source lockfile.
4. Prefer local Semgrep rules with metrics disabled, Gitleaks CLI, existing pnpm audit, and Syft/Grype. This is a proposed security policy, not an accepted implementation decision. Rules need representative positive/negative tests before selection.

## Conclusion / decision
Propose ADR-0043. Keep all current checks. Add separate least-privilege security jobs only after owner authorization. Pin verified tool binaries/images/actions; record versions and DB age. Block on scanner errors or missing outputs. Do not mark existing SAST as implemented. DAST, image signing and release publication remain separately tracked design obligations.

## Confidence
High for documented capabilities; medium for policy suitability until seeded real-tool tests run. No scanners installed or executed in this research step.

## Follow-ups
Accept/reject ADR-0043 and authorize its narrow protected-workflow scope. Then test real scanner failures on synthetic secrets, vulnerable dependency/image fixtures, malformed configuration and missing outputs; run a clean fixture producing a parsed SBOM. Do not execute vulnerable fixtures as applications.

**Affects:** T-0095, design §6.9/§10.8, ADR-0043. Research resolved; security acceptance remains pending.
