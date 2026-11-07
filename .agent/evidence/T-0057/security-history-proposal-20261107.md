# Proposed history-only secret-scan exceptions — owner approval required

Status: PROPOSED, NOT APPLIED. Prepared by codex for T-0057 on 2026-11-07 UTC.

## Evidence and scope

The secrets job in [security run 42422050376](https://github.com/jperram92/Ledgerforce/actions/runs/42422050376), head `da5d6ecdcdfcf30b762f5b6e42fb68af125d1ca4`, fails on two historical `generic-api-key` findings. This is a scanner finding, not a download/runtime/report failure. The history report has two entries and exit code 1; the working-tree report is an empty array and exits 0. Gitleaks v8.30.1 image digest: `sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f`.

The same two findings occur in [run 42349926027](https://github.com/jperram92/Ledgerforce/actions/runs/42349926027), head `574663803f9e037a88cf43d30829507626a99d32`. They are in T-0074 commits, neither of which is an ancestor of the T-0057 repair head: `git merge-base --is-ancestor <finding-commit> da5d6ec` exits 1 for both. The full-history scan nevertheless includes them. Narrowing the scan to this branch would hide history and is explicitly rejected in DL-0244.

| Commit | Path and line | Verified fixture provenance |
|---|---|---|
| `2847774e1f6934dbaed059d4313354a899a58ba1` | `apps/api/src/payments/stripe-webhook.db.test.ts:149` | The finding is on a test call to `event(eventId, pi)`. That local helper serializes a synthetic event with `livemode: false`, using the arguments as the event ID and payment-intent ID. The subsequent test signs a forged request and expects HTTP 400. The flagged call supplies fixture identifiers, not an authentication credential. |
| `db482717d614d5db1536a9c55a34a527f35d37fb` | `packages/connectors/stripe/src/stripe-webhook.contract.db.test.ts:529` | The finding is a literal `idempotencyKey` in a test receipt command with local fixture company/account/invoice allocations. It is a fixture deduplication label, not an authentication credential. |

No matched values are reproduced here. Historical source context was inspected with string literals redacted before output. No `.env` file or production secret was accessed. Current working-tree scan is clean without any new suppression.

Redacted artifact: `security-secrets`, artifact ID `13594087259`, downloaded to `.tmp/security-42422050376/`. Relevant files: `history/gitleaks.json`, `history/history-metadata.json`, `tree/gitleaks.json`, `tree/secrets-metadata.json`. History timestamp `2026-11-07T22:45:17.725Z`; tree timestamp `2026-11-07T22:45:19.869Z`. Reports were generated with the runner's existing `--redact=100` setting. Only RuleID/File/StartLine/EndLine/Commit/Fingerprint and scanner metadata were printed.

## Concrete proposed change

Append only these exact commit/path/rule/line fingerprints to `.gitleaksignore`:

```text
2847774e1f6934dbaed059d4313354a899a58ba1:apps/api/src/payments/stripe-webhook.db.test.ts:generic-api-key:149
db482717d614d5db1536a9c55a34a527f35d37fb:packages/connectors/stripe/src/stripe-webhook.contract.db.test.ts:generic-api-key:529
```

The ready-to-review patch is `.tmp/t0057-security-history-exception.patch`. It has not been applied. It changes only those two entries; no workflow, scanner rule, threshold, historical commit or working-tree scan behavior changes. Existing scanner behavior ignores this file for working-tree scans and rejects inline allow comments.

## Required approval and subsequent validation

[ADR-0043 rule 5](../../../Docs/adr/0043-ci-security-scanners.md) states: “Findings require remediation or a separately human-reviewed, narrowly scoped exception proposal”. Its rules do not pre-authorize these new exceptions. [DL-0244](../../../Docs/decisions/decision-log.md) records the owner's earlier approval for specific historical fixture fingerprints; that precedent explains the mechanism but does not silently approve this pair.

After explicit owner approval, apply the two-line patch, record the decision and approval, run the workflow contract and real-scanner tests, then rerun the full-history and working-tree scans. Require history PASS and tree PASS. Retain this proposal, the earlier failed reports and commit history. Until then, CI secrets remains failed; do not mark the task all-green or merge it.

## Owner decision and application (supersedes proposed status above)

On 2026-11-07 UTC / November 8 Sydney, the owner answered **"Approve these two exact exceptions"** to the linked proposal. Applied only the two fingerprint additions shown above; the diff contains no other scanner change. Approval recorded in DL-0307. Real scan verdicts are still pending; approval is not a passing result.

Local Docker is unavailable (both Windows desktop/default named pipes absent, service stopped), so authoritative real scanner contracts and history/tree scans will run in the existing CI job. The first native Windows workflow-contract launch failed before tests because its installed node_modules lacked unplugin-swc; isolated native Linux validation is being prepared. No tests were skipped or changed.

## Approval and application — supersedes the initial proposed status

The owner explicitly approved exactly these two exceptions through the active session's approval answer; root recorded the authorization in DL-0307. Application was verified at `2026-11-07T22:50:56Z`. The two-line patch is now applied to `.gitleaksignore`; no other scanner configuration, workflow, threshold or history was changed. The original proposal above is retained as review history.

Initial local validation: `git apply --check` passed before application, and the resulting `.gitleaksignore` diff contains exactly the two approved additions. Windows workflow-contract execution failed before running tests because the existing host dependency tree lacks `unplugin-swc` (`ERR_MODULE_NOT_FOUND`); output is retained as `security-exception-workflow.log`. This is not a passing contract run; an isolated native run is being prepared.

Real-scanner local capability: Docker CLI exists, but both Windows engine endpoints are absent (`docker_engine` and `dockerDesktopLinuxEngine` named pipes); the escalated check confirms `com.docker.service` is stopped. The first sandbox check also could not read Docker config; escalation resolved that access issue and confirmed the absent daemon. No daemon/config change was made and no real-scanner local pass is claimed. CI's existing pinned real-scanner contract and full-history/working-tree jobs will validate the approved change; their results must be recorded before treating the security gate as green.
