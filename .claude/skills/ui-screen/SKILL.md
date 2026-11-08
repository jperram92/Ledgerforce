---
name: ui-screen
description: Use when building or changing any LedgerForce screen in apps/web (React, Vite, TanStack Router/Query, shadcn/ui) - wizard steps, lists, forms, document views, reports, journal preview. Defines the test-first Playwright flow, UI principles from Docs/ui/principles.md, accessibility and states, and mandatory screenshot evidence per success scenario.
---
# Skill: ui-screen

Act as `.claude/agents/ui-engineer.md`. Read `Docs/ui/principles.md`, `Docs/ui/tokens.css` and
any mockup in `Docs/ui/mockups/` for the screen first.

## Steps

1. **Scenario:** confirm the screen's success scenarios exist in
   `Docs/specs/success-scenarios.md` and are listed in the card's `success_scenarios:`. If a
   scenario is missing, draft it in the register (status as the register defines for drafts) and
   link it.
2. **RED:** write the Playwright spec `tests/e2e/<area>/<screen>.spec.ts`, one `test()` per SS
   id, titled `<SS-ID> <title> [T-NNNN]`. Assert visible outcomes by role/label
   (`getByRole`, `getByLabel`), never by CSS class. Use seeded test tenants; amounts asserted as
   the formatted decimal string the spec gives. Run `pnpm test:e2e <spec>` and capture RED.
3. **Component tests** (Vitest) for non-trivial logic (formatters, form validation) — RED first.
4. **Implement** with shadcn/ui components and the design tokens; data via TanStack Query from
   the API; journals shown via the posting engine's preview endpoint — never computed in the
   browser. No `number` arithmetic on money.
5. **States & access:** loading, empty, error (with retry), permission-denied; keyboard path
   through every action; labels on all inputs; visible focus; WCAG 2.2 AA contrast; sensitive
   values masked (bank accounts: last 3 digits).
6. **GREEN:** `pnpm test:e2e <spec>` and `pnpm test` pass; `bash scripts/agent/verify.sh --quick`.
7. **Evidence:** skill `evidence` — screenshot per SS id to
   `.agent/evidence/<T-ID>/<YYYYMMDD-HHMMSS>-<scenario-id>-<slug>.png`, manifest entry, card and
   register links. Include at least one narrow-viewport (375 px wide) screenshot per screen.
8. Checkpoint (skill `checkpoint`).
