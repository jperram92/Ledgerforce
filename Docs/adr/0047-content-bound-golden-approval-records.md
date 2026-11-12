---
adr: 0047
title: "Content-bound records of existing golden approvals"
status: Proposed
date: 2026-11-12
author: codex
category: process
human_gate: no
supersedes: none
superseded_by: none
---

# ADR-0047: Content-bound records of existing golden approvals

## Status
Proposed — acceptance requires green CI and cross-provider review. Does not supersede ADR-0012's approval requirement or authorize new accounting expectations.

## Context and problem statement
Design section 10.8 requires approved golden expectations. The diff-only guard rejects even the owner-approved ancestor changes in DL-0256 and DL-0258. RQ-0099 identifies the missing approval representation.

## Decision drivers
- Recognize documented approvals without changing comparison bases or bypassing the gate.
- Keep approved expectations immutable and failures actionable.
- Preserve repository-only resume and independent review.

## Considered options
1. Keep rejecting every approved ancestor change: conservative but cannot represent authorized work.
2. Environment flag or broad path exemption: easy but permits unapproved edits; rejected.
3. Content-bound approval records with decision evidence: narrow, reviewable, and mutation-testable.

### Option A — Diff-only rejection
Good: simple. Bad: recorded approval has no machine-checkable representation.

### Option B — Bypass flag
Good: operationally convenient. Bad: weakens approval and immutability; rejected.

### Option C — Explicit records
Good: exact approved snapshots, ancestor and evidence validation. Bad: record authority still requires human/cross-provider review, like other repository decisions.

## Decision outcome
Use `Docs/decisions/golden-approvals.json` schema version 1 with records `{path, commit, decisions}`. Paths are Markdown files below `Docs/accounting/`; commits are full ancestor IDs; decision IDs must exist as headings in that commit's decision log. Reject malformed/duplicate records. Compare current file to the committed snapshot exactly after CRLF normalization only. Files without records retain the original guard. A recorded file must still be checked even if Git considers it unchanged or deleted.

At least one cited decision must be introduced in the approval commit, preventing a new content snapshot from recycling an earlier decision. Records do not override the existing prohibition on changing a file already Approved at the comparison base. The initial record covers only existing DL-0256 approval and DL-0258 supersession. Future records require the same approval authority as the golden entries themselves and an independent review; adding a record does not grant that authority.

### Amendment 2026-11-12 (claude, after cross-review C6; DL-0400)
A record suppresses the guard only if the identical record (same path, commit and decisions) is already committed in `golden-approvals.json` at the comparison base, i.e. it reached main through the owner's merge. A record added or changed on the branch is a claim by the branch's author: the original "adds an Approved status" failure stands, with an extra line saying that new approval records require the product owner's merge to main. This closes the self-attestation path, where a branch adds an Approved marker, a decision claiming owner approval and a record pointing at its own commit (reproduced in `.agent/evidence/T-0121/review-repro-self-approval.txt`). Tests: `golden-approvals.test.ts` cases 12–14.

## Consequences
### Good
- An already approved file passes, while one-byte mutations, stale snapshots, invalid evidence and missing files fail.
- No new runtime dependency, approved golden edits, or CI security changes.

### Bad / accepted trade-offs
- Whole-file snapshots are conservative: even a draft append needs a reviewed refreshed record.
- Git objects and full history must be available. Missing history fails closed.
- This is a process evidence check, not signature verification or protection against a malicious reviewer.

### Follow-ups
- T-0121: tests, implementation, full verification and independent review.
- T-0048: rerun applicable verification and obtain Claude review.

## Compliance and verification
| Check | Where | Gate |
|---|---|---|
| Recorded unchanged snapshot passes; unauthorized edits fail | scripts/agent/test/golden-approvals.test.ts | 4 |
| Missing/invalid/duplicate approval evidence fails | same test file | 4 |
| Existing no-record semantics preserved | scripts/agent/test/scripts.test.ts | 4 |
| No approved posting changes | Git diff plus review | 4, 8 |

## Links
- RQ-0099; ADR-0012; DL-0256; DL-0258; DL-0263; T-0121.
