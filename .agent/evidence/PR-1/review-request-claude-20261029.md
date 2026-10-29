# New independent review request — PR #1

Status: PENDING. This is a review request prepared by the builder (codex), not an independent review or approval.

Latest readiness: 405f794 has all CI checks passing, full verifier 13 PASS / 0 FAIL / 3 PENDING; T-0113 is ready for formal Claude review. Review its smoke repair and evidence separately from T-0103's unresolved Windows throughput issue. Re-run verify on the exact reviewed head and record pending gates honestly. The original combined-repair review request remains pending.

Update 2026-10-29: include e32bad1 (T-0113 setup-wait repair), its real-Docker RED/GREEN tests and subsequent evidence commit. Full install CI passed 7/7, static/unit, DB/RLS and e2e passed. Review scope now includes smoke.sh stopped-container selection, Docker exit-code handling and failure-log redaction. T-0113 is verifying with imported source CI evidence; full DoD still tracked separately. Pinned Windows conductor unrestricted run is 81/82 (atomic throughput 27 writes), all run/failover tests pass. Do not carry forward the superseded install failure below as a current failure; do retain the unresolved Windows issue. Still no independent approval.

## Copyable Claude continuation prompt

> Resume LedgerForce from the repository. Read AGENTS.md, .agent/HANDOVER.md and this request. Run `git status --short` and `git log -1 --format=full` on feat/T-0103-windows-heartbeat. Read .claude/agents/reviewer.md and .claude/skills/cross-review/SKILL.md. The builder is codex. Review the repairs after base 8bce763c05a9afe1657cd6125b90f3c286d6d35c, including commits 653bb06, ef0b4fc, feabf92 and the WIP commit containing this request. Record the exact reviewed HEAD. This work is not ready for formal approval: T-0103 has an atomic-write throughput failure, install smoke fails, full verification is incomplete, and the task is not in review status. First report findings without claiming the cross-review gate passes. After the builder resolves those failures and runs verify on the final head, perform the full A/B/C checklist and commit a separate review-claude report with evidence. Never approve your own subsequent fixes; return them for Codex review. Do not merge with failed CI or pending review.

## Scope and rationale

- T-0112: owner-authorized LF_EVIDENCE_DIR relocation in two workflows; actual posting outbox injection, fail-closed missing configuration and transaction rollback; Linux-native install-contract test; database-clock role fixtures. See DL-0236/0237 and run r02.
- T-0103: Windows Job Object host contains provider descendants before launch, retains a kill-on-close handle, and relays both output streams. POSIX process handling stays unchanged. Bounded atomic rename retry preserves the destination under sharing contention. See RQ-0014 and run r03.
- Browser evidence assertion: independently check the configured destination, including per-task isolation; retain filename, nonempty PNG and signature assertions.

## Validation and known failures

- At pushed feabf92: CI static/unit and database jobs passed; browser result 98 pass/1 fail due to the hard-coded evidence root. Full DoD skipped. PR has not merged.
- Browser regression: RED with explicit evidence root, then GREEN with explicit root and task-isolated root. Logs in .agent/evidence/T-0112/evidence-path-*.txt.
- Unchanged Windows heartbeat: RED at 25-second timeout, then GREEN around 13 seconds (20-second assertion unchanged). Logs in .agent/evidence/T-0103/.
- Full conductor: 81/82; atomic concurrent-reader test had 23 writes versus required >100, with no partial-read failure. Focused index rerun also fails (30 writes). All 19 run/failover tests passed in the full run.
- Earlier host Node 24.19.0; follow-up shell reports 24.7.0. Neither is pinned Node 22.22.0. Latest isolated atomic retry also fails (77 writes). A trial module-registration wrapper did not fix it and was reverted; no test deadline/count/assertion changed.
- Repository lint/typecheck passed. Full verifier and final-head CI have not passed.
- Install-smoke CI 40778054881: setup exited 0, but compose wait reported no containers after setup already stopped. Resolve using real stopped-container tests and Docker exit-code semantics. Failure-path setup log also needs password redaction; do not commit the raw CI log.

## Review focus

Check Job Object struct layout and ownership, fail-closed launch, descendant cleanup, stdout/stderr and stdin fidelity, quoting of paths/arguments, normal exits and quota failover. Check atomic replacement under sharing contention without deleting the original. Re-run tests on Windows and pinned Linux Node. Verify outbox/job atomicity and replay against the real database. Assess all original PR changes separately; this repair review cannot retrospectively approve the entire large PR.

The October 24 Claude report covers only 936b5ae/f7af6bb; it is not approval for these repairs. Claude CLI is unavailable in the current Codex environment. No review has been executed or sent on behalf of Claude.
