# Independent review T-0057 — FAIL (completion gates); scoped technical review PASS

Reviewed product: `9eb7736a44a9245a00d2e9aa587bf9e012084f4f`, date repair `da5d6ecdcdfcf30b762f5b6e42fb68af125d1ca4`; historical fixture exception `96a6b935e2a9aa268d659b1ae2144a017e602f73`.

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

No defect identified in the repaired date predicate or runtime update. Guarding invalid Date before ISO serialization prevents RangeError; the round trip still rejects normalized impossible days. Module/API regressions cover invalid month/day, non-leap February, April overflow, typed422 refusal, unchanged journals/outbox/batch/bill, plus accepted leap day.

The shared runtime upgrades packages before USER node; API, worker and setup inherit it. Real security CI succeeded without changing scanner thresholds. The earlier two historical secret fingerprints are narrowly documented as owner-approved in96a6b93; this review grants no additional exceptions.

The working task card now supersedes the stale missing-main-coverage claim. Its checked step7 refers to historical verification, while current definition-of-done remains failed. Retain that distinction and finish metadata only after real gates clear.

## Checklist

| Item | Result | Reason / evidence |
| --- | --- | --- |
| A1 | pass | Inspected CI static job passes; no independent local rerun. |
| A2 | pass | Inspected CI unit/DB jobs pass; recorded comparable coverage improves 72.22% to73.39%. |
| A3 | pass | Inspected fresh-seed 10,000-document invariant CI job passes. |
| A4 | unclear | No new golden edit in these repairs; inherited Approved-diff provenance guard still fails and is not waived. |
| A5 | pass | Inspected DB/RLS CI passes; scoped changes add no tenant table. |
| A6 | pass | n/a: reviewed patches introduce no migration. |
| A7 | pass | Real security run42701989847 succeeded at reviewed runtime SHA. |
| A8 | pass | Bounded owner-authorized independent Codex review, ADR-0052; literal different-provider automation remains unresolved. |
| B1 | pass | Date-only change cannot alter GP009 amounts; existing GP009/module/property tests pass in CI. |
| B2 | pass | No added direct ledger writes; date validation adds none; lifecycle uses post/allocate. |
| B3 | pass | No changed control-account authorization; no new manual bypass. |
| B4 | pass | No period-policy change; lifecycle uses distinct supported accounting dates. |
| B5 | pass | n/a: no Salesforce ownership changes. |
| B6 | pass | n/a: no Salesforce sync changes. |
| B7 | pass | No SoD policy/permission changes; proposed security ADRs are not accepted by this review. |
| B8 | pass | No new tenant table/role; existing DB/RLS CI successful. |
| B9 | pass | Pinned commits, cards, DL/RQ and evidence preserve the reviewed work; remaining gates explicitly documented. |
| B10 | pass | Scoped changes introduce no Phase 1 dependency. |
| B11 | pass | n/a: repair scope is validation/runtime, not new accounting coverage; unresolved integration work remains separate. |
| B12 | pass | Runtime remediation mechanism recorded in RQ0099 and tested by actual rebuilt-image scans; no tax/vendor claims added. |
| C1 | pass | Saved builder-red/green date logs (8 failures then19pass); runtime RED followed by GREEN preserved. Reviewer independently reran runtime contract. |
| C2 | pass | Scoped diff has no skipped/focused/deleted tests, lowered property count or new suppression. |
| C3 | pass | Scoped deleted-file list empty; no new SQL migration. |
| C4 | pass | Money remains decimal strings/Money/Decimal; Number.isNaN concerns date milliseconds only. |
| C5 | pass | No posted-row mutation; test lifecycle calls posting engine. |
| C6 | pass | No secrets/env or new golden edits; historical exact scanner exceptions have separately recorded owner approval. |
| C7 | pass | Task-specific feature branches and task-tagged conventional commits; no main push in reviewed work. |
| C8 | pass | No new runtime dependency; apk updates existing OS packages, mechanism recorded RQ-0099/DL-0309. |
| C9 | pass | Relevant DL0309–0313 and accounting ADR0051 record decisions; accounting delegation is explicit. |
| C10 | pass | RQ0099/RQ0133 resolved; persona card has no open research requirement. |
| C11 | pass | T0057 manifest links module/API/remittance reports, including da5d6ec results; runtime/security reports are present. |
| C12 | fail | Current full verifier not green; independent full rerun requirement unmet. Finish/checkpoint metadata remains outstanding. |

## Required follow-up

Late CI evidence independently retrieved: run42731772383 full verifier is **13 PASS / 2 FAIL / 1 PENDING**. Gate9 evidence now passes; gate4 Approved-diff guard and gate12 blocked status fail; gate8 other-provider review is pending. Coverage passes73.39% vs72.22%. Security run42732423611 at persona metadata head a8bf5db68c67e4552e5c702910f3d2df93ee71c6 succeeds. These results supersede the earlier missing-manifest failure, not the product finding or independent-rerun limitation.

Resolve actual inherited golden approval provenance and complete verification on the final task head. Record this scoped independent technical approval without changing provider identity or treating it as full DoD PASS. Preserve historical failed evidence. Security ADR acceptance and releases remain owner gates.

