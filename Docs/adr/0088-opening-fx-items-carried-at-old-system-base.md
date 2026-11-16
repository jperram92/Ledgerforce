---
adr: 0088
title: "Foreign-currency opening items are carried at the old system's base amount, with currency, amount and rate"
status: Accepted
date: 2026-11-16
author: claude
category: accounting
human_gate: yes (delegated, DL-0263)
supersedes: none
superseded_by: none
---

# ADR-0088: Foreign-currency opening items at conversion

## Status
Accepted by the building agent under the product owner's standing delegation for accounting ADRs
and golden postings (AGENTS.md §6, DL-0263). The basis is research record RQ-0170 and golden GP-043.
The decision is logged as DL-0740 and DL-0741. Tests cover it: the golden runner (pure and engine
replay), `packages/modules/setup/src/opening-balances.fx.db.test.ts`, `opening-fx.prop.test.ts`,
`opening-csv.test.ts` and `apps/api/src/setup/opening-balances.db.test.ts`.

## Context and problem statement
Design §4.1 step 9 imports the old system's trial balance and open AR/AP items (T-0080, GP-037,
base currency only). A customer invoiced in USD, or a supplier bill in USD, must come across so
that (a) the trial balance still equals the old one (no plug, RQ-0109), (b) it ages and reconciles
in base currency, and (c) it can be settled in USD after conversion with realised FX measured
correctly (design §3.7, AASB 121).

## Decision drivers
- AASB 121 para 21 (spot at recognition), para 23 (closing rate at a reporting date), para 28
  (settlement difference against the carrying amount).
- The opening entry reproduces the old trial balance exactly.
- The engine stores the rate as given (base per one foreign unit) and never recomputes base.

## Considered options
1. Carry each item at the old system's base amount and keep its currency, amount and rate on the
   control line. No FX line. (chosen)
2. Re-translate every item at a closing rate given at import and post the difference to
   FX_UNREALISED. The opening TB would then differ from the old TB, and revaluation is the Phase 1
   job (§3.7).
3. Base amount only. The item could not be allocated to a USD receipt, and realised FX would be lost.

## Decision
- The `amount` of an opening item is its base carrying amount and sums to the control row.
- A foreign item adds `currency`, `currency_amount` (same sign) and optional `fx_rate`. A given
  rate must give `round_half_up(currency_amount × fx_rate, 2) = amount`, otherwise `FX_MISMATCH`.
  A missing rate is implied as `amount ÷ currency_amount`, half-up to 8 decimals.
- An item in the base currency is a base item (rate 1, currency amount = amount).
- GST content is in base. No migration: the item view reads currency, amount and rate from the
  item's journal line.
- Public API (additive): the opening-balance CSV accepts the three optional columns. The preview
  lines return `txn_currency`, `txn_amount` and `fx_rate`. Items return `currency`,
  `currency_amount` and `fx_rate`.

## Consequences
- Settlement after conversion records `fx_difference` against the carried base. The realised-FX
  journal and the period-end revaluation remain separate goldens and tasks (DL-0187, §3.7 Phase 1).
- If the old system did not revalue at a reporting-date balance date, that error comes across
  unchanged. The setup guidance must tell the user to revalue in the old system first (follow-up
  T-0202 shows currency columns on the screen).
- The Xero reader (T-0201) must convert Xero's rate convention before building the command.
