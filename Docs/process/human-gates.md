# Human gates

The product owner is consulted **only** for the gates in `AGENTS.md` §6, configured in
`.agent/config.yaml → human_gates: [adr:accounting, adr:security, release, golden_postings,
phase_gate, out_of_scope]`. Everything else agents research and solve themselves
(`AGENTS.md` §0.4–0.5). Loop: [loops.md §11](loops.md#11-human-gate-escalation-loop).

## 1. When to consult the product owner

| Gate (= PR label) | Consult when | What the agent prepares | What stays blocked |
|---|---|---|---|
| `adr:accounting` | An ADR with `category: accounting`: any accounting treatment (which accounts, debit/credit, tax treatment, period/close rules, rounding policy, revenue recognition) | ADR `Proposed` with options, sources (RQ), recommendation | Code depending on it can be written test-first on the branch, but the task cannot be `done` |
| `adr:security` | An ADR with `category: security`: auth flows, roles/permissions, SoD rules, encryption/key handling, tenant-isolation model, audit/retention | ADR `Proposed` + security-reviewer report | Same as above |
| `golden_postings` | Creating a new golden posting or changing an existing one in `Docs/accounting/postings.md` (and any doubt about an Approved one) | `GP-NNN` section `Draft (proposed by …)` + RQ + entry under *Open questions for accountant* | Criteria using that posting |
| `release` | Any release/tag, publishing a package (npm, AppExchange, container image) or making the repository public | Release notes draft, CHANGELOG, verify report | The release itself |
| `phase_gate` | Moving from one phase to the next (design §9 exit criteria: MVP → Phase 1 → …) | Exit-criteria checklist with evidence links | Cards of the next phase |
| `out_of_scope` | Anything outside the solution design's scope (design §1 *Scope boundaries*), or a choice listed in design §11.2 that has not been made yet: product name, licence, first market, delivery model, invoice-trigger default, SoD thresholds, agent budget / parallel builds | Scope note or RQ with options and a recommendation | The affected cards |

Also gated by `AGENTS.md` §0 / §5 (never do, so never "ask to do"): editing `.env*` or secrets,
CI security gates, Approved golden files; deleting anything; pushing to `main`.

## 2. How to consult (headless-safe, no chat needed)

All four steps, always — the human reads the repository and the PR, not your session.

1. **Prepare the decision** in the right file: ADR (`write-adr`), golden posting proposal
   (`golden-posting`), or RQ (`research`) with options, sources and a recommendation. Log it with
   `log-decision`, status `proposed (awaiting human)`.
2. **HANDOVER entry** — `.agent/HANDOVER.md` → *Open questions for human*, one bullet per
   question:
   ```markdown
   - [<gate>] <T-NNNN> <question in one sentence>
     Options: A) … B) …  Recommendation: A because …  See: Docs/adr/NNNN-….md, RQ-NNNN
   ```
3. **PR label** — open (or update) the task PR and add the gate label:
   `gh pr edit <number> --add-label <gate>` (e.g. `golden_postings`, `adr:accounting`). If no PR
   exists yet, create a draft PR from the task branch.
4. **Block the task** —
   `node scripts/agent/conductor.ts release T-NNNN --status blocked --reason "human gate: <gate> — <question>"`,
   and put the same text in the card's *Notes for the next agent*. Then continue with other
   eligible work. In headless mode never wait for input.

**When answered** (ADR status changed to Accepted/Rejected by the human, golden posting marked
Approved, label removed, or an answer in the PR/HANDOVER): the next session records a DL entry
`By: human`, removes the question from HANDOVER (keeping it in the run log), sets the card back
to `todo`, and the task continues.

## 3. Things agents must solve themselves (never escalate)

- Unclear external APIs, limits or formats (Salesforce, Stripe, ABA, bank files, Peppol) →
  research with sources, spike, decide, log.
- Missing libraries or tools, or a library that doesn't do what is needed → build an adapter or
  module inside the project scope; dev-only tooling → DL entry; runtime dependency → ADR
  (non-accounting/security ADRs are accepted on green CI + cross-review).
- Environment problems: no Docker (use the local `initdb`/`pg_ctl` harness, DL-0007), missing
  binaries, network/proxy issues, flaky tests (find the root cause; never skip).
- Failing tests, type errors, lint errors, performance problems, refactoring, naming, file layout,
  test design, fixture recording, CI configuration other than security gates.
- Choosing between technical options that do not change accounting treatment, the security model
  or scope (e.g. Kysely query shape, component structure, error format) → decide + DL entry
  (+ ADR if design §10.6 applies).
- Splitting, re-ordering or adding backlog cards within scope.
- Provider failures, credit/quota limits → handover and failover (the conductor handles it).
- Disagreements between providers in review → reasoned DL entry; escalate only if the subject
  itself is a gate.

If unsure whether something is a gate: it is a gate only if it fits a row in §1. Otherwise solve
it and log the decision.
