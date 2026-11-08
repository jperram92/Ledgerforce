# apps/api — NestJS HTTP API

> Local rules for this directory. They **add to** the root [`AGENTS.md`](../../AGENTS.md) and
> never contradict it; if they seem to, the root file wins. `CLAUDE.md` here only imports this file.

## What lives here
The NestJS HTTP API (design §7.1, §7.3): one Nest module per domain module, thin controllers
that turn requests into commands for `packages/modules/*` and the posting engine.

## Local rules
- **No accounting logic here.** Controllers validate input, resolve the auth context and call
  module services; journals are produced only by `packages/ledger` through the posting API.
- **No direct ledger writes** (`journal_*`, `account_balance`, `subledger_entry`, `allocation`).
- Every mutating endpoint requires an **idempotency key** (design §3.9) and returns the same
  result on replay.
- Every request runs in a transaction that starts with `SET LOCAL app.tenant_id` from the
  authenticated context; connect as `lf_app` only.
- Authentication via OIDC (design §6.2); authorisation via RBAC + SoD checks (§6.4–6.5) in a
  guard, never ad hoc in controllers. Supplier bank-detail changes and payment-batch actions
  always pass the SoD engine.
- Money in request/response bodies is a **decimal string** (`"110.0000"`), never a JSON number.
- Security headers, CSRF, CSP, strict CORS, rate limiting (§6.9); audit-log every mutation.
- Public API changes need an ADR (design §10.6); keep the OpenAPI contract in sync.

## Tests
- Unit: colocated `apps/api/src/**/*.test.ts`; DB-backed: `apps/api/src/**/*.db.test.ts` (HTTP status,
  body schema, permission denial, idempotent replay, tenant isolation).
- Roles: build as a builder role; `security-reviewer` for auth/permissions changes.
