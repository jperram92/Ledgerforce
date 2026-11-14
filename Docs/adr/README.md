# Architecture Decision Records

Significant LedgerForce decisions, one file each, in MADR style. Small decisions go only in the
chronological [decision log](../decisions/decision-log.md); see
[`Docs/decisions/README.md`](../decisions/README.md) for how the two tiers fit together.
Template: [`0000-template.md`](0000-template.md). Skill: `write-adr`.

## When an ADR is required (design §10.6)

Write an ADR for any change to:

- the **data model** (new tables/columns with business meaning, tenancy, keys, retention);
- **accounting treatment** (posting rules, rounding, tax, FX, periods, reversal semantics);
- the **security model** (authn/authz, roles, SoD, secrets, encryption, isolation);
- the **public API** (resources, scopes, versioning, webhooks);
- an **integration contract** (Salesforce, Stripe, ABA, bank, payroll, Peppol);
- a **new runtime dependency** (dev-only tooling needs only a decision-log entry).

Also write one for process or tooling decisions that constrain every future task (e.g. ADR-0011
to ADR-0015). If in doubt, write it — an unnecessary ADR costs minutes; a lost decision costs days.

## Lifecycle

```
Proposed ──(gate passed)──▶ Accepted ──(new ADR replaces it)──▶ Superseded by ADR-NNNN
    └────────(rejected)──▶ Rejected
```

1. **Propose.** The agent copies the template to `NNNN-<slug>.md` (next free number, never
   reused), fills every section, sets `status: Proposed`, adds a row to the index below and a
   decision-log entry, all **in the same branch/PR as the work it governs**.
2. **Gate.** Who accepts depends on `category`:

   | Category | `human_gate` | Accepted when |
   |---|---|---|
   | accounting | yes | the product owner applies PR label **`adr:accounting`** (and approves) |
   | security | yes | the product owner applies PR label **`adr:security`** (and approves) |
   | any category touching a design §11.2 open decision or out-of-scope item | yes | the product owner approves (label `human-gate`) |
   | architecture, integration, data, process, tooling | no | CI is green **and** the cross-provider reviewer approves (label `cross-review`) |

   Data-model changes that affect tenancy, ledger tables or money are classed as `security` or
   `accounting`, not `data`.
3. **Accept.** On merge, the status line records how and by whom (e.g. "Accepted 2026-11-03 by
   product owner via PR #21, label adr:accounting"). The gated ADR stays `Proposed` until the
   label is applied — work may continue on a *design-committed* option but must not merge to
   `main` past the gate.
4. **Reject.** A rejected ADR stays in place with `status: Rejected` and the reason.
5. **Supersede — never delete or rewrite.** An accepted ADR's body is frozen. To change the
   decision, write a new ADR with `supersedes: ADR-NNNN`; in the old file change **only** the
   `status:` and `superseded_by:` lines (forward link) and update this index. Deleting an ADR is
   forbidden (ADR-0014).

## Index

| ADR | Title | Category | Human gate | Status |
|---|---|---|---|---|
| [0000](0000-template.md) | Template | — | — | — |
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions as MADR files in `Docs/adr` | process | no | Accepted |
| [0002](0002-modular-monolith-typescript-pnpm.md) | Modular monolith in TypeScript on Node.js 22 LTS, pnpm monorepo | architecture | no | Accepted |
| [0003](0003-postgresql-forced-rls-tenancy.md) | PostgreSQL shared schema with forced row-level security for tenancy | security | yes | Proposed (design-committed; awaiting product owner) |
| [0004](0004-immutable-ledger-reversal-hash-chain.md) | Immutable append-only ledger, corrections by reversal, hash chain | accounting | yes | Proposed (design-committed; awaiting product owner) |
| [0005](0005-numeric-money-decimal-js.md) | Money as NUMERIC(19,4) and decimal.js; floating point banned | accounting | yes | Proposed (design-committed; awaiting product owner) |
| [0006](0006-salesforce-commercial-system-of-record.md) | Salesforce is the commercial system of record; field ownership table | integration | no | Proposed (accept with connector task) |
| [0007](0007-salesforce-auth-eca-jwt-pkce.md) | Salesforce auth: ECA with JWT bearer (self-host) and auth code + PKCE (hosted) | security | yes | Proposed (awaiting product owner; RQ to re-verify platform facts) |
| [0008](0008-postgres-job-queue-transactional-outbox.md) | Postgres-backed job queue (pg-boss) and transactional outbox | architecture | no | Accepted |
| [0009](0009-licence.md) | Licence: AGPL-3.0 core, Apache-2.0 SDKs and Salesforce package | process | yes | Proposed — **open decision** (§11.2) |
| [0010](0010-payroll-by-integration.md) | Payroll by integration until Phase 3 | accounting | yes | Proposed (design-committed; awaiting product owner) |
| [0011](0011-repo-resident-state-dual-provider-failover.md) | Repository-resident agent state with dual-provider failover | process | no | Accepted |
| [0012](0012-tdd-golden-postings-property-invariants.md) | TDD with golden postings and property-based invariants as definition of done | process | no | Accepted |
| [0013](0013-db-test-harness-testcontainers-local-pg.md) | Database test harness: Testcontainers with local PostgreSQL fallback | tooling | no | Accepted |
| [0014](0014-no-delete-superseding-forward-only-migrations.md) | No-delete policy; superseding; forward-only additive migrations | process | no | Accepted |
| [0015](0015-playwright-screenshot-evidence.md) | Playwright screenshot evidence for every UI/report success scenario | process | no | Accepted |
| [0016](0016-oidc-login-and-server-side-sessions.md) | OIDC login with tenant-scoped server-side sessions, idle/absolute timeouts and revoke-all | security | yes | Accepted |
| [0017](0017-journal-hash-chain-canonical-form-v1.md) | Journal hash chain: canonical form v1 (netstrings), computed in the database at commit | accounting | yes | Accepted |
| [0018](0018-envelope-encryption-local-keyring-kms.md) | Envelope encryption of bank account numbers with a pluggable KMS; local keyring for self-host MVP | security | yes | Accepted |
| [0023](0023-role-templates-and-permission-checks.md) | Role templates as code, tenant-scoped role assignments, fail-closed permission checks | security | yes | Accepted |
| [0024](0024-period-control-matrix-and-lock-policy.md) | Period control: §3.5 matrix as data, invariant 3 in the database, personal overrides, two-approver reopen, lock-date policy | accounting | yes | Accepted |
| [0025](0025-mfa-enforcement-and-step-up.md) | MFA enforcement for finance roles and step-up re-authentication on the existing session | security | yes | Accepted |
| [0026](0026-segregation-of-duties-engine-and-small-team-mode.md) | Segregation-of-duties engine: rules as data, append-only action ledger, tenant thresholds, visible small-team exceptions | security | yes | Accepted |
| [0027](0027-user-lifecycle-and-scoped-api-tokens.md) | User lifecycle (joiner/mover/leaver) and scoped personal API tokens | security | yes | Accepted |
| [0029](0029-job-queue-privileges-and-supervision.md) | Job queue (pg-boss) privileges: lf_app DML on the shared pgboss schema, owner-run supervision | security | yes | Accepted |
| [0030](0030-bank-detail-change-verification-and-cooling-off.md) | Bank-detail change verification: database-enforced workflow, requester ≠ verifier at commit, step-up proof, cooling-off eligibility, durable notices | security | yes | Accepted |
| [0032](0032-salesforce-pubsub-grpc-client-and-avro-decoding.md) | Salesforce Pub/Sub API client: grpc-js + proto-loader on the vendored proto, avsc for Avro, replay id committed with the batch | integration | no | Accepted |
| [0034](0034-audit-log-read-path-and-admin-read-routes.md) | Audit log read path: permission-checked SECURITY DEFINER reader instead of SELECT for lf_app; admin read routes (users, caller access, audit log) | security | yes | Accepted |
| [0035](0035-subledger-open-items-and-allocations.md) | AR/AP open items signed like the GL, append-only allocations priced by the database, fx_difference recorded without an FX journal | accounting | yes | Accepted |
| [0036](0036-salesforce-writeback-collections-contract.md) | Salesforce write-back: outbox handler with a versioned writeBack snapshot, mirrors upserted by LF_Id__c, Account/Opportunity updated by Salesforce id | integration | no | Accepted |
| [0037](0037-self-hosted-install-owner-bootstrap-and-realm-mfa.md) | Self-hosted install: first Owner with a one-time IdP password, realm-wide MFA via the ACR mapping, file secrets, one public origin | security | yes | Accepted |
| [0038](0038-openbao-transit-kms-adapter.md) | OpenBao/Vault transit KMS adapter: derived-key context binding, 60-byte wrapped key with versioned key id, HTTPS-only fetch without redirects, strict key policy | security | yes | Accepted |
| [0039](0039-manual-journal-document-and-approval.md) | Manual journals as approvable documents posted only through the engine (approval above the threshold or on control/tax/equity accounts, preparer ≠ approver in API and database); control accounts closed to manual, imported and rule journals | security | yes | Accepted |
| [0040](0040-sync-issues-inbox-dead-letters-and-api-budget-share.md) | Sync issues inbox: dead letters become tenant issues, failure log outside pg-boss, one-click retry as a new delivery job, API budget share as connection data | security | yes | Accepted |
| [0042](0042-gl-read-routes-chart-journal-list-preview.md) | GL read routes for the web screens: chart of accounts, manual-journal list and the engine preview of a stored journal | architecture | no | Accepted |

| [0043](0043-ci-security-scanners.md) | Fail-closed CI scans with local rules and verified tooling | security | yes | Accepted |
| [0044](0044-ci-dast-baseline.md) | Run a passive ZAP baseline scan of the compose stack in CI and fail on High alerts | security | yes | Accepted |
| [0045](0045-pdf-rendering-playwright-core.md) | Render document PDFs from HTML templates with playwright-core driving headless Chromium | architecture | no | Accepted |
| [0046](0046-email-smtp-nodemailer.md) | Send document email over SMTP with nodemailer from outbox handlers | integration | no | Accepted |
| [0047](0047-content-bound-golden-approval-records.md) | Content-bound records of existing golden approvals | process | no | Accepted |
| [0048](0048-stripe-payment-link-per-invoice.md) | Stripe Payment Link per invoice and amount due, created at send time by a fetch-based client | integration | no | Accepted |
| [0049](0049-stripe-webhook-endpoint-and-tenant-routing.md) | Stripe webhooks: one signed endpoint per deployment, tenant from signed Payment Link metadata | security | yes | Accepted |
| [0050](0050-customer-bank-details-for-refunds.md) | Let customer-only parties hold verified bank details for refunds | security | yes | Accepted |
| [0051](0051-gross-ecl-allowance-remeasurement.md) | Gross ECL allowance and subsequent remeasurement | accounting | delegated | Accepted |
| [0052](0052-owner-authorized-independent-codex-review.md) | Independent Codex review for the current pickup batch | process | owner instruction | Accepted |
| [0053](0053-mime-parsing-postal-mime.md) | Parse inbound bill email with postal-mime | integration | no | Accepted |
| [0054](0054-api-security-headers-and-rate-limits.md) | API security headers, strict CORS and rate limits on auth and mutating routes | security | yes | Accepted |
| [0072](0072-owner-delegated-permissions.md) | New permissions for invoice approval, customer refunds and the setup wizard | security | yes | Accepted |
| [0074](0074-customer-refund-approval-and-routes.md) | Customer refunds: maker-checker approval before payment, and the refund routes | security | yes (delegated, DL-0477) | Accepted |
| [0068](0068-ecl-allowance-by-role.md) | Resolve the ECL allowance by its system role; deprecate ar_settings.ecl_allowance_account_id | data | no | Accepted |
| [0062](0062-cross-tenant-daily-job-scheduling.md) | Reach every tenant from a scheduled daily job without widening lf_app | security | yes | Accepted |
| [0056](0056-period-reopen-http-routes.md) | HTTP routes to reopen a hard-locked period: request, approve, list | architecture | no | Accepted |
| [0057](0057-batch-read-status-and-item-results.md) | Batch billing responses carry the batch status and each item's result | architecture | no | Proposed |
| [0067](0067-setup-wizard-completion-record.md) | Persist only the setup wizard's completion record; derive step status and validate from module state | data | no | Accepted |
| [0071](0071-wizard-module-settings.md) | Store GST basis and BAS frequency in tax_settings, and invoice branding, terms and methods in ar_settings | data | no | Proposed |

Next free number: **0055** (0055–0060 are reserved for the DL-0409 parallel round) (0048–0052 are used by Line A ADRs arriving through integration) (unused: 0028 — T-0027; 0031 — T-0026; 0033 — T-0076; 0041 — T-0072; none needed an ADR).
