# Independent review T-0166 — FAIL

Reviewed product/test pin: `ad56bb92500d9d697b70a3d8a5277d4de9375437`; metadata follow-up `9bcf08c5cc5be6fd9f16a7abe4d099a93a53244a`.

## Independence and limits

Reviewer: codex, independent agent `/root/independent_review`. Builder: codex, `/root` (earlier work also has Claude provenance). Date: 2026-11-10 UTC.
The owner's explicit instruction to review in Codex authorizes this bounded exception (ADR-0052 / DL-0315). This is not a different-provider review, security acceptance, release approval, or a general policy exception.

I inspected the pinned diff, relevant implementation, tests, cards, research/decision references and CI results. Product/state were not edited. I did **not** independently rerun full verify, unit, DB, browser, lint or typecheck: this shared checkout is advancing on another task, and full verification writes evidence/state outside my assigned report paths. CI evidence below is inspected evidence, not commands I executed locally. The review-role requirement for independent full reruns remains unmet. No task is certified done by this report. No approval of T-0168 or unbuilt single-supply work is implied.

## Commands and evidence

- Read-only `git show` / scoped `git diff`, file reads and `rg` searches: completed.
- Scoped added-line shortcut/suppression/float search and deleted-file/SQL diff over `d32dfeb..6f2f0fe`: no matches/deletions/new SQL. Date-fix diff separately inspected.
- `node --test infra/test/runtime-updates.test.mjs`: exit 0, 1/1 passed, independently executed.
- GitHub CLI initially failed on sandbox access to its configuration; authorized retry succeeded.
- Inspected `gh run view 42731772383`: head `9bcf08c5cc5be6fd9f16a7abe4d099a93a53244a`, static/unit, DB/RLS, browser and 10,000-document invariants successful; full definition-of-done failed.
- Inspected `gh run view 42732423565`: head `a8bf5db68c67e4552e5c702910f3d2df93ee71c6`, same four product jobs successful; definition-of-done failed.
- Inspected security runs `42701989847` at `9eb7736a44a9245a00d2e9aa587bf9e012084f4f` and `42729484502` at `ad56bb92500d9d697b70a3d8a5277d4de9375437`: success.
- Full verifier evidence at T-0166 product pin records 12 PASS / 3 FAIL / 1 PENDING. Missing manifest was subsequently supplied; a blocked card and automated provider mismatch do not become green merely because product jobs pass.
- Coverage evidence reports 73.39% against actual `origin/main e39a76c` baseline 72.22%. Earlier local-main absence is superseded, not a remaining coverage blocker.


## Findings

**MAJOR — obsolete GP-038 remains an effective Approved expectation.** At the reviewed pin, `packages/ledger/src/golden/postings.ts:128` recognizes only a predecessor Status-line “Superseded by” marker; `approvedTables` at168 includes every approved entry. GP039 explicitly says it supersedes GP038 for current implementation, but the parser ignores that declaration. The inventory test at `golden-postings.golden.test.ts:37` omits GP038 from SUPERSEDED and asserts32 active IDs/42 journals, including both. Consequently the standard runner still advertises/replays known-wrong party/tax attribution as an active Approved expectation. This contradicts GP039's stated corrective scope and runner superseded-selection contract.

No runtime write-off defect was found in this port. The real module regression explicitly filters GP039, binds GST account2310, checks customer attribution, GST-ADJ debit125, AR closure, residual allowance125 until separate reassessment, final expense1250, accrual1B125 and cash0. These are meaningful checks of existing write-off behavior; the empty outbox adapter is confined to this accounting integration test, which makes no event-delivery claim.

Initial gross allowance1375 and subsequent explicit125 release are scenario-specific, documented accounting inferences (RQ0133/ADR0051), not a new blanket ECL rule or automatic portfolio sweep. I reviewed arithmetic, trace and research record; I did not independently reopen all primary texts and do not issue professional accounting certification.

## Checklist

| Item | Result | Reason / evidence |
| --- | --- | --- |
| A1 | pass | Inspected CI static job passes; no independent local rerun. |
| A2 | pass | Inspected CI unit/DB jobs pass; recorded comparable coverage improves 72.22% to73.39%. |
| A3 | pass | Inspected fresh-seed 10,000-document invariant CI job passes. |
| A4 | fail | GP038 remains active despite explicit GP039 current-implementation supersession; historical byte preservation is correct but insufficient for effective selection. |
| A5 | pass | Inspected DB/RLS CI passes; scoped changes add no tenant table. |
| A6 | pass | n/a: reviewed patches introduce no migration. |
| A7 | pass | Real security run42729484502 succeeded at ad56bb9. |
| A8 | pass | Bounded owner-authorized independent Codex review, ADR-0052; literal different-provider automation remains unresolved. |
| B1 | pass | Inspected GP039 three-journal lifecycle balances; GST125/AR1375/net allowance1250 and later release125 match scenario. |
| B2 | pass | No added direct ledger writes; date validation adds none; lifecycle uses post/allocate. |
| B3 | pass | No changed control-account authorization; no new manual bypass. |
| B4 | pass | No period-policy change; lifecycle uses distinct supported accounting dates. |
| B5 | pass | n/a: no Salesforce ownership changes. |
| B6 | pass | n/a: no Salesforce sync changes. |
| B7 | pass | No SoD policy/permission changes; proposed security ADRs are not accepted by this review. |
| B8 | pass | No new tenant table/role; existing DB/RLS CI successful. |
| B9 | pass | Pinned commits, cards, DL/RQ and evidence preserve the reviewed work; remaining gates explicitly documented. |
| B10 | pass | Scoped changes introduce no Phase 1 dependency. |
| B11 | pass | Adds missing gross allowance/reassessment case; no claim to cover separate single-supply deposits or estimation UI. |
| B12 | unclear | RQ0133 records applicable primary texts and inference limits; reviewer has not independently retrieved them in this pass. |
| C1 | pass | No production code introduced; inventory/module regressions cover existing behavior. Two failed real DB runs preserved, not relabeled as deliberate RED. |
| C2 | pass | Scoped diff has no skipped/focused/deleted tests, lowered property count or new suppression. |
| C3 | pass | Scoped deleted-file list empty; no new SQL migration. |
| C4 | pass | Money remains decimal strings/Money/Decimal; Number.isNaN concerns date milliseconds only. |
| C5 | pass | No posted-row mutation; test lifecycle calls posting engine. |
| C6 | pass | Approved historical content preserved; appended GP038 and GP039 decisions use recorded standing accounting delegation. No env/security-gate edit. |
| C7 | pass | Task-specific feature branches and task-tagged conventional commits; no main push in reviewed work. |
| C8 | pass | No new runtime dependency; apk updates existing OS packages, mechanism recorded RQ-0099/DL-0309. |
| C9 | pass | Relevant DL0309–0313 and accounting ADR0051 record decisions; accounting delegation is explicit. |
| C10 | pass | RQ0099/RQ0133 resolved; persona card has no open research requirement. |
| C11 | pass | manifest.json pins SS-PLAT-106 to passing ad56bb9 CI output; earlier missing-manifest failure retained. |
| C12 | fail | Full verifier remains failed; task is blocked and effective golden selection requires repair; reviewer full rerun requirement unmet. |

## Required follow-up

Late CI evidence independently retrieved: run42731772383 full verifier is **13 PASS / 2 FAIL / 1 PENDING**. Gate9 evidence now passes; gate4 Approved-diff guard and gate12 blocked status fail; gate8 other-provider review is pending. Coverage passes73.39% vs72.22%. Security run42732423611 at persona metadata head a8bf5db68c67e4552e5c702910f3d2df93ee71c6 succeeds. These results supersede the earlier missing-manifest failure, not the product finding or independent-rerun limitation.

1. Add a failing regression proving GP038 is superseded byGP039 and excluded from current approvedTables while its original text/tables remain available as history. Resolve explicit whole-entry supersession from an Approved successor without editing approved prose. Do not interpret the partial wording-only GP024/025 note as whole-entry supersession. Cover invalid/ambiguous declarations before relying on them.
2. Re-run pure golden, engine DB and gross-allowance lifecycle tests, then independent review of that correction.
3. Complete full verification/provenance and metadata gates. Preserve existing human security/release gates.

Technical verdict is FAIL for effective golden selection, although the inspected real write-off lifecycle and all product CI jobs passed. Parent was notified before this report so repair can proceed separately.

