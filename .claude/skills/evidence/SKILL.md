---
name: evidence
description: Use whenever a LedgerForce task changes behaviour visible in a UI, report, PDF or export, or lists success_scenarios - to capture Playwright screenshots and test reports into .agent/evidence/<T-ID>/, append manifest.json entries, and link them from the task card and the success-scenario register Docs/specs/success-scenarios.md.
---
# Skill: evidence

Evidence is append-only (`AGENTS.md` §0.6, §0.8). Never overwrite or delete a screenshot or
manifest entry; re-runs add new files and entries.

## Paths and formats

- Screenshot: `.agent/evidence/<T-ID>/<YYYYMMDD-HHMMSS>-<scenario-id>-<slug>.png`
  (UTC timestamp; `<scenario-id>` is the SS id from the register; `<slug>` kebab-case ≤ 6 words).
- Manifest: `.agent/evidence/<T-ID>/manifest.json` — a JSON array; each entry:
  ```json
  {
    "scenario": "<SS-ID>",
    "file": "<YYYYMMDD-HHMMSS>-<SS-ID>-<slug>.png",
    "test": "apps/web/e2e/<file>.e2e.ts › <test title>",
    "commit": "<git rev-parse --short HEAD at capture time>",
    "provider": "claude|codex",
    "timestamp": "<ISO-8601 UTC>",
    "result": "pass|fail"
  }
  ```
- Non-visual evidence (test report, CSV/ABA export, PDF) uses the same naming with its own
  extension and a manifest entry.

## Steps

1. Commit first so `commit` is real: the test and code under evidence must be checkpointed.
2. In the Playwright spec, after the assertions for the scenario pass, save the screenshot with
   the naming above, e.g.:
   ```ts
   await page.screenshot({ path: evidencePath(taskId, 'SS-…', 'invoice-posted'), fullPage: true });
   ```
   (`evidencePath` lives in the shared e2e helpers; if absent, build the path inline exactly as
   specified above.) Screenshots must not contain secrets or real personal data — use seeded
   test tenants only.
3. Run the E2E suite: `pnpm test:e2e` (or `pnpm test:e2e <spec>`). Record the exit code.
4. Append one manifest entry per file with `result` from the actual run. A failing scenario is
   recorded as `fail` too (honest evidence) and blocks `done`.
5. Validate: every `file` exists, JSON parses:
   ```bash
   node -e "const m=require('./.agent/evidence/T-NNNN/manifest.json');const fs=require('fs');for(const e of m){if(!fs.existsSync('.agent/evidence/T-NNNN/'+e.file))throw new Error('missing '+e.file)};console.log(m.length,'entries ok')"
   ```
6. Link: add the file names to the card's `evidence: []` list; in
   `Docs/specs/success-scenarios.md` update each scenario's row (test, latest evidence file,
   status) following the format defined at the top of that file.
7. Checkpoint: `node scripts/agent/conductor.ts checkpoint T-NNNN --step "k/n — evidence for <SS ids>"`.
