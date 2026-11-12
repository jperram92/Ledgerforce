---
adr: 0052
title: "Use an independent Codex reviewer for the current pickup review batch"
status: Accepted
date: 2026-11-10
author: codex
category: process
human_gate: yes
supersedes: none
superseded_by: none
---

# ADR-0052 — Owner-authorized independent Codex review

## Context

AGENTS.md normally requires a different provider for cross-review. Claude Code is installed at
the user's local binary path but reports no authenticated session. When asked to sign in for the
prepared reviews, the owner instructed that the review be done in Codex instead (DL-0321).

## Decision

For T-0057, T-0166 and T-0167 in this pickup batch, use a separate Codex reviewer with its own
review context. Builder `/root` must not author or approve that review on the reviewer's behalf.
The reviewer receives the repository, immutable commit references and actual test evidence,
checks the code independently and reports failures and verification limits without pressure to pass.

The report must identify provider Codex and the independent review agent. It must distinguish
technical findings from remaining automation, accounting approval, security and release gates.
Do not relabel it Claude/human or invent tests. No general review policy or security gate is
changed by this task-specific owner exception.

## Consequences

The requested review can proceed without Claude authentication. Same-provider correlated errors
remain a limitation; independent context and exact test evidence help but do not eliminate it.
The automated cross-provider check may remain PENDING because it has no owner-exception model.
That is an explicit tooling discrepancy, not permission to report all CI checks green.

## Acceptance and scope

Accepted on the owner's explicit 2026-11-10 instruction. This ADR records a bounded exception to
the provider requirement, not an edit to AGENTS.md's standing directives for unrelated work.
Accounting/security approvals, production releases and phase gates are unaffected.
