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
| [0016](0016-oidc-login-and-server-side-sessions.md) | OIDC login with tenant-scoped server-side sessions, idle/absolute timeouts and revoke-all | security | yes | Proposed |
| [0017](0017-journal-hash-chain-canonical-form-v1.md) | Journal hash chain: canonical form v1 (netstrings), computed in the database at commit | accounting | yes | Proposed |
| [0018](0018-envelope-encryption-local-keyring-kms.md) | Envelope encryption of bank account numbers with a pluggable KMS; local keyring for self-host MVP | security | yes | Proposed |
| [0023](0023-role-templates-and-permission-checks.md) | Role templates as code, tenant-scoped role assignments, fail-closed permission checks | security | yes | Proposed |
| [0024](0024-period-control-matrix-and-lock-policy.md) | Period control: §3.5 matrix as data, invariant 3 in the database, personal overrides, two-approver reopen, lock-date policy | accounting | yes | Proposed |

Next free number: **0025**.
