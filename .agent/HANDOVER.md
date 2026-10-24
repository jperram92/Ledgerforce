# Handover - 2026-10-24 07:45 UTC
From: claude (lead session, sprint-0 run r01)    Reason: in progress — sub-agents resumed after usage-limit stop (HTTP 429 at ~07:2x UTC, reset 07:30 UTC)
Task: Sprint 0 framework (T-0001..T-0009)
Branch: claude/app-framework-agents-dzmkya   Last green commit: n/a (sprint-0 scaffolding; per-task green commits start at T-0010)

Done:
- AGENTS.md / CLAUDE.md / .agent/config.yaml / state.json (T-0002)
- ADRs 0001-0015, decision process, CHANGELOG, PR/issue templates (T-0004)
- UC-01..12 specs, success-scenario register (121 SS), backlog T-0001..T-0102, golden postings DRAFT GP-001..019 (T-0006, T-0007)
- 11 sub-agents, 16 skills, 12 process loops, TDD / DoD / human-gate docs, nested AGENTS.md, .agents/skills bridge (T-0002)
In progress (wip commit 2089650):
- T-0003 conductor + failover loop (scripts/agent) — tests were green, finishing alignment with definition-of-done.md
- T-0005 research pack — RQ-0001..0005 written; RQ-0006..0012 + index pending
- T-0008 scaffold + DB harness — migrations/src written; root tooling + full green run pending
- T-0009 UI principles + mockups — mockups 01-07 written; 08-12, index, principles.md pending
Next action: when each finishes, commit per task id, append its DL entries to Docs/decisions/decision-log.md, run `bash scripts/agent/verify.sh --quick`, then publish the UI principles page for the product owner.
Decisions taken: DL-0001..DL-0023 (see decision log)
Open questions for human:
- Approve golden postings GP-001..019 and answer accountant questions Q1-Q11 (Docs/accounting/postings.md) — blocks T-0031 and all posting work
- Accept/reject Proposed ADRs 0003, 0004, 0005, 0006, 0007, 0009 (licence), 0010
- Design §11.2 open decisions: product name, licence, first market, delivery model, invoice trigger default, SoD thresholds, agent budget/parallelism
- UC-12 LWC: MVP (§8.2) vs Phase 1 (§9.1) — carded as MVP T-0072 pending confirmation
- Research findings that contradict the design (Docs/research/RQ-0012, RQ-0004, RQ-0009) — need your call:
  1. CDC entity cap is 5 without add-on; design §5.3 lists 8 (proposal DL-0030: poll Order/OrderItem/ACR)
  2. ATO rounds GST at invoice total, design §3.4 says per line (proposal DL-0032)
  3. Customer prepayment GST timing on accruals basis (postings.md Q7)
  4. Ledger-bypass holes found in the DB pattern (proposal DL-0028)
  5. MVP items depending on Phase 1 capabilities (UC-12 LWC, UC-05 bill capture, UC-10 BAS, Xero import in wizard)
  6. SoD gaps: AP clerk self-approval below $1,000; nobody owns supplier creation; first-time bank details unverified
Do not: change Docs/accounting golden files; delete anything; push to main.

## Log
- 2026-10-24 04:00 control files committed (d64eb32)
- 2026-10-24 ~07:2x 4 sub-agents stopped by usage limit; checkpointed 2089650; resumed 07:45 after reset — failover-by-repo-state worked as designed
- 2026-10-24T08:18:05.120Z human: release T-0001 → review (full verify.sh green 2026-10-24 (11 PASS, 0 FAIL); awaiting codex cross-review (DL-0053))
- 2026-10-24T08:18:05.272Z human: release T-0002 → review (full verify.sh green 2026-10-24 (11 PASS, 0 FAIL); awaiting codex cross-review (DL-0053))
- 2026-10-24T08:18:05.436Z human: release T-0003 → review (full verify.sh green 2026-10-24 (11 PASS, 0 FAIL); awaiting codex cross-review (DL-0053))
- 2026-10-24T08:18:05.560Z human: release T-0004 → review (full verify.sh green 2026-10-24 (11 PASS, 0 FAIL); awaiting codex cross-review (DL-0053))
- 2026-10-24T08:18:05.687Z human: release T-0005 → review (full verify.sh green 2026-10-24 (11 PASS, 0 FAIL); awaiting codex cross-review (DL-0053))
- 2026-10-24T08:18:05.819Z human: release T-0006 → review (full verify.sh green 2026-10-24 (11 PASS, 0 FAIL); awaiting codex cross-review (DL-0053))
- 2026-10-24T08:18:05.954Z human: release T-0008 → review (full verify.sh green 2026-10-24 (11 PASS, 0 FAIL); awaiting codex cross-review (DL-0053))
- 2026-10-24T08:18:06.103Z unknown: T-0009 → in_progress
- 2026-10-24T08:18:48.097Z human: release T-0009 → blocked (human gate: product owner to choose UI direction from the UI/UX research agent's three options (DL-0052); evidence harness part is complete)
