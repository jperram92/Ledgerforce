---
name: new-task-card
description: Use when adding LedgerForce backlog work - generating cards from a use case or design section, splitting a task that is too big (over ~2 hours or ~400 changed lines), recording follow-up work found during build or review, or replacing a card (supersede, never delete). Creates .agent/backlog/T-NNNN.md with the design §10.3 frontmatter and adds it to .agent/backlog/README.md.
---
# Skill: new-task-card

## Steps

1. Next id: `ls .agent/backlog | grep -E '^T-[0-9]{4}\.md$' | sort | tail -1` → +1, 4 digits.
2. Create `.agent/backlog/T-NNNN.md`:
   ```markdown
   ---
   id: T-NNNN
   title: <Module - imperative summary>
   phase: <MVP | Phase 1 | Phase 2 | Phase 3>
   use_cases: [UC-NN]
   depends_on: [T-NNNN]
   status: todo            # todo | claimed | researching | in_progress | verifying | review | done | blocked
   claimed_by: null        # provider: claude | codex
   lease_expires_at: null
   attempts: 0
   last_checkpoint: null   # last commit where tests passed
   adr_required: false
   research: []            # [RQ-NNNN]
   success_scenarios: []   # [<SS ids from Docs/specs/success-scenarios.md>]
   evidence: []            # evidence file names under .agent/evidence/T-NNNN/
   ---
   ## Goal
   <one paragraph: the user-visible outcome and the design § it implements>

   ## Acceptance criteria (each maps to a test)
   - AC-1 Given … When … Then … → `<test file path>`
   - AC-2 …

   ## Open questions
   - <anything unclear → becomes an RQ before in_progress>

   ## Steps (checked off as done)
   - [ ] 1. RED: acceptance tests for AC-1..n
   - [ ] 2. …

   ## Notes for the next agent
   ```
3. Quality checklist (all must hold):
   - fits one session (< ~2 h, < ~400 changed lines) — else split into several cards;
   - every criterion is machine-checkable and names its test file (layout in
     `Docs/process/tdd.md`);
   - posting behaviour names its `GP-NNN` golden posting; UI names its SS ids;
   - `depends_on` only points to existing cards of the same or an earlier phase; no cycles;
   - `adr_required: true` if design §10.6 applies;
   - no secrets, no model identifiers.
4. Add one row to `.agent/backlog/README.md` in dependency order, using the same columns as the
   existing table header.
5. **Replacing or splitting** a card: never delete it. Set the old card `status: blocked` with
   the note `Superseded by T-MMMM[, T-KKKK]` in *Notes*, and make the new cards' *Goal* say
   `Supersedes T-NNNN`. Update both index rows.
6. Log the reason for new/split/superseded cards (skill `log-decision`, category `scope` or
   `process`), and checkpoint if a task is active, else commit
   `docs(backlog): add T-NNNN <title>`.
