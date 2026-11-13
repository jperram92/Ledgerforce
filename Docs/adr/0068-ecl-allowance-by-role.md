---
adr: 0068
title: "Resolve the ECL allowance by its system role; deprecate ar_settings.ecl_allowance_account_id"
status: Accepted
date: 2026-11-13
author: claude
category: data
human_gate: no
supersedes: none
superseded_by: none
---

# ADR-0068: Resolve the ECL allowance by its system role; deprecate ar_settings.ecl_allowance_account_id

## Status
Accepted (category data, no human gate). T-0145, DL-0474.

## Context and problem statement
Design §3.2 says the posting engine finds accounts by role. Since T-0117 (ADR-0061), AR_ECL_ALLOWANCE is a bound system role (migration 0062). The template binds it, and period-end provisions post to it by role. The bad-debt write-off (T-0048) still read the allowance account from `app.ar_settings.ecl_allowance_account_id`. That gave the same concept two sources, which could diverge: provisions would credit one account while write-offs drew on another.

## Decision drivers
- One source of truth for every system account (design §3.2).
- Migrations are forward-only and additive; nothing is dropped (AGENTS.md directive 6).
- No silent behaviour change for companies that set the account already.

## Considered options
1. **The role is the source; the setting is deprecated and may only agree.** A write-off whose setting differs from the role binding is refused with NOT_CONFIGURED.
2. **The setting overrides the role.** This keeps two sources, and provisions and write-offs can then use different accounts.
3. **Drop the column.** This is forbidden; migrations are additive.

## Decision outcome
Option 1. `writeOffInvoice` posts the allowance line as `{ role: 'AR_ECL_ALLOWANCE' }` and reads the remaining allowance from the role-bound account. `ar_settings.ecl_allowance_account_id` stays in the schema, marked deprecated. Its column comment is added by the next migration the lead owns (card T-0159). `setArSettings` keeps accepting it for compatibility, but it no longer decides anything.

## Consequences
- Companies whose setting equals the role-bound account see no change. That is the template default (1220), and the existing GP-024 tests cover it.
- A company that set a different account must clear the setting or re-bind the role. The error message says so.
- The suggested setting `ecl_allowance_account` in the template becomes redundant. Removing it is part of T-0159.
