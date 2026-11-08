---
adr: 0005
title: "Money as NUMERIC(19,4) in PostgreSQL and decimal.js in code; floating point banned"
status: Proposed
date: 2026-10-24
author: claude
category: accounting
human_gate: yes
supersedes: none
superseded_by: none
---

# ADR-0005: Money as `NUMERIC(19,4)` in PostgreSQL and decimal.js in code; floating point banned

## Status

Proposed — **Design-committed; awaiting product-owner acceptance.** Committed in design §3.4 and
§7.1; it determines rounding and therefore accounting results, so the `adr:accounting` gate applies.

## Context and problem statement

JavaScript `number` is an IEEE-754 binary double: `0.1 + 0.2 !== 0.3`. Accounting amounts,
GST (10% in AU, §3.6), FX conversion (§3.7) and line-vs-document rounding (§3.4) all need exact
decimal arithmetic with explicit rounding modes (AU default: per line, half-up to cents, with the
difference posted to ROUNDING). Exchange rates need more precision than amounts
(`NUMERIC(18,8)`, §3.4). The PostgreSQL `pg` driver returns `NUMERIC` as strings by default,
which is safe only if code never converts them to `number`.

## Decision drivers

- Exactness: every posting balances to the cent (principle 1).
- Explicit, configurable rounding (half-up per line or per document).
- Multi-currency and future currencies with 0 or 3 minor units (JPY, KWD) — avoid baking in
  "2 decimals".
- Tooling can enforce it (lint rule), because agents will otherwise reach for `number`.

## Considered options

1. **Integer minor units (cents) in `BIGINT` and JS `bigint`/`number`.**
2. **`NUMERIC(19,4)` (amounts) / `NUMERIC(18,8)` (rates) in DB, decimal.js in code, strings at
   boundaries.**
3. **IEEE-754 floats (`double precision` / JS `number`) with rounding at display.**

### Option 1 — Integer cents

- Good, because integer arithmetic is exact and fast.
- Bad, because intermediate results (tax on a line, FX at 8-dp rates, pro-rata credit notes,
  §8.2 UC-11) need sub-cent precision before rounding; you end up scaling by different factors
  per currency and per operation.
- Bad, because currencies with 0 or 3 minor units need per-currency scaling logic everywhere.

### Option 2 — NUMERIC + decimal.js

- Good, because exact base-10 arithmetic with configurable precision and rounding modes
  (`ROUND_HALF_UP`, etc.).
- Good, because 4 dp in storage leaves headroom for unit prices and intermediate amounts while
  documents round to the currency's minor unit explicitly.
- Good, because PostgreSQL `NUMERIC` is exact and the DB balance trigger (ADR-0004) can sum
  without rounding error.
- Bad, because decimal.js is slower than native numbers and is a runtime dependency (this ADR
  serves as its dependency ADR).
- Bad, because every boundary (DB driver, JSON API, UI) must keep values as strings.

### Option 3 — Floats

- Good, because no library.
- Bad, because representation error accumulates; a trial balance can be off by fractions of a
  cent; unacceptable for a GL.

## Decision outcome

Chosen option (design-committed): **Option 2**.

Rules:

1. DB: amounts `NUMERIC(19,4)`, rates `NUMERIC(18,8)`; never `real`, `double precision` or
   `money` type for financial values.
2. Code: a `Money`/`Decimal` type in `packages/shared/money` wrapping decimal.js; all arithmetic
   through it. Rounding mode is always explicit at the call site (no implicit default rounding).
3. Boundaries: `pg` returns NUMERIC as string (keep default; never install a parser to
   `number`); JSON APIs carry amounts as strings.
4. Lint: an ESLint rule (`no-float-money`) bans `parseFloat`, `Number(...)`, unary `+`,
   `toFixed` and arithmetic operators on values typed as money/amount; CI fails on violation.
5. Rounding policy (per line vs per document, half-up) is a company setting (§3.4); the
   difference posts to the ROUNDING system account.

## Consequences

### Good

- Exact, auditable arithmetic; rounding differences are explicit journal lines, not drift.

### Bad / accepted trade-offs

- Verbosity (`a.plus(b)` instead of `a + b`) and some performance cost.
- New runtime dependency `decimal.js` (MIT licence) — covered by this ADR.

### Follow-ups

- Backlog: `packages/shared/money` with property tests; ESLint `no-float-money` rule.
- Golden postings must include rounding cases (e.g. GST on $0.05 lines, per-line vs per-document).

## Compliance and verification

| Check | Where | Gate |
|---|---|---|
| `no-float-money` lint rule (with its own failing-fixture tests) | ESLint plugin in repo (backlog) | §10.8 gate 1 |
| Schema check: no `real`/`double precision`/`money` columns; amount columns are `numeric(19,4)` | catalog test on migrated DB | gate 2 |
| Property tests: Σ of rounded lines + ROUNDING line = document total for random inputs | fast-check suite (ADR-0012) | gate 3 |
| Golden GST rounding cases | `Docs/accounting/postings.md` | gate 4 |

## Links

- Design: principle 1, §3.4, §3.6, §3.7, §7.1, §10.8 gate 1
- Related ADRs: ADR-0004, ADR-0012
- External: decimal.js — https://mikemcl.github.io/decimal.js/ (npm `decimal.js`, latest 10.6.0
  as of 2026-10-24); PostgreSQL numeric types — https://www.postgresql.org/docs/17/datatype-numeric.html
