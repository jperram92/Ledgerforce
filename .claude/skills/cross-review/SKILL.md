---
name: cross-review
description: Use when a LedgerForce task card is in status review and you are NOT the provider that built it (claimed_by), to perform the cross-provider review - claude reviews codex's work and codex reviews claude's - against the full checklist in .claude/agents/reviewer.md, producing a pass/fail/unclear report per item.
---
# Skill: cross-review

`.agent/config.yaml` → `review: cross_provider`. The full checklist, commands and report format
live in `.claude/agents/reviewer.md` — act as that role.

## Steps

1. Eligibility: read the card frontmatter `claimed_by`. If it equals your provider, stop — you
   may not review your own provider's work; run skill `run-log` and end.
2. Check out the task branch without altering it: `git switch feat/T-NNNN-<slug>`;
   `git status --short` must be clean.
3. Read `.claude/agents/reviewer.md` completely and follow its *Procedure* steps 1–6 exactly:
   run the gates, run the shortcut/deletion/ledger-bypass/float searches, answer every item
   A1–A8, B1–B12, C1–C12 with **pass / fail / unclear** + reason + evidence.
4. Write the report to `.agent/evidence/<T-ID>/review-<your-provider>-<YYYYMMDD-HHMMSS>.md`
   (UTC) and commit it: `git add .agent/evidence/T-NNNN && git commit -m "docs(review): cross-review <PASS|FAIL> [T-NNNN]"`.
5. If a PR exists (`gh pr list --head feat/T-NNNN-<slug>`), post it:
   `gh pr review <number> --comment --body-file .agent/evidence/T-NNNN/review-<…>.md`.
6. Verdict handling:
   - **PASS** → add `Cross-review PASS by <provider>: <report file>` to the card's *Notes*. The
     builder (or whichever provider resumes) finishes: success-scenario register, run log,
     `node scripts/agent/conductor.ts release T-NNNN --status done`.
   - **FAIL** → add each failing item as an unchecked step in the card, set
     `status: in_progress`, record in `.agent/HANDOVER.md` *Next action*: "fix review items …".
   - **NEEDS-HUMAN** → `Docs/process/human-gates.md` procedure; card `blocked`
     (`node scripts/agent/conductor.ts release T-NNNN --status blocked --reason "<gate>"`).
7. Run skill `run-log`.
