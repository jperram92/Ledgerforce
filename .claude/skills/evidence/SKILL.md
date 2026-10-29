---
name: evidence
description: Use whenever a LedgerForce task changes behaviour visible in a UI, report, PDF or export, or lists success_scenarios - to capture Playwright screenshots and test reports into .agent/evidence/<T-ID>/, append manifest.json entries, and link them from the task card and the success-scenario register Docs/specs/success-scenarios.md.
---
# Skill: evidence

Evidence is append-only (`AGENTS.md` §0.6, §0.8). Never overwrite or delete a screenshot or
manifest entry; re-runs add new files and entries.

## Paths and formats

- Screenshot: `.agent/evidence/<T-ID>/<YYYYMMDD-HHMMSS>-<scenario-id>-<slug>.png`
  (UTC timestamp; `<scenario-id>` is the SS id from the register, e.g. `SS-AR-01`; `<slug>`
  kebab-case ≤ 6 words).
- Manifest: `.agent/evidence/<T-ID>/manifest.json`:
  ```json
  {
    "schemaVersion": 1,
    "taskId": "T-NNNN",
    "entries": [
      {
        "scenario": "<SS-ID>",
        "file": ".agent/evidence/T-NNNN/<YYYYMMDD-HHMMSS>-<SS-ID>-<slug>.png",
        "test": "<spec file> › <test title>",
        "commit": "<short sha of HEAD at capture time>",
        "provider": "claude|codex",
        "timestamp": "<ISO-8601 UTC>",
        "result": "passed|failed|timedOut|skipped|interrupted"
      }
    ]
  }
  ```
  `result` is the real Playwright outcome. Only `passed` counts as evidence.
- Helper (use it; do not hand-write paths or entries): the Playwright fixture in
  `packages/testing/src/evidence/` (`import { test, expect } from '@ledgerforce/testing/evidence'`)
  provides `evidence(scenarioId, slug)`, which saves the full-page screenshot with the naming
  above and appends the manifest entry when the test finishes. The task id comes from
  `test.use({ evidenceTaskId: 'T-NNNN' })` or the environment variable `LF_TASK_ID`.
- Non-visual evidence (test report, CSV/ABA export, PDF) uses the same naming with its own
  extension and a manifest entry (`appendManifestEntries` in the same package).

## Steps

1. Commit first so `commit` is real: the test and code under evidence must be checkpointed.
2. In the Playwright spec (`tests/e2e/<area>/<screen>.spec.ts`), after the assertions for the
   scenario pass, call the fixture:
   ```ts
   import { test, expect } from '@ledgerforce/testing/evidence';
   test.use({ evidenceTaskId: 'T-NNNN' });
   test('SS-AR-01 invoice list shows posted invoices [T-NNNN]', async ({ page, evidence }) => {
     // … assertions …
     await evidence('SS-AR-01', 'invoice-list');
   });
   ```
   Screenshots must not contain secrets or real personal data — seeded test tenants only.
3. Run the E2E suite: `LF_TASK_ID=T-NNNN pnpm test:e2e` (or with a spec path). Record the exit code.
4. A failing scenario is recorded with its real `result` too (honest evidence) and blocks `done`.
5. Validate: JSON parses and every `file` exists:
   ```bash
   node -e "const m=require('./.agent/evidence/T-NNNN/manifest.json');const fs=require('fs');for(const e of m.entries){if(!fs.existsSync(e.file))throw new Error('missing '+e.file)};console.log(m.entries.length,'entries ok')"
   ```
6. Link: add the file names to the card's `evidence: []` list; in
   `Docs/specs/success-scenarios.md` update each scenario's row (test, latest evidence file,
   status) following the format defined at the top of that file.
7. Checkpoint: `node scripts/agent/conductor.ts checkpoint T-NNNN --step "k/n — evidence for <SS ids>"`.
