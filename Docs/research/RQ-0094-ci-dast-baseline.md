---
id: RQ-0094
title: How should CI run a baseline DAST scan against the compose stack and fail on High findings?
status: resolved
opened: 2026-11-01
resolved: 2026-11-01
opened_by: claude
linked_tasks: [T-0096]
linked_adrs: [ADR-0044]
superseded_by:
---

# RQ-0094 — How should CI run a baseline DAST scan against the compose stack and fail on High findings?

## Question
Q1. Which OWASP ZAP mode is a safe "baseline" for CI, and what does it do to the target?
Q2. How are results reported and how do exit codes map to findings?
Q3. How can the gate fail on **High** findings specifically (T-0096 AC-1)?
Q4. Can the official GitHub action be used under ADR-0043's least-privilege rules?

## Why it matters
Design §6.9 asks for DAST; T-0096 AC-1 requires a CI DAST job that produces a report and fails
on any High finding. A CI security gate is human-owned (AGENTS.md §5) and ADR-0043 explicitly
excludes DAST, so the shape must be decided before any workflow change.

## Sources consulted
| # | Source | Accessed | Kind | What it says |
|---|---|---|---|---|
| S1 | zaproxy/zaproxy `docker/zap-baseline.py` at 3fc32cecdd6f31abbf5525ef72f0e6ad93f03e98 (git sparse clone of https://github.com/zaproxy/zaproxy) | 2026-11-01 | source code | Header: "By default it will spider the target URL for one minute … It will then wait for the passive scanning to finish"; exit codes "0: Success, 1: At least 1 FAIL, 2: At least one WARN and no FAILs, 3: Any other failure"; "By default all alerts found by ZAP will be treated as WARNings"; options `-t`, `-c config_file` (INFO/IGNORE/FAIL), `-g` (generate config), `-m` minutes, `-J report_json`, `-r` html, `-w` md, `-x` xml, `-I` do not fail on warning, `-T` max minutes. Exit logic lines ~699–709: exception → 3; fail_count>0 → 1; warnings and not -I → 2; pass_count>0 → 0; else 3. |
| S2 | same repo `docker/zap_common.py` | 2026-11-01 | source code | Alerts carry a `risk` string; 'Informational' handled specially (line ~532). |
| S3 | same repo `docker/Dockerfile-stable` | 2026-11-01 | source code | Final image `debian:bookworm-slim`, runs as `USER zap`. |
| S4 | https://github.com/zaproxy/action-baseline README | 2026-11-01 | primary (vendor) | The action "maintains an issue in GitHub repository for the identified alerts"; "By default the baseline action will file the report to the GitHub issue … Set this to false"; uses `secrets.GITHUB_TOKEN`; default image `ghcr.io/zaproxy/zaproxy:stable`; example pins `@v0.15.0`. |
| S5 | https://www.zaproxy.org/docs/docker/baseline-scan/ | 2026-11-01 | — | Not reachable from the agent sandbox (DNS blocked); S1 is the implementation that page documents. |

## Findings
1. The baseline scan only spiders (default 1 min) and runs **passive** rules; it does not run active attacks (S1). Suitable for every PR.
2. Without a config file every alert is a WARN; exit 2 on warnings unless `-I`; exit 3 on any error, including no PASS results (S1). Rules become FAIL only per rule id via `-c` (S1).
3. Inference: "fail on any High" is per **risk**, not per rule, so the gate should run with `-I` (warnings do not fail), always write `-J report.json`, and a repository script must parse the JSON and fail when any alert has risk High; exit 3 (scan error) and a missing/invalid report must fail closed, as in ADR-0043 rule 5. The exact JSON field names (`site[].alerts[].riskcode`, "3" = High) could not be read from the docs site (S5); the implementation's contract test must pin them against a real report produced by the pinned image.
4. The official action writes GitHub issues with a write token by default (S4), which conflicts with ADR-0043 rule 4 (`contents: read`, no write token). Run the pinned image directly with `docker run` instead.
5. The scan needs a running stack: reuse `infra/compose/smoke.sh`'s build/start path (T-0094/T-0113) and scan the web origin (nginx, which proxies the API and Keycloak).

## Conclusion / decision
Propose ADR-0044 (security, human gate): add a `dast` job to `.github/workflows/security.yml` that
starts the compose stack, runs `zap-baseline.py -t <web origin> -I -J report.json -T <limit>` from a
digest-pinned ZAP image as an unprivileged container with `contents: read` only, uploads the JSON
(and HTML) report as an artifact, and fails closed on scan errors, missing/invalid reports or any
High-risk alert via a repository parser with real-scanner contract tests. No issue writing, no
active scan, no suppressions without separate human review. Implementation waits for acceptance.

## Confidence
high for Q1, Q2, Q4 (source code and vendor README); medium for the JSON field names in Q3 (to be
pinned by a contract test on a real report).

## Follow-ups
- Resolve and record the ZAP image digest when implementing (ghcr blob host is blocked in the agent sandbox; resolve via CI or a mirror).
- Re-check S4 for issue-writing defaults if the action is ever reconsidered.

**Affects:** T-0096, ADR-0043/ADR-0044, `.github/workflows/security.yml`, design §6.9.
