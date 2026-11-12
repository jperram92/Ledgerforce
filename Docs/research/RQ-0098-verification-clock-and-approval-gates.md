---
id: RQ-0098
title: Verification fixture timestamps and inherited golden approvals
status: resolved
opened: 2026-11-12
resolved: 2026-11-12
opened_by: codex
linked_tasks: [T-0048]
linked_adrs: []
superseded_by:
---

# RQ-0098 — Verification fixture timestamps and inherited golden approvals

## Questions

Why did one complete database run pass while the verifier failed at user-role fixture setup? Why does the golden guard reject previously approved postings?

## Sources consulted

| Source | Accessed | Kind | Finding |
|---|---|---|---|
| [PostgreSQL 16 current date/time](https://www.postgresql.org/docs/16/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT) | 2026-11-12 | primary | `now()` is transaction start time and stays constant in that transaction. |
| `packages/db/migrations/0016_auth_roles_permissions.sql:31-38` | 2026-11-12 | source | Grant timestamp defaults to database `now()`; revocation must be at least the grant timestamp. |
| `apps/api/src/users/users.list.db.test.ts:74-83` | 2026-11-12 | source | Fixture inserts a grant then revokes it using the separate JavaScript clock. |
| `.agent/evidence/T-0048/verify-20261111-r03-serial.log` | 2026-11-12 | experiment | Setup failed at `user_role_check2`; a separate complete DB suite passed 1,178 tests. |
| `scripts/agent/lib/gates.ts:122-137`, DL-0256, DL-0263, AGENTS.md section 6 | 2026-11-12 | source | Guard compares against main and rejects every newly Approved marker, without consulting the recorded owner approval or delegation. |

## Findings and conclusion

1. Fixture failure is consistent with clock precision/skew between Windows JavaScript and WSL PostgreSQL (inference); the constraint is correct. Use database `now()` for revocation in the same transaction as the default grant timestamp. Keep the constraint, revoked grant, API assertions, and all tests unchanged.
2. The golden failure is inherited from approved ancestor changes, not a new edit in T-0048. The current guard has no supported approval-evidence input. Do not change golden contents, alter the comparison base, suppress the failure, or pretend this gate passed. Any approval-aware gate extension must retain fail-closed checks and independently tested rejection of unapproved content changes.
3. The lint coverage timeout is not evidence of a lint-rule defect; rerun the unchanged coverage command on an idle host before changing anything.
