---
adr: 0012
title: "Test-driven development with golden postings and property-based invariants as the definition of done"
status: Accepted
date: 2026-10-24
author: claude
category: process
human_gate: no
supersedes: none
superseded_by: none
---

# ADR-0012: Test-driven development with golden postings and property-based invariants as the definition of done

## Status

Accepted — 2026-10-24 (process). Product-owner directive ("test-driven: expected result before
code") plus design §10.1 principle 3 and §10.8. Note: this ADR fixes the *process*; the content
of each golden posting remains a separate **human gate** (`golden_postings`) — agents may draft
golden postings but only the product owner approves them.

## Context and problem statement

The top project risk is "agent writes plausible but wrong accounting logic" (§11.1). Plausible
code passes code review; it fails only against independently-stated expected results. The
product owner requires that the expected result exists before production code. Unit tests
written *after* code by the same agent tend to encode the code's behaviour rather than the
requirement. Accounting also has global invariants (every entry balances; TB nets to zero;
subledger = control; reversal restores balances, §10.8 gate 3) that example-based tests cover
only sparsely; the MVP exit criterion demands the invariant suite pass 10,000 random documents
(§9.1).

## Decision drivers

- Expected results independent of the implementing agent (human-owned golden postings).
- Broad coverage of invariants with random inputs and shrinking to minimal counter-examples.
- Machine-checkable definition of done that both providers run identically (`verify.sh`).
- No shortcuts: tests may not be skipped or weakened to get green.

## Considered options

1. **Strict TDD (red → green → refactor) per acceptance criterion + human-owned golden postings
   + fast-check property-based invariant suite; `verify.sh` implements §10.8.**
2. **Test-after with coverage threshold.**
3. **Example-based TDD only (no property-based tests, no golden files).**
4. **Golden/snapshot tests only (auto-approved snapshots).**

### Option 1

- Good, because the failing test proves the test can detect the defect; red evidence is
  recorded in the run log/PR.
- Good, because golden postings make the accounting expectation a human artefact the agent
  cannot rewrite (`Docs/accounting/postings.md`; Approved files are protected).
- Good, because property-based tests explore thousands of random documents and shrink failures.
- Bad, because slower initial progress; property generators need care.

### Option 2 — Test-after with coverage

- Good, because faster to write.
- Bad, because coverage measures execution, not correctness; tests mirror the code's bugs.

### Option 3 — Example-based only

- Good, because simple and readable.
- Bad, because misses edge cases (rounding, FX, partial allocations) that random generation finds.

### Option 4 — Auto-approved snapshots

- Good, because cheap.
- Bad, because the agent approves its own output — no independent expectation.

## Decision outcome

Chosen option: **Option 1**.

1. For every acceptance criterion: write the failing test, run it and confirm it fails for the
   right reason, implement the minimum, green, refactor, checkpoint (skill `tdd-cycle`).
2. Any posting behaviour requires a golden posting in `Docs/accounting/postings.md`; a missing
   or Draft golden posting blocks the task at the human gate. Agents never edit an Approved
   golden file.
3. Invariant suite with fast-check over random documents (CI runs a fixed-seed profile plus a
   larger nightly run; the MVP gate requires ≥ 10,000 documents).
4. `scripts/agent/verify.sh` implements the definition of done (§10.8: typecheck/lint/format;
   unit + integration, coverage not dropping; invariants; golden postings; cross-tenant RLS;
   forward migrations; security scans; cross-provider review).
5. Never `.skip`, `.only`, `.todo`, `xit`, or weaken assertions to pass; mark the task `blocked`.

## Consequences

### Good

- Accounting correctness rests on human-owned expectations plus exhaustive invariants.

### Bad / accepted trade-offs

- Golden postings are a human bottleneck; Sprint 0 drafts them early so the human can approve
  ahead of the ledger tasks.
- Property tests can be slow; tiered profiles (PR vs nightly).

## Compliance and verification

| Check | Where | Gate |
|---|---|---|
| Lint bans `.skip`/`.only`/`.todo`/`xit` in test files | ESLint (`no-skipped-tests`), verify.sh | §10.8 gate 1 |
| PR template requires TDD evidence (red output → green output) | `.github/pull_request_template.md` | review gate 8 |
| Golden test compares each §3.8 event's journal with `postings.md` | golden test runner (backlog) | gate 4 |
| Invariant suite (balance, TB=0, subledger=control, reversal restores) | fast-check suite | gate 3 |
| Approved golden files unchanged unless the PR carries the `golden_postings` human label | verify.sh protected-path check | gate 4 |

## Links

- Design: §8 (use cases as acceptance backbone), §9.1 (10,000 documents), §10.1 principle 3, §10.8, §11.1
- Related ADRs: ADR-0004, ADR-0005, ADR-0013, ADR-0015
- External: fast-check — https://fast-check.dev/ ; Vitest — https://vitest.dev/
