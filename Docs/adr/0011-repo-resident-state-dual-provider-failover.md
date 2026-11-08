---
adr: 0011
title: "Repository-resident agent state with dual-provider failover (claude primary, codex failover and cross-review)"
status: Accepted
date: 2026-10-24
author: claude
category: process
human_gate: no
supersedes: none
superseded_by: none
---

# ADR-0011: Repository-resident agent state with dual-provider failover (claude primary, codex failover and cross-review)

## Status

Accepted — 2026-10-24. Design-committed (D6, §10.1–§10.5); process category. Built in Sprint 0
(conductor, state files, handover protocol). The open part of §11.2 — agent budgets and whether
parallel builds are allowed — is *not* decided here: `parallel_tasks: 1` until the human decides.

## Context and problem statement

The build is run by AI agents from two providers (D6). Any session can stop without warning:
credit exhausted, HTTP 429 / quota, provider outage, context limit (§10.4, risk "provider
outages or price changes", §11.1). If task progress lives in a chat session, the work is lost
and the next agent starts from scratch or, worse, re-decides things differently. The product
owner's first directive is "the repository is the only memory". We also want code produced by
one model family reviewed by another, because correlated blind spots of a single model are a
real risk for accounting code (§11.1 first risk).

## Decision drivers

- Any provider must resume any task from a git checkout alone (§10.1 principle 1, §11.3 item 9).
- A dead session must lose minutes, not hours (§10.1 principle 4).
- Automatic failover on quota/credit errors, no human needed.
- One rule set for both providers (DL-0002).
- Independent review from a different model family.
- Failover must work even if `pnpm install` is what broke (DL-0005).

## Considered options

1. **Repo-resident state (`.agent/state.json`, task cards with leases, `HANDOVER.md`, run logs)
   + a conductor that fails over claude → codex on the same branch from `last_checkpoint`;
   cross-provider review.**
2. **Single provider, manual restart by the human on failure.**
3. **External orchestration service / database holding task state** (e.g. a hosted agent
   platform, issue tracker as state).
4. **Two providers working independently without shared state** (each owns separate tasks,
   no handover).

### Option 1 — Repo-resident state + failover

- Good, because state is versioned, reviewable and travels with the branch; any provider reads
  the same files.
- Good, because leases + heartbeat detect dead sessions; `wip/` commits preserve uncommitted work.
- Good, because cross-provider review gives model diversity for free.
- Bad, because state files can conflict if two sessions write simultaneously (mitigated by
  leases and one branch per task, `parallel_tasks: 1`).
- Bad, because agents must be disciplined about checkpointing (enforced by skills and conductor).

### Option 2 — Single provider, manual restart

- Good, because simplest.
- Bad, because the build stalls whenever credits or quota run out; single point of failure;
  no cross-model review.

### Option 3 — External state service

- Good, because richer dashboards.
- Bad, because another system to authenticate from both CLIs; not in the checkout; violates
  "repository is the only memory".

### Option 4 — Independent providers

- Good, because no coordination needed.
- Bad, because no resume of each other's work and no review; duplicated decisions.

## Decision outcome

Chosen option: **Option 1**.

- Canonical rules in `AGENTS.md`; `CLAUDE.md` imports it (DL-0002).
- State: `.agent/config.yaml` (human-owned; providers, `failover_order: [claude, codex]`,
  `lease_minutes: 45`, `max_attempts_per_task: 3`, failure patterns), `.agent/state.json`,
  `.agent/backlog/T-NNNN.md` (front-matter lease fields), `.agent/HANDOVER.md`,
  `.agent/runs/<date>-<run>.md`.
- Conductor `scripts/agent/conductor.ts` (zero-dependency Node.js, DL-0005) launches
  `claude -p` or `codex exec`, watches exit code, output patterns and heartbeat; on quota/credit
  failure writes the reason to HANDOVER, releases the lease, commits uncommitted work to `wip/`,
  and starts the next provider on the same branch from `last_checkpoint`. After 3 failed
  attempts across providers the task is `blocked`.
- Review: work by one provider is reviewed by the other (`review: cross_provider`).
- No model identifiers in repo config; providers are named `claude` and `codex` (DL-0006).

## Consequences

### Good

- Build continues through provider outages and credit limits; full audit trail of who did what.

### Bad / accepted trade-offs

- Process overhead (checkpoints, handovers, run logs) on every session.
- Two CLIs to keep working in CI/conductor; both providers' costs to budget.

## Compliance and verification

| Check | Where | Gate |
|---|---|---|
| Conductor unit tests: quota pattern ⇒ failover to next provider; hang past lease ⇒ failover; `blocked` written ⇒ stop; success ⇒ finish; 3 attempts ⇒ blocked | `scripts/agent/test/*.test.ts` with fake provider scripts (`fixtures/bin/fake-quota.sh`, `fake-hang.sh`, …) | `node --test` in verify.sh |
| `resume.sh` prints HANDOVER, state, active card, open RQs, recent decisions from a fixture repo | scripts test | verify.sh |
| Resume drill: a second provider completes a half-finished fixture task from repo only | Sprint 0 drill / review checklist §11.3 item 9 | review |
| No model ids in `.agent/config.yaml` | config lint test | verify.sh |

## Links

- Design: D6, §10.1–§10.5, §10.10, §11.1, §11.2 (agent budget, parallel builds), §11.3 item 9
- Decision log: DL-0002, DL-0005, DL-0006
- Related ADRs: ADR-0001, ADR-0012, ADR-0014
