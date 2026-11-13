---
id: RQ-0105
title: Why unit coverage fell after the Line A integration, and what gate 2c should measure
status: answered-pending-human
opened: 2026-11-12
resolved:
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
