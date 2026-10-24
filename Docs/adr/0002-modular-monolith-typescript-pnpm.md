---
adr: 0002
title: "Modular monolith in TypeScript on Node.js 22 LTS, pnpm workspace monorepo"
status: Accepted
date: 2026-10-24
author: claude
category: architecture
human_gate: no
supersedes: none
superseded_by: none
---

# ADR-0002: Modular monolith in TypeScript on Node.js 22 LTS, pnpm workspace monorepo

## Status

Accepted — 2026-10-24. Design-committed (decision D4, §7.1, §7.3); architecture category, no
human gate.

## Context and problem statement

LedgerForce targets businesses of 1–50 staff that want to be set up "in an afternoon" (§1) and
must be self-hostable with a single `docker compose up` (§6.3, §7.2). The product spans an API,
background workers (outbox, Salesforce sync, billing batches), a web UI, Salesforce Lightning
Web Components and a posting engine whose invariants must hold across every module (§3.9,
§4.6). It is built by AI agents, which "write better code in mainstream stacks" (design
principle 6), and every module must reach the ledger only through the posting API (§4.6).

We need to decide the deployment shape (one unit or many services), the language, and the
repository/package structure.

## Decision drivers

- Single-VM self-host for an SMB; minimal operational surface (§7.2).
- One posting engine, one database transaction for journal + subledger + outbox (§3.9) — this
  is trivial inside one process and hard across services.
- Agents must be able to build, test and reason about the system end to end (D4).
- One language across API, UI, workers and LWC (§7.1).
- Clear module boundaries so a module cannot write ledger tables directly (§4.6).

## Considered options

1. **Modular monolith, TypeScript/Node.js, pnpm workspaces** (`apps/*`, `packages/*`).
2. **Microservices** (separate GL, AR, AP, connector services, each with its own DB).
3. **Monolith in a different language** (e.g. Java/Spring or C#/.NET, Python/Django).
4. **Salesforce-native (Apex/managed package only).**

### Option 1 — TypeScript modular monolith

- Good, because one deployable plus workers fits Docker Compose and Helm equally well.
- Good, because ledger writes, subledger updates and the outbox commit atomically in one
  PostgreSQL transaction with no distributed transaction or saga.
- Good, because TypeScript is shared by API (NestJS), UI (React) and Salesforce LWC; strong
  typing helps agents catch errors early.
- Good, because pnpm workspaces give strict, non-hoisted dependency isolation per package, so a
  module that does not declare `@ledgerforce/ledger-internal` cannot import it.
- Bad, because a single process means one module's memory leak or CPU spike affects others
  (mitigated by separate api/worker processes from the same codebase).
- Bad, because module boundaries are enforced by convention + lint, not by the network.

### Option 2 — Microservices

- Good, because independent scaling and deploys.
- Bad, because the posting invariant (§3.3) would span services and need sagas/2PC.
- Bad, because an SMB self-host becomes a cluster to run; contradicts "setup in an afternoon".
- Bad, because far more for agents to keep consistent.

### Option 3 — Java/.NET/Python monolith

- Good, because mature ERP ecosystems (e.g. decimal types built in).
- Bad, because LWC is JavaScript anyway, so two languages; agents switch context.
- Bad, because the design's stack choices (NestJS, Kysely, pg-boss, React) are TypeScript.

### Option 4 — Salesforce-native

- Good, because no separate hosting.
- Bad, because governor limits, per-user licence cost and the design principle that the GL must
  never be editable from a CRM (D1).

## Decision outcome

Chosen option: **Option 1**.

- Runtime: Node.js 22 LTS; language TypeScript (strict mode) everywhere.
- Package manager: pnpm workspaces; layout per design §7.3 (`apps/api`, `apps/worker`,
  `apps/web`, `packages/ledger`, `packages/modules/*`, `packages/connectors/*`,
  `packages/rules`, `packages/shared`, `salesforce/`, `infra/`).
- API framework NestJS; one NestJS module per domain module.
- Two process types from one codebase: `api` and `worker`.
- Module boundary rule: only `packages/ledger` may write `journal_*`, `account_balance`,
  `subledger_entry`, `allocation` (enforced by lint and DB grants, see ADR-0004).
- Agent tooling in `scripts/agent/` is deliberately dependency-free Node.js (DL-0005), so
  failover works before `pnpm install`.

## Consequences

### Good

- Simplest possible deployment; atomic posting; one toolchain for agents.
- Module manifests (§4.6) can later be extracted into services if scale ever demands it.

### Bad / accepted trade-offs

- Requires discipline (lint rules, dependency-cruiser style checks) to keep modules decoupled.
- Node.js lacks a native decimal type — handled by ADR-0005.

### Follow-ups

- Backlog: workspace scaffold, ESLint boundary rules (`no-direct-ledger-write`), tsconfig
  project references.

## Compliance and verification

| Check | Where | Gate |
|---|---|---|
| `pnpm -r typecheck` passes in strict mode | root `package.json` script, verify.sh | design §10.8 gate 1 |
| Lint rule `no-direct-ledger-write` fails any import of ledger table writers outside `packages/ledger` | ESLint config (backlog task) | gate 1 |
| `docker compose up` on a clean VM starts api, worker, web, postgres, keycloak | infra smoke test (backlog) | release gate |

## Links

- Design: D4, design principle 6, §4.6, §7.1, §7.2, §7.3
- Decision log: DL-0005
- Related ADRs: ADR-0004, ADR-0005, ADR-0008
- External: pnpm workspaces — https://pnpm.io/workspaces ; Node.js release schedule —
  https://nodejs.org/en/about/previous-releases
