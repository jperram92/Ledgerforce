---
id: RQ-0105
title: Why unit coverage fell after the Line A integration, and what gate 2c should measure
status: answered
opened: 2026-11-12
resolved: 2026-11-13
opened_by: claude
linked_tasks: [T-0128]
linked_adrs: []
superseded_by:
---

# RQ-0105 — Gate 2c after the Line A integration

## Question
Gate 2c (`scripts/agent/verify.sh`) compares unit-project line coverage
(`vitest --project unit --coverage`) with `.agent/coverage-baseline.json` on `origin/main` (72.22 %, recorded
2026-10-24). After integrating Line A it reports 58.48 % (4f8ca92). Is the code less tested, or is
the measure misleading, and what is the remedy that does not weaken the gate?

## Evidence

| Measurement | Tree | Lines |
|---|---|---|
| unit only (gate 2c as implemented) | 6b2c4ce (main 5c3a2e3 + T-0121) | 74.11 % |
| unit only | 4f8ca92 (Line A integrated) | 58.48 % (3,731 / 6,378) |
| unit only | 6d7531d (+ T-0041 branch) | 58.81 % |
| **unit + db** (`--project unit --project db`) | 6d7531d | **93.7 %** (7,887 / 8,417), 155 files / 2,136 tests pass |
| **unit + db** | main 5c3a2e3 | **93.95 %** (5,547 / 5,904), 116 files / 1,690 tests pass |

Largest unit-only gaps at 6d7531d: `ledger/posting-engine.ts` 6.5 %, `connectors/salesforce/inbound/apply.ts` 2.6 %,
`modules/ar/invoices.ts` 7.4 %, `ledger/subledger.ts` 7.7 %, `modules/bank/matching.ts` 1.2 %. AGENTS.md
requires these modules to be tested against a real PostgreSQL (`*.db.test.ts`, "never mock the
database"), so they are well covered by the db project. V8 coverage counts a file once any unit test imports
it, so a unit test that imports a module index pulls these DB-tested files into the unit-only
denominator.

## Conclusion
The drop comes from the measure, not from less testing. Including the db project measures what the
repository's own testing rules require. Two honest remedies exist:

1. **Keep the measure; add unit tests.** Roughly 2,600 uncovered lines are mostly SQL-driven code
   that AGENTS.md says must be tested against PostgreSQL. Mocking the database for coverage would
   contradict the "never mock the database" rule. Not recommended.
2. **Measure unit + db, against a main baseline recorded under the same measure.** This changes gate 2c's
   comparison and the baseline file on main. The owner's handoff (CLAUDE_NEXT.md) says not to
   change gate comparison logic or manufacture a baseline without them, so this needs the owner's
   decision and merge.

Comparing the combined measure (93.7 %) with the unit-only baseline (72.22 %) would pass the gate, but it compares two different measures and is not
proposed.

**Status: answered-pending-human.** T-0128 is blocked on the owner choosing remedy 2, or another.

## Main under the combined measure
Measured 2026-11-12 in a temporary worktree of 5c3a2e3, with the same command and one worker: **93.95 %**. The
integrated tree (6d7531d) is **93.70 %**, so even under the like-for-like measure the integration is
0.25 points lower. Remedy 2 alone would therefore still fail by a small margin. T-0128's work is to
close that gap with assertion-bearing tests (unit or db) in the least-covered integrated files,
whichever measure the owner chooses. Under the current unit-only measure the gap is
13.7 points, almost all of it from DB-tested files.

## Resolution (2026-11-13)
**Status: answered.** The owner approved remedy 2 (DL-0408: "Approved"). Implemented in T-0128 (DL-0410, DL-0411):

- Gate 2c measures `unit+db`: `VITEST_MAX_WORKERS=1 pnpm -s exec vitest run --project unit --project db --coverage.enabled --coverage.reporter=json-summary`.
  It runs on one worker even if the caller sets more, so the measure is reproducible.
- `.agent/coverage-baseline.json` records `"measure"`. A main baseline without that field is the old unit-only measure.
  When main's measure differs from the gate's, the gate is **PENDING** and asks for main's baseline to be re-recorded
  under the same measure. It never passes or fails across measures.
- Baseline re-recorded with that exact command over bcf4ab6 (the PR #4 merge 983cc91 plus T-0131/T-0083 and docs commits): **lines 93.65 %**
  (8,071 / 8,618), branches 79.21 %, functions 95.66 %, statements 91.09 %. 160 test files and 2,195 tests passed, none skipped.
  Per-package figures: `.agent/evidence/T-0128/coverage-unit+db-by-package-bcf4ab6.txt`.
- Until that baseline is on main, gate 2c on branches reports PENDING (main still holds the unit-only file). That is the intended
  behaviour, not a pass.
- The 0.25-point like-for-like drop measured on 2026-11-12 (93.95 % → 93.70 %) is now part of the main history: 983cc91 was merged
  by the owner under DL-0405 item 3. The new baseline records the tree as it is (93.65 %). Raising it with assertion-bearing tests
  is ordinary work and no longer a gate blocker.
