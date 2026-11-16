# T-0192 — security review of the design and the builder's diff (claude, acting as security-reviewer)

This is the security-reviewer pass that the card asks for on the **design** (ADR-0087) and on the
builder's own diff. It is **not** the cross-provider review: that is still owed (card step 5), by
the other provider, under `.claude/agents/reviewer.md`.

Scope: commits 58a227d..HEAD on `feat/T-0192-session-rotation`.
Changed files: `apps/api/src/auth/session.service.ts`, `apps/api/src/auth/oidc.service.ts`,
`apps/api/src/auth/login.controller.ts`, the tests, and docs.

| # | Check | Verdict | Evidence |
|---|---|---|---|
| 1 | Tenant isolation | pass | The diff adds no table and no migration (migration 0073 was not needed). `rotateInTx` runs inside the callback's `withTenant(tenantId)` transaction. The session insert takes `tenant_id` from `app.tenant_id` (the default in 0004). The RLS policy `WITH CHECK` stays in force. `app.session` is already in the cross-tenant suite. |
| 2 | Roles | pass | The app connects as `lf_app` (`createApi` with `tdb.url('lf_app')` in the tests). It needs only INSERT and UPDATE on `app.session`, which 0004 already grants. Nothing is deleted. |
| 3 | Money movement controls | pass | Step-up routes are unchanged. A request with the old cookie that races the rotation sees the pre-step-up `auth_time`: 401 `step_up_required` (SS-PLAT-136). `bank_detail_step_up_fresh` re-checks `revoked_at IS NULL` on the principal's session. |
| 4 | Secrets | pass | The new secret is 32 bytes from `randomBytes`. Only its SHA-256 is stored. The cookie values in the e2e fake are fixed test strings, not secrets. No `.env*` file was read. |
| 5 | Input and transport | pass | The new cookie gets the login's attributes: HttpOnly, SameSite=Lax, Secure in production, Path=/ (asserted in SS-PLAT-135). `return_to` keeps the existing open-redirect guard. The callback still requires the `lf_oidc` binding, state, nonce, PKCE and `max_age`. Before rotation it still checks the same session cookie and the same user. |
| 6 | Ledger and audit | pass | The audit log stays insert-only. The `step_up` row names the new session and `rotated_from` the old one. The old row is revoked with reason `rotated` and never deleted. |
| 7 | Dependencies | pass | No new dependency. `pnpm audit --prod` was not run (no dependency change). |
| 8 | Logs | pass | No new log lines. Session secrets are never logged. |

Design findings (ASVS 5.0 7.2.4, OWASP Session Management cheat sheet; see RQ-0169):

- **Lifetime.** The rotation cannot extend a session. The new row copies `absolute_expires_at`, the idle timeout and the session epoch from the old row (tested: the 12-hour cap and a later revoke-all both end the rotated session).
- **Old row already ended.** `rotateInTx` updates the old row with `WHERE revoked_at IS NULL`. If that row was already revoked, the callback answers `invalid_request` and issues no cookie.
- **Concurrency.** There is no grace period. Linearisation happens at commit. A pre-commit reader cannot see the new `auth_time`, because it lives only on the new row, whose secret only the callback response carries. I rejected locking ordinary requests (`FOR SHARE`): it would make every request write the row, and it could deadlock with the idle touch.
- **Residual risk (accepted, ADR-0087 consequences).** A second-tab request sent with the old cookie at the moment of commit gets 401 and the person signs in again. Another in-flight step-up started from the old session fails with `invalid_request`. Both fail closed.
- **Dead code risk.** `reauthenticateInTx` (no rotation) remains as a test fixture used by three api-db suites. It has no production caller (grep below). A future caller would bypass ADR-0087. The cross-reviewer should confirm the doc comment is enough, or open a follow-up to move it into the test helpers.

Verdict: **PASS** (design and diff). Cross-provider review is still required.

Commands: `grep -rn "reauthenticateInTx" apps/api/src --include=*.ts | grep -v "\.test\.ts"` (only the definition remains); the test commands are in the card and in the commit bodies.
