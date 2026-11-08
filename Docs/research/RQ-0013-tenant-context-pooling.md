---
id: RQ-0013
title: Tenant context (app.tenant_id) with pooled connections — SET LOCAL semantics
status: answered
opened: 2026-10-24
resolved: 2026-10-24
opened_by: claude
linked_tasks: [T-0010]
linked_adrs: [ADR-0003]
---

# RQ-0013 — Tenant context with pooled connections

## Question
`withTenant` sets `app.tenant_id` with `set_config(..., true)` (SET LOCAL) at the start of each
transaction, and RLS policies read it. With a `pg.Pool` (and possibly PgBouncer in front of
Postgres), can one request's tenant context ever be seen by another request on the same pooled
server connection? What must the code guarantee?

## Why it matters
Tenant isolation is the security boundary (design §6.7, threat "tenant data leakage"). A context
that outlives its transaction on a reused connection would expose one tenant's rows to another.

## Sources consulted
| # | Source | Accessed | What it says |
|---|---|---|---|
| S1 | PostgreSQL 16 docs `ref/set.sgml` (REL_16_STABLE, read from github.com/postgres/postgres because postgresql.org is blocked by the sandbox proxy) | 2026-10-24 | "The effects of SET LOCAL last only till the end of the current transaction, whether committed or not." Also: "A special case is SET followed by SET LOCAL within a single transaction: the SET LOCAL value will be seen until the end of the transaction, but afterwards (if the transaction is committed) the SET value will take effect." Effects are also cancelled by rolling back to an earlier savepoint. |
| S2 | PgBouncer `doc/usage.md` (github.com/pgbouncer/pgbouncer, master) | 2026-10-24 | Transaction pooling: "A server connection is assigned to a client only during a transaction. When PgBouncer notices that transaction is over, the server connection will be put back into the pool." Statement pooling: "Multi-statement transactions are disallowed in this mode." |
| S3 | RQ-0007 (Postgres patterns, run on PG 16.15) | 2026-10-24 | Policies use `NULLIF(current_setting('app.tenant_id', true), '')::uuid`; with no context the comparison is NULL, so no rows match (fail closed). |

## Findings
1. `set_config(name, value, true)` is the function form of `SET LOCAL`. It ends with the transaction on COMMIT **and** ROLLBACK (S1), so the normal `withTenant` path cannot leak through a `pg.Pool`.
2. **The leak path is a session-level setting.** If anything ever runs `SET app.tenant_id = …`, `SET SESSION …` or `set_config('app.tenant_id', …, false)` on a pooled connection, that value survives the transaction and becomes the context for whatever runs on that connection next, including queries outside `withTenant` (S1, special case).
3. Queries outside any transaction with no context see no rows and cannot insert, because the policy compares to NULL (S3).
4. PgBouncer **transaction** pooling is compatible, since the setting lives exactly as long as the server-connection assignment (S2). **Statement** pooling is not supported: it disallows multi-statement transactions, and `withTenant` needs at least two statements (S2). **Session** pooling is compatible.

## Conclusion / decision
- Keep transaction-local `set_config(..., true)` inside `withTenant` as the only way to set tenant context.
- **Fail closed at runtime:** before setting the local value, `withTenant` reads `current_setting('app.tenant_id', true)`. A non-empty value means a session-level value leaked onto this connection, so it throws instead of running tenant work.
- **Prevent it statically:** a lint rule `lf/no-session-tenant-context` flags `SET [SESSION] app.tenant_id` and `set_config('app.tenant_id', …, false)` anywhere in source.
- Deployment note for infra/compose and the Helm chart: PgBouncer, if used, must be in session or transaction mode, never statement mode.

## Confidence
High. Semantics come from the PostgreSQL source docs and are proven by the T-0010 DB tests: pool reuse after commit and after rollback, and detection of a session-level leak.

## Follow-ups
- Infra task: document the PgBouncer pool_mode constraint when PgBouncer is introduced.

Affects: T-0010, every tenant-scoped repository, ADR-0003.
