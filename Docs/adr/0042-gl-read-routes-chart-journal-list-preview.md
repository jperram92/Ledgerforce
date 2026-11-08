---
adr: 0042
title: "GL read routes for the web screens: chart of accounts, manual-journal list and the engine preview of a stored journal"
status: Proposed
date: 2026-10-26
author: claude
category: architecture
human_gate: no
supersedes: none
superseded_by: none
---

# ADR-0042: GL read routes for the web screens

## Status

Proposed — becomes Accepted on green CI plus cross-review by codex (category architecture, a
public API change; no new permission, table or dependency, so no human gate).

## Context and problem statement

T-0082 builds the chart-of-accounts, manual-journal and "show me the journal" screens. Design
§3.9: "A preview mode runs steps 1–4 and returns the journal without writing it, which powers the
UI's 'show me the journal' button." The API from T-0029 has no list and no preview route, and
there is no read route for the chart (T-0018 only loads templates). `GET /companies` does not
return company ids, and its body is pinned by an existing test. RQ-0046 findings 1–2 and 6.

## Decision drivers

- No accounting in the browser: the journal shown must come from the posting engine itself.
- The preview must equal what submit and post run (same command, same key).
- Least privilege with the existing catalogue (ADR-0023); no new permission.
- Additive changes only; existing responses keep their fields.

## Considered options

1. **Read routes on the stored document** — `GET /accounts`, `GET /manual-journals`,
   `GET /manual-journals/:id/preview`, plus display names on `GET /manual-journals/:id`.
2. **Preview of an unsaved body** — `POST /manual-journals/preview` with the create body.
3. **Browser builds the preview** from the form and the chart.

### Option 1 — read routes on the stored document

- Good, because the preview runs `commandOf(doc)` exactly as submit/post do, with the
  document's own idempotency key (so a posted document answers `ALREADY_POSTED`).
- Good, because Approvers and Auditors (`gl.journal.read`) can see the journal before approving.
- Bad, because the user saves a draft before seeing its journal (one extra click).

### Option 2 — preview of an unsaved body

- Good, because the preview can follow typing.
- Bad, because it needs `gl.journal.post` (Approvers could not use it) and a dummy key, so it is
  not the same command post() runs.

### Option 3 — browser builds the preview

- Bad, because it is accounting in the browser and can differ from what posts (P4, AGENTS.md).

## Decision outcome

Chosen option: **Option 1**, because it shows exactly the engine's journal for the document
that will post, to every role that may read it.

Rules:

- `GET /accounts` — `gl.account.read`; `{ companies: [{id, name, base_currency}], accounts:
  [{id, company_id, code, name, type, subtype, normal_balance, currency, postable, is_control,
  status, system_roles[]}] }`, by company name then code. Read only.
- `GET /manual-journals[?status=draft|submitted|approved|posted]` — `gl.journal.read`;
  `{ journals: [...] }`, newest first, at most 200; `amount` is Σ debit of the lines summed by
  PostgreSQL as NUMERIC(19,4) text; people as display names. Another status → 400
  `invalid_filter`.
- `GET /manual-journals/:id` — unchanged fields plus `people: { <user id>: <display name> }`.
- `GET /manual-journals/:id/preview` — `gl.journal.read`; the engine's `preview()` of the
  document's command with account names added; never writes. Refusals are the existing 422
  `posting_refused {code, line, message}`; `ALREADY_POSTED` also carries `entry_id`, `entry_no`.
- nginx proxies the new `accounts` prefix (SS-PLAT-86).

## Consequences

### Good

- The web app shows the posting engine's own journal and its refusal with the line number.
- No new permission, table, migration or dependency.

### Bad / accepted trade-offs

- The list is capped at 200 without paging; paging is a follow-up when volumes need it.
- `@ledgerforce/gl` moves from a dev to a runtime workspace dependency of apps/api (internal).

### Follow-ups

- Live preview of an unsaved form (Option 2) if users ask for it.
- Keyset paging for the journal list.

## Compliance and verification

| Check | Where | Gate |
|---|---|---|
| Routes, permissions, tenant isolation, preview equals engine, refusals | `apps/api/src/journals/gl-screens.db.test.ts` (SS-PLAT-96) | `pnpm test:db` |
| Every route declares a catalogue permission | `apps/api/src/authz/routes.test.ts` (SS-PLAT-49) | `pnpm test` |
| nginx proxies exactly the API prefixes | `apps/api/src/deploy/nginx-routes.test.ts` (SS-PLAT-86) | `pnpm test` |

## Links

- Design: §3.2, §3.9, §6.4
- Research: RQ-0046
- Decision log: DL-0225
- Related ADRs: ADR-0023, ADR-0039
- External sources: none
