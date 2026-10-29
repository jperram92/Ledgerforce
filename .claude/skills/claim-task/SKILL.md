---
name: claim-task
description: Use when no task is active (state.json current_task is null) or the current one is done or blocked, to pick the next eligible LedgerForce backlog card (first todo whose depends_on are all done), claim it with a lease through the conductor and create its branch.
---
# Skill: claim-task

## Steps

1. Open `.agent/backlog/README.md`. Walk the index **in order** and pick the first card with
   `status: todo` whose every `depends_on` card has `status: done`. Verify by reading each
   dependency card's frontmatter, not only the index.
   - Skip cards whose phase is later than the current phase in `.agent/state.json` (`phase`).
   - If none is eligible, run the `handover` skill with reason `backlog empty or all blocked`
     and stop.
2. Claim it (writes `claimed_by`, lease, attempts to the card and `.agent/state.json`, and
   records the task branch):
   ```bash
   node scripts/agent/conductor.ts claim T-NNNN --provider <claude|codex>
   ```
   If the command fails because the lease is held, pick the next eligible card.
3. Confirm the branch is `feat/T-NNNN-<slug>`: `git branch --show-current`. If the conductor
   did not switch to it, run `git switch feat/T-NNNN-<slug>` if it exists, otherwise
   `git switch -c feat/T-NNNN-<slug>` (slug = card title in kebab-case, ≤ 5 words). Never work
   on `main`.
4. Read the whole card. Check:
   - every acceptance criterion is machine-checkable and maps to a test; if not, fix the card
     (skill `new-task-card` rules) before coding and log the change (skill `log-decision`);
   - `research:` — any RQ with `Status: open`, or any *Open questions* → set
     `status: researching` in the card and go to skill `research`;
   - `adr_required: true` → skill `write-adr` before code;
   - posting behaviour → skill `golden-posting` (the golden posting must be **Approved**);
   - `success_scenarios:` exist in `Docs/specs/success-scenarios.md`.
5. When the research gate is clear, set `status: in_progress` in the card frontmatter and
   record the plan as numbered *Steps* (`- [ ] 1. …`).
6. Checkpoint the claim and plan:
   ```bash
   node scripts/agent/conductor.ts checkpoint T-NNNN --step "0/n — claimed, plan written"
   ```
7. Continue with skill `tdd-cycle` (or `research`).
