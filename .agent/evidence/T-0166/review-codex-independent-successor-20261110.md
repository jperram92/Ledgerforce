# T-0166 successor repair — scoped technical review PASS

Reviewer: codex, independent agent `/root/independent_review`. Builder: codex, `/root`.
Date: 2026-11-10 UTC. Owner exception: ADR-0052 / DL-0315.

This report supplements, and does not overwrite, `review-codex-independent-20261110.md`.
It closes that report's MAJOR effective-golden-selection finding for the exact repair below.
It is not full definition-of-done approval, a different-provider review, accounting/security
acceptance, or approval of unrelated single-supply work.

## Reviewed snapshot

Working changes above HEAD `00e87c525120b07921758da6037fb6fdde131545`, on
`feat/T-0166-golden-successor-review`. File SHA256 values were identical before and after the
successful independent test run:

| File | SHA256 |
| --- | --- |
| packages/ledger/src/golden/postings.ts | 2695E4163D7BBD522D4357D269FE8C93D359E61BE16593FB2672E02F601C1DD4 |
| packages/ledger/src/golden/postings.test.ts | DCFACCF95D39893D58C0FDCB1E99230AE3245C2FEB0940BF8789EC5F0F28D2F6 |
| packages/ledger/src/golden/golden-postings.golden.test.ts | 65DB29E03C3ADA8937E75549A3F5DE5023A4C07F0416A9BD1DAB5783C9E9A0EC |

## Findings

No blocking defect found in the scoped repair. An explicit whole-entry supersession declaration
in an Approved successor now produces an effective `superseded` predecessor with its forward
link, retaining the predecessor's journal tables. GP-038 is excluded from current replay;
GP-039 remains active. The real inventory now expects 31 active entries and 39 current journals.
This corrects selection rather than weakening journal comparisons. The approved source file
has no working diff.

Authority and malformed-input checks inspected:

- Only Approved successors grant retirement authority. Draft successors leave predecessors
  active and still cause the existing draft gate to refuse execution.
- Exact bold `Supersedes GP-NNN` or `Supersedes GP-NNN for current implementation:` declarations
  are recognized. Partial-wording prose such as GP-038's GP-024/025 note does not retire entries.
  Unrecognized/malformed declaration syntax grants no retirement authority; this change does
  not introduce a general markdown validator.
- Missing, self and forward predecessor references fail explicitly. A Draft predecessor is
  also rejected by the implementation (not a separately executed test case in this review).
- Conflicting successors fail instead of selecting one. Existing predecessor forward-link
  conflicts are checked. A consistent existing link remains valid.
- Successive approved replacements preserve intermediate history while excluding both
  predecessors from current replay. Requiring an earlier predecessor prevents cycles in the
  new declaration graph. This does not newly validate every legacy status-line graph.
- The historical identical-journal fallback retains the effective supersession state.

The new tests exercise preserved historical tables, current selection, draft authority,
partial notes, chains, conflicts and missing/self/forward references. Existing golden tests
exercise the actual GP-038/039 declaration and preserve other approved journal checks.

## Validation actually performed

| Command / evidence | Result |
| --- | --- |
| Read product diff, new tests, builder RED/GREEN evidence | RED records 9 failed / 4 passed; builder GREEN records 13 passed |
| Independent `corepack pnpm exec vitest run --project unit packages/ledger/src/golden/postings.test.ts packages/ledger/src/golden/golden-postings.golden.test.ts`, first attempt | Exit 1: new suite could not parse postings.ts, unexpected EOF at line277; five existing golden tests passed |
| Same independent command, retry after checking complete source and hashes | Exit 0: 2 files passed, 13/13 tests passed, 2.18 seconds |
| `git diff --check` | Exit 0 |
| `git diff --numstat -- Docs/accounting/postings.md` | Empty: no approved golden source edit |
| SHA256 before/after successful run | Identical values listed above |

The first run overlapped builder formatting. A partial file during that write is a plausible
explanation for the transient EOF, not a proven root cause. It was reported immediately;
the complete unchanged source subsequently passed. The failed attempt is not omitted or
represented as a successful run.

## Review checklist delta and remaining gates

A4's effective-selection defect is resolved for this snapshot. C1/C2/C3/C6 pass for the repair:
RED preceded production, tests were added rather than skipped, no tracked source was deleted,
and approved golden text was not edited. No money, ledger-write, tenant-schema, permission or
dependency behavior changes. The other findings/limitations in the initial report remain;
this is a focused correction review, not a repeated broad approval.

The builder's typecheck/lint/format completion was not independently rerun here. New real
golden-engine DB, gross-allowance lifecycle and full CI/verification results are still required
on the committed repair head. Earlier product CI predates this parser change and cannot prove
the new head. The inherited golden provenance guard, memory/finish gates and automated
different-provider discrepancy are not waived. Preserve both review reports as evidence.
