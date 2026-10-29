# apps/web — React app

> Local rules for this directory. They **add to** the root [`AGENTS.md`](../../AGENTS.md) and
> never contradict it; if they seem to, the root file wins. `CLAUDE.md` here only imports this file.

## What lives here
The React + Vite + TanStack Router/Query + shadcn/ui front end (design §7.1).

## Local rules
- **UI principles:** follow [`Docs/ui/principles.md`](../../Docs/ui/principles.md) and the tokens
  in `Docs/ui/tokens.css`; mockups in `Docs/ui/mockups/`. Use skill `ui-screen` for every screen
  and act as `.claude/agents/ui-engineer.md`.
- **Every screen gets Playwright evidence:** a spec in `tests/e2e/<area>/<screen>.spec.ts`
  with one test per success scenario (`Docs/specs/success-scenarios.md`), asserting the outcome
  and saving screenshots to `.agent/evidence/<T-ID>/<YYYYMMDD-HHMMSS>-<scenario-id>-<slug>.png`
  with a `manifest.json` entry (skill `evidence`).
- **No accounting in the browser.** Journals come from the posting engine's preview endpoint;
  money is a decimal string from the API, formatted for display only — never converted to
  `number` for arithmetic.
- Accessibility: keyboard path for every action, labelled controls, visible focus, WCAG 2.2 AA
  contrast; loading, empty, error and permission-denied states on every screen.
- Sensitive values masked (bank accounts show the last 3 digits — design §6.6).
- Select elements in tests by role/label, never by CSS class.

## Tests
- Component/unit: colocated `apps/web/src/**/*.test.ts(x)` (`pnpm test`).
- E2E: `tests/e2e/<area>/*.spec.ts` (`pnpm test:e2e`, root `playwright.config.ts`), using the
  evidence fixture from `@ledgerforce/testing/evidence`. Do not run `playwright install`; use the
  preinstalled browsers.
