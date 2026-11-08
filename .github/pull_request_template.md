<!--
Title: Conventional Commit style with task id, e.g.  feat(ar): batch billing preview [T-0057]
Fill every section. Write "n/a — <reason>" rather than deleting a section.
-->

## Task

- Task card: `T-NNNN` — <title> (`.agent/backlog/T-NNNN.md`)
- Branch: `feat/T-NNNN-<slug>`
- Built by: <claude | codex> · Run log(s): `.agent/runs/<date>-<run>.md`
- Phase: <MVP | Phase 1 | …>

## Use cases / success scenarios

<!-- Which UC-NN and success-scenario ids (Docs/specs/success-scenarios.md) this PR satisfies. -->

| Use case | Scenario id | Acceptance criterion | Test that proves it |
|---|---|---|---|
| UC-NN | SS-NN-n | Given … when … then … | `path/to/test.spec.ts › name` |

## TDD evidence (red → green)

<!-- For each acceptance criterion: the failing run BEFORE the implementation, then the passing run. -->

<details><summary>Red — test failing for the right reason</summary>

```
<paste failing output, or link to the run log section>
```
</details>

<details><summary>Green — after implementation</summary>

```
<paste passing output>
```
</details>

## Evidence

- Screenshots / reports: `.agent/evidence/T-NNNN/` (list files, one per success scenario)
- `scripts/agent/verify.sh` output: <link to run log or paste summary>

## Decisions

- Decision log entries added: DL-NNNN, …
- ADRs added / changed: ADR-NNNN (status: Proposed | Accepted | Superseded by …)
- Research records: RQ-NNNN (all linked RQs `resolved`)

## Human gates touched

- [ ] None
- [ ] ADR in category **accounting** → needs label `adr:accounting` from the product owner
- [ ] ADR in category **security** → needs label `adr:security` from the product owner
- [ ] **Golden postings** (`Docs/accounting/postings.md`) created or changed → label `golden_postings`
- [ ] Release or phase gate
- [ ] Outside design scope / design §11.2 open decision → label `human-gate` (+ issue)

## Definition of done (design §10.8 — `scripts/agent/verify.sh`)

- [ ] 1. Typecheck, lint (incl. no-float-money and no-direct-ledger-write) and format pass
- [ ] 2. Unit and integration tests pass; coverage did not drop
- [ ] 3. Accounting invariant (property-based) suite passes
- [ ] 4. Golden postings match `Docs/accounting/postings.md` (no Approved golden file edited)
- [ ] 5. Cross-tenant RLS suite passes (new tenant tables have RLS ENABLE + FORCE + policy)
- [ ] 6. Migrations are forward-only, additive, and apply on the previous release's schema (PG16 and PG17)
- [ ] 7. Security scans (SAST, dependencies, secrets) clean
- [ ] 8. Cross-provider review approved (label `cross-review`; reviewer ≠ builder provider)
- [ ] Success-scenario register and task card updated; HANDOVER rewritten; lease released
- [ ] New runtime dependency? → ADR linked above (or "none")
- [ ] **No files deleted** (no `rm` / `git rm` of tracked files; superseded instead — ADR-0014)
- [ ] **No tests skipped or weakened** (no `.skip`, `.only`, `.todo`, `xit`, loosened assertions)
