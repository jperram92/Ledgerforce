---
adr: 0093
title: "Idempotency-Key required on POST /sod/exceptions/weekly/acknowledge (amends ADR-0085)"
status: Proposed
date: 2026-11-17
author: claude
category: architecture
human_gate: no
supersedes: none
superseded_by: none
---

# ADR-0093: Idempotency-Key required on POST /sod/exceptions/weekly/acknowledge

## Status

Proposed. It becomes Accepted on green CI plus cross-review by codex, as ADR-0085. Category
architecture (a public API change). It amends ADR-0085, which made the same change for
`POST /sod/settings`, by this separate record; ADR-0085 and ADR-0026 are not edited. No new
permission, table, migration or dependency, so no human gate. Decision log: DL-0793. Task: T-0196.

## Context and problem statement

`apps/api/AGENTS.md`: "Every mutating endpoint requires an idempotency key (design §3.9) and returns
the same result on replay." RQ-0167 S8 found that `POST /sod/exceptions/weekly/acknowledge`
(ADR-0026, the Owner acknowledges a week of small-team exceptions) takes no key. T-0186 fixed the
sibling route `POST /sod/settings` (ADR-0085, DL-0711). This route, unlike that one, has a web
caller: `apps/web/src/admin/client.ts` `acknowledgeWeek`, used by the weekly control-exceptions
screen. So the client and the route have to change together.

## Decision drivers

- One rule for every mutating route; the settings routes (DL-0642) and `POST /sod/settings`
  (DL-0711) already answer 400 `idempotency_key_required` without the header.
- The route is already idempotent by state: a week acknowledged with nothing new since answers
  200 and writes nothing. No key table is needed.
- The only client is in this repository and ships with the API.

## Considered options

1. **Require the header before reading the body; do not store it** (chosen). Same as DL-0711.
2. Store keys and replay the first response. Rejected: a key table for a route that is already
   replay-safe by state adds storage and no safety. No other settings route does it.
3. Accept the header but not require it. Rejected: it leaves the rule broken for other clients.

## Decision outcome

Option 1.

- `POST /sod/exceptions/weekly/acknowledge` calls `requireKey` (`apps/api/src/settings/settings-common.ts`)
  before the body is read. A missing, empty or over-200-character `Idempotency-Key` answers 400
  `{error: 'idempotency_key_required'}`, even when the body is also invalid. Nothing is written or
  audited.
- With a key, the behaviour is unchanged: 201 for a new acknowledgement, 200 when the week is
  already acknowledged with nothing new (any key). Permission (`settings.sod.manage`) is still
  checked first by the guard.
- The web admin client's `acknowledgeWeek(weekStart, key, note?)` sends the header. The
  control-exceptions screen sends a fresh key per press.

### Consequences

- Good: every mutating SoD route now follows the apps/api rule.
- Bad: any other client of the route must send a key. There is none outside this repository.
- Neutral: replays stay state-based; the key is not stored.

## Compliance and verification

| Check | Where |
|---|---|
| 400 without a key, nothing written or audited; 201 new; 200 already acknowledged | `apps/api/src/sod/sod.db.test.ts` (SS-PLAT-150) |
| The screen sends a key; the existing acknowledgement flow stays green | `tests/e2e/web/admin.spec.ts` (SS-PLAT-79 / SS-PLAT-150) |

## Links

ADR-0085, ADR-0026, RQ-0167 (S7, S8), DL-0642, DL-0711, DL-0714, DL-0793, T-0186, T-0196.
