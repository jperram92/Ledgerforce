# Success-scenario register

**The** list of every success scenario (SS) LedgerForce must prove. A scenario is the "expected result defined
before build" (AGENTS.md §0.2): each one names the test layer that proves it and, for UI/report behaviour, whether
Playwright screenshot evidence is required.

- Use-case scenarios `SS-UCnn-mm` are defined in [UC-nn.md](README.md); platform invariants `SS-PLAT-nn` are defined here.
- Status values: `not-started` → `red` (failing test exists, fails for the right reason) → `green` (passes in CI on the task
  branch) → `evidenced` (merged, evidence linked, verified at the commit shown).
- Generated on 2026-10-24; totals recomputed from the rows on 2026-10-25. Totals: 148 scenarios (16 need screenshots).

## How to update (who, when)

| When | Who | What changes |
|---|---|---|
| Failing test written for an SS | builder, `tdd-cycle` skill (red step) | Test file path, status `red` |
| Test passes on the task branch | builder, `tdd-cycle` (green step) + `checkpoint` | status `green`, last verified commit |
| Evidence captured (report and, where "Screenshot = yes", PNGs) | builder, `evidence` skill | Evidence link (`.agent/evidence/T-NNNN/…`), status `evidenced` after merge |
| Task finished | `run-log`/finish step | Re-verify commit hash for every SS of the card |
| New scenario needed | `new-task-card` skill | Add a row (next free id; never renumber or delete — supersede instead) |
| Golden posting approved/changed | product owner | Golden-layer rows re-open to `red` until re-verified |

Rules: never delete a row; a scenario that is no longer valid is marked `superseded by SS-…` in the Scenario column.
A row may only be `evidenced` if its task's cross-provider review passed.

## Register

| SS id | Scenario | UC | Phase | Test layer | Screenshot | Test file | Task(s) | Status | Evidence | Last verified commit |
|---|---|---|---|---|---|---|---|---|---|---|
| SS-UC01-01 | Closed Won creates a draft invoice from the template | UC-01 | MVP | db-integration | no | — | T-0069 | not-started | — | — |
| SS-UC01-02 | Salesforce shows "Draft" within 60 seconds | UC-01 | MVP | e2e-playwright | yes | — | T-0069, T-0067 | not-started | — | — |
| SS-UC01-03 | Auto-approve under threshold posts GP-001 and emails | UC-01 | MVP | golden | no | — | T-0069, T-0040, T-0042 | not-started | — | — |
| SS-UC01-04 | Above threshold stays Draft | UC-01 | MVP | unit | no | — | T-0069 | not-started | — | — |
| SS-UC01-05 | No Billing To contact blocks approval | UC-01 | MVP | db-integration | no | — | T-0040 | not-started | — | — |
| SS-UC01-06 | Posting-profile gap flagged, not posted | UC-01 | MVP | unit | no | — | T-0039, T-0069 | not-started | — | — |
| SS-UC01-07 | Duplicate CDC event is idempotent | UC-01 | MVP | db-integration | no | — | T-0065, T-0069 | not-started | — | — |
| SS-UC01-08 | Closed Won dated in a hard-locked period follows lock policy | UC-01 | MVP | db-integration | no | — | T-0069, T-0023 | not-started | — | — |
| SS-UC01-09 | Salesforce outage does not block accounting | UC-01 | MVP | db-integration | no | — | T-0067 | not-started | — | — |
| SS-UC01-10 | Invoice detail shows mapped lines and journal preview | UC-01 | MVP | e2e-playwright | yes | — | T-0083 | not-started | — | — |
| SS-UC01-11 | Tax-inclusive rounding follows company setting | UC-01 | MVP | golden | no | — | T-0034, T-0040 | not-started | — | — |
| SS-UC02-01 | Preview lists all invoices, posts nothing | UC-02 | MVP | db-integration | no | — | T-0043 | not-started | — | — |
| SS-UC02-02 | Approved batch posts all invoices in one job | UC-02 | MVP | db-integration | no | — | T-0044 | not-started | — | — |
| SS-UC02-03 | One failure does not roll back the others | UC-02 | MVP | db-integration | no | — | T-0044 | not-started | — | — |
| SS-UC02-04 | PDFs emailed to Billing To and CC | UC-02 | MVP | db-integration | no | — | T-0044, T-0042 | not-started | — | — |
| SS-UC02-05 | Re-running a crashed batch is idempotent | UC-02 | MVP | db-integration | no | — | T-0044 | not-started | — | — |
| SS-UC02-06 | Consecutive gapless numbers; failed invoice consumes none | UC-02 | MVP | db-integration | no | packages/ledger/src/numbering.db.test.ts | T-0044, T-0024 | green (numbering layer, T-0024; the invoice batch itself is T-0044) | [.agent/evidence/T-0024/manifest.json](../../.agent/evidence/T-0024/manifest.json) | 57c4d8c |
| SS-UC02-07 | Permission required to run a batch | UC-02 | MVP | unit + db-integration | no | packages/shared/src/rbac/rbac.matrix.test.ts, apps/api/src/authz/permissions.db.test.ts | T-0012, T-0043 | green | [.agent/evidence/T-0012/manifest.json](../../.agent/evidence/T-0012/manifest.json) | 052231e |
| SS-UC02-08 | Batch screens show preview and exception list | UC-02 | MVP | e2e-playwright | yes | — | T-0084 | not-started | — | — |
| SS-UC03-01 | Invoice carries a Stripe payment link | UC-03 | MVP | contract | no | — | T-0073 | not-started | — | — |
| SS-UC03-02 | Stripe payment posts GP-003 and marks invoice Paid | UC-03 | MVP | golden | no | — | T-0074 | not-started | — | — |
| SS-UC03-03 | Stripe payout posts GP-004 net settlement | UC-03 | MVP | golden | no | — | T-0075 | not-started | — | — |
| SS-UC03-04 | Salesforce shows Paid with payment date | UC-03 | MVP | contract | no | — | T-0067, T-0074 | not-started | — | — |
| SS-UC03-05 | Duplicate webhook is idempotent | UC-03 | MVP | db-integration | no | — | T-0074 | not-started | — | — |
| SS-UC03-06 | Invalid or replayed webhook rejected | UC-03 | MVP | unit | no | — | T-0074 | not-started | — | — |
| SS-UC03-07 | Bank-transfer receipt posts GP-002 | UC-03 | MVP | golden | no | — | T-0046 | not-started | — | — |
| SS-UC03-08 | Partial payment leaves the correct open amount | UC-03 | MVP | db-integration | no | — | T-0046 | not-started | — | — |
| SS-UC03-09 | Late payout in an AR-locked period follows the period matrix | UC-03 | MVP | db-integration | no | — | T-0075, T-0023 | not-started | — | — |
| SS-UC03-10 | Receipt allocation screen | UC-03 | MVP | e2e-playwright | yes | — | T-0085 | not-started | — | — |
| SS-UC04-01 | Reminder 1 at 7 days overdue | UC-04 | MVP | db-integration | no | — | T-0068 | not-started | — | — |
| SS-UC04-02 | Credit status "Overdue" written back | UC-04 | MVP | contract | no | — | T-0068, T-0067 | not-started | — | — |
| SS-UC04-03 | Reminders are idempotent per step | UC-04 | MVP | db-integration | no | — | T-0068 | not-started | — | — |
| SS-UC04-04 | Paid invoice gets no reminder | UC-04 | MVP | unit | no | — | T-0068 | not-started | — | — |
| SS-UC04-05 | Salesforce Task logged for the Account owner | UC-04 | Phase 1 | contract | no | — | T-0100 | not-started | — | — |
| SS-UC04-06 | Credit hold at 30 days blocks auto-approve | UC-04 | Phase 1 | db-integration | no | — | T-0100 | not-started | — | — |
| SS-UC05-01 | Emailed PDF becomes a draft bill | UC-05 | MVP | db-integration | no | — | T-0051 | not-started | — | — |
| SS-UC05-02 | Suggested coding from past bills | UC-05 | MVP | unit | no | — | T-0050 | not-started | — | — |
| SS-UC05-03 | Coded bill routes to Approver; nothing posts before approval | UC-05 | MVP | db-integration | no | — | T-0052 | not-started | — | — |
| SS-UC05-04 | Approved bill posts GP-008 | UC-05 | MVP | golden | no | — | T-0050, T-0052 | not-started | — | — |
| SS-UC05-05 | SoD: clerk cannot approve own bill above $1,000 | UC-05 | MVP | db-integration | no | — | T-0052, T-0015 | not-started | — | — |
| SS-UC05-06 | Small-team mode records a visible exception | UC-05 | MVP | db-integration | no | — | T-0015, T-0052 | not-started | — | — |
| SS-UC05-07 | Bill in AP-locked period rejected | UC-05 | MVP | db-integration | no | — | T-0050, T-0023 | not-started | — | — |
| SS-UC05-08 | Bill entry and approval screens | UC-05 | MVP | e2e-playwright | yes | — | T-0086 | not-started | — | — |
| SS-UC06-01 | Batch created from 12 due bills | UC-06 | MVP | db-integration | no | — | T-0054 | not-started | — | — |
| SS-UC06-02 | Creator cannot release own batch | UC-06 | MVP | db-integration | no | — | T-0054, T-0015 | not-started | — | — |
| SS-UC06-03 | Release requires step-up MFA | UC-06 | MVP | db-integration | no | — | T-0054, T-0013 | not-started | — | — |
| SS-UC06-04 | Batch over $10,000 needs two releasers | UC-06 | MVP | db-integration | no | — | T-0054 | not-started | — | — |
| SS-UC06-05 | Recently changed bank details excluded with reason | UC-06 | MVP | db-integration | no | — | T-0054, T-0053 | not-started | — | — |
| SS-UC06-06 | ABA file is byte-exact | UC-06 | MVP | contract | no | — | T-0056 | not-started | — | — |
| SS-UC06-07 | Batch posts GP-009 on confirmation only | UC-06 | MVP | golden | no | — | T-0057 | not-started | — | — |
| SS-UC06-08 | Remittance advices emailed | UC-06 | MVP | db-integration | no | — | T-0057, T-0042 | not-started | — | — |
| SS-UC06-09 | Bank-detail change needs a different verifier and notifies the old contact | UC-06 | MVP | db-integration | no | — | T-0053 | not-started | — | — |
| SS-UC06-10 | Release screen with step-up prompt | UC-06 | MVP | e2e-playwright | yes | — | T-0087 | not-started | — | — |
| SS-UC07-01 | Pay run import posts GP-010 | UC-07 | Phase 1 | golden | no | — | T-0100 | not-started | — | — |
| SS-UC07-02 | Net-pay batch released by second user posts GP-011 | UC-07 | Phase 1 | golden | no | — | T-0100 | not-started | — | — |
| SS-UC07-03 | Liabilities in payables summary | UC-07 | Phase 1 | db-integration | no | — | T-0100 | not-started | — | — |
| SS-UC07-04 | Duplicate pay-run import is idempotent | UC-07 | Phase 1 | db-integration | no | — | T-0100 | not-started | — | — |
| SS-UC07-05 | Payroll Officer cannot release own net-pay batch | UC-07 | Phase 1 | db-integration | no | — | T-0100 | not-started | — | — |
| SS-UC08-01 | CSV, OFX and CAMT.053 normalise identically | UC-08 | MVP | contract | no | packages/modules/bank/src/statement-import.test.ts | T-0058 (T-0059 re-scoped, DL-0114) | green | [.agent/evidence/T-0058/manifest.json](../../.agent/evidence/T-0058/manifest.json) | 540e85e |
| SS-UC08-02 | Duplicate statement import detected | UC-08 | MVP | db-integration | no | packages/modules/bank/src/statements.db.test.ts | T-0058 | green | [.agent/evidence/T-0058/manifest.json](../../.agent/evidence/T-0058/manifest.json) | 540e85e |
| SS-UC08-03 | Exact match auto-matches | UC-08 | MVP | db-integration | no | — | T-0060 | not-started | — | — |
| SS-UC08-04 | Rule match is suggested, not applied | UC-08 | MVP | unit | no | — | T-0060 | not-started | — | — |
| SS-UC08-05 | Unmatched line created as a transaction | UC-08 | MVP | db-integration | no | — | T-0060 | not-started | — | — |
| SS-UC08-06 | Statement balance equals book balance | UC-08 | MVP | db-integration | no | — | T-0061 | not-started | — | — |
| SS-UC08-07 | Reconciled lines locked after hard lock | UC-08 | MVP | db-integration | no | — | T-0061, T-0023 | not-started | — | — |
| SS-UC08-08 | Reconciliation screens | UC-08 | MVP | e2e-playwright | yes | — | T-0088 | not-started | — | — |
| SS-UC09-01 | Three sample previews balance | UC-09 | Phase 1 | unit | no | — | T-0100 | not-started | — | — |
| SS-UC09-02 | Unbalanced rule cannot be activated | UC-09 | Phase 1 | unit | no | — | T-0100 | not-started | — | — |
| SS-UC09-03 | Author cannot activate own rule | UC-09 | Phase 1 | db-integration | no | — | T-0100 | not-started | — | — |
| SS-UC09-04 | Activated rule produces GP-014 tagged with rule id and version | UC-09 | Phase 1 | golden | no | — | T-0100 | not-started | — | — |
| SS-UC09-05 | Rule cannot hit a control account without a party | UC-09 | Phase 1 | unit | no | — | T-0100 | not-started | — | — |
| SS-UC10-01 | Checklist steps recorded with user and time | UC-10 | MVP | db-integration | no | — | T-0078 | not-started | — | — |
| SS-UC10-02 | AR lock blocks AR posting except with override | UC-10 | MVP | db-integration | no | — | T-0023, T-0078 | not-started | — | — |
| SS-UC10-03 | AP lock allows journals only | UC-10 | MVP | db-integration | no | — | T-0023 | not-started | — | — |
| SS-UC10-04 | Soft close: Finance Admin override only | UC-10 | MVP | db-integration | no | — | T-0023 | not-started | — | — |
| SS-UC10-05 | Hard lock rejects or redirects per policy | UC-10 | MVP | db-integration | no | — | T-0023, T-0078 | not-started | — | — |
| SS-UC10-06 | Reopen needs two approvers and a reason | UC-10 | MVP | db-integration | no | — | T-0079 | not-started | — | — |
| SS-UC10-07 | Close cannot pass with unreconciled bank | UC-10 | MVP | db-integration | no | — | T-0078 | not-started | — | — |
| SS-UC10-08 | TB review step shows TB nets to zero | UC-10 | MVP | db-integration | no | — | T-0078, T-0076 | not-started | — | — |
| SS-UC10-09 | Void posts a reversal, never an edit | UC-10 | MVP | golden | no | — | T-0032 | not-started | — | — |
| SS-UC10-10 | Close checklist screen | UC-10 | MVP | e2e-playwright | yes | — | T-0090 | not-started | — | — |
| SS-UC11-01 | Partial credit note posts GP-005 | UC-11 | MVP | golden | no | — | T-0045 | not-started | — | — |
| SS-UC11-02 | Credit on a paid invoice is held as customer credit | UC-11 | MVP | db-integration | no | — | T-0045 | not-started | — | — |
| SS-UC11-03 | Refund via payment batch posts GP-006 | UC-11 | MVP | golden | no | — | T-0055 | not-started | — | — |
| SS-UC11-04 | Refund via Stripe calls the refund API | UC-11 | MVP | contract | no | — | T-0055, T-0074 | not-started | — | — |
| SS-UC11-05 | Salesforce shows net amount paid | UC-11 | MVP | contract | no | — | T-0055, T-0067 | not-started | — | — |
| SS-UC11-06 | Clerk cannot approve own credit note above threshold | UC-11 | MVP | db-integration | no | — | T-0045, T-0015 | not-started | — | — |
| SS-UC11-07 | Credit cannot exceed the creditable amount | UC-11 | MVP | unit | no | — | T-0045 | not-started | — | — |
| SS-UC11-08 | Credit note and refund screens | UC-11 | MVP | e2e-playwright | yes | — | T-0085 | not-started | — | — |
| SS-UC12-01 | Component renders balance, overdue, last payment, 5 invoices | UC-12 | MVP | unit | no | — | T-0072 | not-started | — | — |
| SS-UC12-02 | Mirror fields are read-only for sales users | UC-12 | MVP | contract | no | salesforce/test/package-contract.test.ts (offline); salesforce/force-app/main/default/classes/LFReadOnlyMirrorTest.cls (org, not yet run) | T-0062 | green (metadata part, offline; org deploy needs Dev Hub) | [.agent/evidence/T-0062/manifest.json](../../.agent/evidence/T-0062/manifest.json) | 447b6c3 |
| SS-UC12-03 | Empty state with no invoices | UC-12 | MVP | unit | no | — | T-0072 | not-started | — | — |
| SS-UC12-04 | Sales rep sees the component in a scratch org | UC-12 | MVP | e2e-playwright | yes | — | T-0072 | not-started | — | — |
| SS-UC12-05 | Salesforce values reconcile to LedgerForce aged AR | UC-12 | MVP | db-integration | no | — | T-0067, T-0049 | not-started | — | — |
| SS-PLAT-01 | Balance trigger rejects unbalanced entries | — | MVP | db-integration | no | packages/ledger/src/journal-balance.db.test.ts | T-0020 | green | [.agent/evidence/T-0020/manifest.json](../../.agent/evidence/T-0020/manifest.json) | 878cfc8 |
| SS-PLAT-02 | Posted journal rows are immutable | — | MVP | db-integration | no | packages/ledger/src/journal-immutability.db.test.ts | T-0021 | green | [.agent/evidence/T-0021/manifest.json](../../.agent/evidence/T-0021/manifest.json) | 26e7823 |
| SS-PLAT-03 | Hash chain detects tampering | — | MVP | db-integration | no | packages/ledger/src/hash-chain.db.test.ts | T-0022 | green | [.agent/evidence/T-0022/manifest.json](../../.agent/evidence/T-0022/manifest.json) | 31124c2 |
| SS-PLAT-04 | RLS isolates tenants on every tenant table | — | MVP | db-integration | no | packages/db/src/rls.db.test.ts; packages/db/src/tenant-context.db.test.ts | T-0008, T-0010 | green | [.agent/evidence/T-0010/manifest.json](../../.agent/evidence/T-0010/manifest.json) | merge (re-verified below) |
| SS-PLAT-05 | Gapless numbering under concurrency and rollback | — | MVP | db-integration | no | packages/ledger/src/numbering.db.test.ts | T-0024 | green | [.agent/evidence/T-0024/manifest.json](../../.agent/evidence/T-0024/manifest.json) | 57c4d8c |
| SS-PLAT-06 | Period status matrix is enforced as data | — | MVP | unit | no | — | T-0023 | not-started | — | — |
| SS-PLAT-07 | Control accounts reject manual journals, imports and rule lines | — | MVP | db-integration | no | — | T-0029 | not-started | — | — |
| SS-PLAT-08 | Audit log is append-only | — | MVP | db-integration | no | packages/db/src/platform.db.test.ts | T-0014 | green | [.agent/evidence/T-0014/manifest.json](../../.agent/evidence/T-0014/manifest.json) | 93e3e18 |
| SS-PLAT-09 | Failover resume works | — | Sprint 0 | unit | no | — | T-0003 | not-started | — | — |
| SS-PLAT-10 | No-delete guard | — | Sprint 0 | unit | no | — | T-0003 | not-started | — | — |
| SS-PLAT-11 | Invariants hold over 10,000 random documents | — | MVP | property | no | — | T-0033 | not-started | — | — |
| SS-PLAT-12 | Every Approved golden posting is reproduced exactly | — | MVP | golden | no | — | T-0031 | not-started | — | — |
| SS-PLAT-13 | Float arithmetic on money is a lint error | — | MVP | unit | no | packages/testing/eslint-rules/no-float-money.config.test.ts; packages/shared/src/money/*.test.ts | T-0017 | green | [.agent/evidence/T-0017/manifest.json](../../.agent/evidence/T-0017/manifest.json) | 5385095 |
| SS-PLAT-14 | Same idempotency key posts once | — | MVP | db-integration | no | — | T-0025 | not-started | — | — |
| SS-PLAT-15 | Preview writes nothing | — | MVP | db-integration | no | — | T-0026 | not-started | — | — |
| SS-PLAT-16 | SoD rules 1–6 evaluated as configured | — | MVP | unit | no | — | T-0015 | not-started | — | — |
| SS-PLAT-17 | Migrations are forward-only on the previous schema | — | MVP | db-integration | no | — | T-0008 | not-started | — | — |
| SS-PLAT-18 | Security gates fail on seeded issues | — | MVP | contract | no | — | T-0095 | not-started | — | — |
| SS-PLAT-19 | Evidence harness captures screenshots | — | Sprint 0 | e2e-playwright | yes | tests/e2e/evidence-harness.spec.ts | T-0009 | green | [.agent/evidence/T-0009/manifest.json](../../.agent/evidence/T-0009/manifest.json) | 2e661fa |
| SS-PLAT-20 | MFA and session policy for finance roles | — | MVP | db-integration | no | apps/api/src/auth/session.db.test.ts (session part); apps/api/src/auth/oidc.db.test.ts (login part) | T-0105, T-0013, T-0011 | green (session part, T-0105; login part, T-0011: amr/acr captured, policy applied to login sessions; MFA enforcement pending T-0013) | [.agent/evidence/T-0105/manifest.json](../../.agent/evidence/T-0105/manifest.json); [.agent/evidence/T-0011/manifest.json](../../.agent/evidence/T-0011/manifest.json) | bc07686 (session); c259211 (login) |
| SS-PLAT-21 | Leaver is disabled, never deleted | — | MVP | db-integration | no | — | T-0016 | not-started | — | — |
| SS-PLAT-22 | Bank details encrypted and masked | — | MVP | db-integration | no | packages/modules/parties/src/bank-accounts.db.test.ts; apps/api/src/parties/bank-accounts.db.test.ts | T-0037 | green | [.agent/evidence/T-0037/manifest.json](../../.agent/evidence/T-0037/manifest.json) | 1219bbc |
| SS-PLAT-23 | Self-hosted compose install works | — | MVP | e2e-playwright | yes | — | T-0094 | not-started | — | — |
| SS-PLAT-24 | Outbox delivers at least once, handlers idempotent | — | MVP | db-integration | no | — | T-0030 | not-started | — | — |
| SS-PLAT-25 | Sync failures back off then land in the Sync issues inbox | — | MVP | db-integration | no | — | T-0071 | not-started | — | — |
| SS-PLAT-26 | Missed Salesforce events recovered by nightly reconciliation | — | MVP | db-integration | no | — | T-0070, T-0066 | not-started | — | — |
| SS-PLAT-27 | Replay id resume after restart | — | MVP | db-integration | no | — | T-0064 | not-started | — | — |
| SS-PLAT-28 | Every API request runs in its own tenant transaction | — | MVP | db-integration | no | apps/api/src/tenancy/tenant-transaction.db.test.ts | T-0104 | green | [.agent/evidence/T-0104/manifest.json](../../.agent/evidence/T-0104/manifest.json) | 3ca2bd9 |
| SS-PLAT-29 | Timeline components honour P3, P13, P15 and the genericness probes | — | MVP | e2e-playwright | yes | tests/e2e/ui-system.spec.ts; packages/ui/src/**/*.test.{ts,tsx} | T-0106 | green | [.agent/evidence/T-0106/manifest.json](../../.agent/evidence/T-0106/manifest.json) | bede6c3 |
| SS-PLAT-30 | Every successful API mutation leaves one audit row | — | MVP | db-integration | no | apps/api/src/audit/audit.db.test.ts | T-0014 | green | [.agent/evidence/T-0014/manifest.json](../../.agent/evidence/T-0014/manifest.json) | 93e3e18 |
| SS-PLAT-31 | System-role accounts are protected by the database | — | MVP | db-integration | no | packages/modules/gl/src/chart.db.test.ts | T-0018 | green | [.agent/evidence/T-0018/manifest.json](../../.agent/evidence/T-0018/manifest.json) | 42fc3ba |
| SS-PLAT-32 | AU services SMB chart template is valid | — | MVP | unit | no | packages/modules/gl/src/templates.test.ts | T-0018 | green | [.agent/evidence/T-0018/manifest.json](../../.agent/evidence/T-0018/manifest.json) | 42fc3ba |
| SS-PLAT-33 | Dimension sets are deduplicated by a hash of their sorted pairs | — | MVP | db-integration + property | no | packages/ledger/src/dimension-set.db.test.ts | T-0019 | green | [.agent/evidence/T-0019/manifest.json](../../.agent/evidence/T-0019/manifest.json) | 361b38f |
| SS-PLAT-34 | Required dimensions per account are enforced; dimension identity is stable | — | MVP | db-integration | no | packages/ledger/src/dimension-set.db.test.ts | T-0019 | green | [.agent/evidence/T-0019/manifest.json](../../.agent/evidence/T-0019/manifest.json) | 361b38f |
| SS-PLAT-35 | Party identifiers are validated and normalised | — | MVP | unit + property | no | packages/modules/parties/src/identifiers.test.ts | T-0036 | green | [.agent/evidence/T-0036/manifest.json](../../.agent/evidence/T-0036/manifest.json) | 481ae75 |
| SS-PLAT-36 | One party with roles, addresses, contacts and contact roles | — | MVP | db-integration | no | packages/modules/parties/src/parties.db.test.ts | T-0036 | green | [.agent/evidence/T-0036/manifest.json](../../.agent/evidence/T-0036/manifest.json) | 481ae75 |
| SS-PLAT-37 | An invoice cannot be approved for a customer with no Billing To contact | — | MVP | db-integration | no | packages/modules/parties/src/parties.db.test.ts | T-0036 | green | [.agent/evidence/T-0036/manifest.json](../../.agent/evidence/T-0036/manifest.json) | 481ae75 |
| SS-PLAT-38 | Envelope encryption fails closed and survives key rotation | — | MVP | unit | no | packages/shared/src/crypto/envelope.test.ts | T-0037 | green | [.agent/evidence/T-0037/manifest.json](../../.agent/evidence/T-0037/manifest.json) | 1219bbc |
| SS-PLAT-39 | Company bank account bound to a bank GL account, number encrypted | — | MVP | db-integration | no | packages/modules/bank/src/statements.db.test.ts | T-0058 | green | [.agent/evidence/T-0058/manifest.json](../../.agent/evidence/T-0058/manifest.json) | 540e85e |
| SS-PLAT-40 | Statement parsers read bank files exactly and fail loudly | — | MVP | unit + property | no | packages/modules/bank/src/parsers.test.ts | T-0058 | green | [.agent/evidence/T-0058/manifest.json](../../.agent/evidence/T-0058/manifest.json) | 540e85e |
| SS-PLAT-41 | OIDC login creates a session for an invited user (PKCE, state, nonce) | — | MVP | db-integration | no | apps/api/src/auth/oidc.db.test.ts | T-0011 | green | [.agent/evidence/T-0011/manifest.json](../../.agent/evidence/T-0011/manifest.json) | c259211 |
| SS-PLAT-42 | Login refuses unknown users, replayed or expired state and unknown tenants | — | MVP | db-integration | no | apps/api/src/auth/oidc.db.test.ts | T-0011 | green | [.agent/evidence/T-0011/manifest.json](../../.agent/evidence/T-0011/manifest.json) | c259211 |
| SS-PLAT-45 | Salesforce package metadata matches the connector contract (offline) | — | MVP | unit | no | salesforce/test/package-contract.test.ts, salesforce/test/xml.test.ts | T-0062 | green | [.agent/evidence/T-0062/manifest.json](../../.agent/evidence/T-0062/manifest.json) | 447b6c3 |
| SS-PLAT-46 | Salesforce permission sets grant least privilege; only the integration user writes | — | MVP | unit | no | salesforce/test/package-contract.test.ts | T-0062 | green | [.agent/evidence/T-0062/manifest.json](../../.agent/evidence/T-0062/manifest.json) | 447b6c3 |
| SS-PLAT-47 | A company ABN must pass the ABR checksum | — | MVP | db-integration | no | packages/db/src/company-abn.db.test.ts | T-0107 | green | [.agent/evidence/T-0107/manifest.json](../../.agent/evidence/T-0107/manifest.json) | 3ec79cd |
| SS-PLAT-48 | Role templates grant exactly the design §6.4 matrix | — | MVP | unit | no | packages/shared/src/rbac/rbac.matrix.test.ts | T-0012 | green | [.agent/evidence/T-0012/manifest.json](../../.agent/evidence/T-0012/manifest.json) | 052231e |
| SS-PLAT-49 | Every endpoint checks a permission; role changes are audited, never deleted and revoke sessions | — | MVP | unit + db-integration | no | apps/api/src/authz/routes.test.ts, apps/api/src/authz/permissions.db.test.ts, packages/db/src/user-role.db.test.ts | T-0012 | green | [.agent/evidence/T-0012/manifest.json](../../.agent/evidence/T-0012/manifest.json) | 052231e |
| SS-PLAT-50 | Salesforce JWT bearer assertion is signed and exchanged per contract; failures map to clear codes; certificate expiry alerts 30 days ahead | — | MVP | unit + contract | no | packages/connectors/salesforce/src/jwt.test.ts; packages/connectors/salesforce/src/certificate.test.ts; packages/connectors/salesforce/src/jwt-bearer.contract.test.ts | T-0063 | green | [.agent/evidence/T-0063/manifest.json](../../.agent/evidence/T-0063/manifest.json) | 5e35f74 |
| SS-PLAT-51 | Salesforce connection secrets are envelope-encrypted at rest and never returned by reads | — | MVP | db-integration | no | packages/connectors/salesforce/src/connection-store.db.test.ts | T-0063 | green | [.agent/evidence/T-0063/manifest.json](../../.agent/evidence/T-0063/manifest.json) | 5e35f74 |
| SS-PLAT-52 | Web sign-in, session check and sign-out follow the T-0011 auth contract | — | MVP | e2e-playwright + component | yes | tests/e2e/web/shell.spec.ts; apps/web/src/App.test.tsx, api.test.ts, slug.test.ts | T-0081 | green | [.agent/evidence/T-0081/manifest.json](../../.agent/evidence/T-0081/manifest.json) | ae91f61 |
| SS-PLAT-53 | Authenticated web shell: navigation, states, keyboard path, WCAG 2.2 AA, genericness | — | MVP | e2e-playwright + component | yes | tests/e2e/web/shell.spec.ts; apps/web/src/App.test.tsx | T-0081 | green | [.agent/evidence/T-0081/manifest.json](../../.agent/evidence/T-0081/manifest.json) | ae91f61 |
| SS-PLAT-54 | CAMT batch entries, multi-statement files and camt.052/054 import correctly | — | MVP | unit + db | no | — | T-0059 | not-started | — | — |
| SS-PLAT-55 | A verify run writes evidence only for the task being verified | — | MVP | unit + e2e | no | packages/testing/src/evidence/destination.test.ts; tests/e2e/evidence-harness.spec.ts | T-0109 | green | — | — |
| SS-PLAT-UI-01 | Static UI pages load cleanly at 1440 and 390 with evidence | — | Sprint 0 | e2e-playwright | yes | tests/e2e/ui-mockups.spec.ts | T-0009 | green | [.agent/evidence/T-0009/manifest.json](../../.agent/evidence/T-0009/manifest.json) | 2e661fa |

## Platform scenarios (definitions)

### SS-PLAT-01 — Balance trigger rejects unbalanced entries
- Phase: MVP · Layer: **db-integration** · Screenshot evidence: no · Task(s): T-0020
- **Given** a journal entry with Σdebit 100.00 and Σcredit 99.99 · **When** the transaction commits · **Then** commit fails with the deferred balance constraint error and nothing is stored

### SS-PLAT-02 — Posted journal rows are immutable
- Phase: MVP · Layer: **db-integration** · Screenshot evidence: no · Task(s): T-0021
- **Given** a posted entry · **When** lf_app runs UPDATE, DELETE, and ALTER TABLE … DISABLE TRIGGER · **Then** all three fail

### SS-PLAT-03 — Hash chain detects tampering
- Phase: MVP · Layer: **db-integration** · Screenshot evidence: no · Task(s): T-0022
- **Given** 100 posted entries · **When** a superuser alters one amount and the verifier runs · **Then** the verifier reports the first broken entry; untampered chains pass

### SS-PLAT-04 — RLS isolates tenants on every tenant table
- Phase: MVP · Layer: **db-integration** · Screenshot evidence: no · Task(s): T-0008, T-0010
- **Given** tenants A and B with data in every tenant-owned table · **When** tenant A selects, aggregates, updates, deletes and inserts with B's ids · **Then** zero rows are visible/affected and inserts for B fail; a table without FORCE RLS fails the catalog test

### SS-PLAT-05 — Gapless numbering under concurrency and rollback
- Phase: MVP · Layer: **db-integration** · Screenshot evidence: no · Task(s): T-0024
- **Given** 50 concurrent postings in one series, 5 of which roll back · **When** numbers are assigned · **Then** 45 consecutive numbers with no gap

### SS-PLAT-06 — Period status matrix is enforced as data
- Phase: MVP · Layer: **unit** · Screenshot evidence: no · Task(s): T-0023
- **Given** every source type × period status · **When** posting is attempted with and without override · **Then** allow/deny/override results equal the approved §3.5 matrix table

### SS-PLAT-07 — Control accounts reject manual journals, imports and rule lines
- Phase: MVP · Layer: **db-integration** · Screenshot evidence: no · Task(s): T-0029
- **Given** a manual journal, a CSV journal import and a rule line on AR_CONTROL without subledger source · **When** each is posted · **Then** each is refused with CONTROL_ACCOUNT

### SS-PLAT-08 — Audit log is append-only
- Phase: MVP · Layer: **db-integration** · Screenshot evidence: no · Task(s): T-0014
- **Given** audit events exist · **When** lf_app runs UPDATE and DELETE on audit.event · **Then** both fail; INSERT succeeds

### SS-PLAT-09 — Failover resume works
- Phase: Sprint 0 · Layer: **unit** · Screenshot evidence: no · Task(s): T-0003
- **Given** a running claude session that exits with a quota error · **When** the conductor processes the exit · **Then** it writes HANDOVER, commits wip/, releases the lease and starts codex on the same branch from last_checkpoint

### SS-PLAT-10 — No-delete guard
- Phase: Sprint 0 · Layer: **unit** · Screenshot evidence: no · Task(s): T-0003
- **Given** a branch that deletes a tracked file or adds a DROP in a migration · **When** verify.sh runs · **Then** verify fails naming the file/statement

### SS-PLAT-11 — Invariants hold over 10,000 random documents
- Phase: MVP · Layer: **property** · Screenshot evidence: no · Task(s): T-0033
- **Given** 10,000 generated documents (seeded) · **When** they are posted and some reversed · **Then** every entry balances, TB nets to 0, AR sub = AR control, AP sub = AP control, reversal restores prior balances

### SS-PLAT-12 — Every Approved golden posting is reproduced exactly
- Phase: MVP · Layer: **golden** · Screenshot evidence: no · Task(s): T-0031
- **Given** Approved GP entries in postings.md · **When** the golden runner executes · **Then** engine output equals each GP line-for-line

### SS-PLAT-13 — Float arithmetic on money is a lint error
- Phase: MVP · Layer: **unit** · Screenshot evidence: no · Task(s): T-0017
- **Given** a fixture file doing number arithmetic on a Money field · **When** lint runs · **Then** lint reports no-float-money

### SS-PLAT-14 — Same idempotency key posts once
- Phase: MVP · Layer: **db-integration** · Screenshot evidence: no · Task(s): T-0025
- **Given** a posting command · **When** it is submitted twice with the same idempotency key · **Then** one entry exists and the second call returns the first result

### SS-PLAT-15 — Preview writes nothing
- Phase: MVP · Layer: **db-integration** · Screenshot evidence: no · Task(s): T-0026
- **Given** any document · **When** preview is requested · **Then** journal, balance, subledger and outbox row counts are unchanged

### SS-PLAT-16 — SoD rules 1–6 evaluated as configured
- Phase: MVP · Layer: **unit** · Screenshot evidence: no · Task(s): T-0015
- **Given** table of actor/action/subject cases incl. small-team mode · **When** the SoD engine evaluates them · **Then** results equal the expected table

### SS-PLAT-17 — Migrations are forward-only on the previous schema
- Phase: MVP · Layer: **db-integration** · Screenshot evidence: no · Task(s): T-0008
- **Given** the previous release schema with data · **When** current migrations apply · **Then** they apply cleanly with no DROP/RENAME

### SS-PLAT-18 — Security gates fail on seeded issues
- Phase: MVP · Layer: **contract** · Screenshot evidence: no · Task(s): T-0095
- **Given** a fixture branch with a fake secret and a vulnerable dependency · **When** CI runs · **Then** secret and dependency gates fail; SBOM artefact produced on clean branch

### SS-PLAT-19 — Evidence harness captures screenshots
- Phase: Sprint 0 · Layer: **e2e-playwright** · Screenshot evidence: **yes** · Task(s): T-0009
- **Given** a sample page · **When** the evidence harness runs · **Then** PNG + manifest.json land in .agent/evidence/<task>/

### SS-PLAT-20 — MFA and session policy for finance roles
- Phase: MVP · Layer: **db-integration** · Screenshot evidence: no · Task(s): T-0105 (session expiry/revocation), T-0013 (MFA), T-0011 (login)
- **Given** an Accountant without MFA, and an idle session of 31 minutes · **When** they call a finance endpoint · **Then** both are refused (mfa_required / session_expired)

### SS-PLAT-21 — Leaver is disabled, never deleted
- Phase: MVP · Layer: **db-integration** · Screenshot evidence: no · Task(s): T-0016
- **Given** an active user with sessions and tokens · **When** they are offboarded · **Then** status disabled, sessions/tokens revoked, history retained, pending approvals reassigned

### SS-PLAT-22 — Bank details encrypted and masked
- Phase: MVP · Layer: **db-integration** · Screenshot evidence: no · Task(s): T-0037
- **Given** a supplier bank account · **When** it is stored and read via API · **Then** ciphertext at rest; API returns only the last 3 digits

### SS-PLAT-23 — Self-hosted compose install works
- Phase: MVP · Layer: **e2e-playwright** · Screenshot evidence: **yes** · Task(s): T-0094
- **Given** a fresh VM/CI runner with Docker · **When** docker compose up runs · **Then** migrations apply, a one-time owner setup link is printed and the login page renders (screenshot)

### SS-PLAT-24 — Outbox delivers at least once, handlers idempotent
- Phase: MVP · Layer: **db-integration** · Screenshot evidence: no · Task(s): T-0030
- **Given** a posted invoice and a worker crash after send · **When** the worker restarts · **Then** the event is redelivered and the handler effect happens once

### SS-PLAT-25 — Sync failures back off then land in the Sync issues inbox
- Phase: MVP · Layer: **db-integration** · Screenshot evidence: no · Task(s): T-0071
- **Given** a write-back failing permanently · **When** retries exhaust (1 min → 6 h) · **Then** a Sync issue with error and payload exists and one-click retry re-queues it

### SS-PLAT-26 — Missed Salesforce events recovered by nightly reconciliation
- Phase: MVP · Layer: **db-integration** · Screenshot evidence: no · Task(s): T-0070, T-0066
- **Given** connector offline for 3 days beyond CDC retention · **When** nightly reconciliation runs · **Then** all changed records are replayed once and stale write-backs re-pushed

### SS-PLAT-27 — Replay id resume after restart
- Phase: MVP · Layer: **db-integration** · Screenshot evidence: no · Task(s): T-0064
- **Given** a subscriber that committed replay id R · **When** it restarts · **Then** it resumes from R with no lost or duplicated effects

### SS-PLAT-28 — Every API request runs in its own tenant transaction
- Phase: MVP · Layer: **db-integration** · Screenshot evidence: no · Task(s): T-0104
- **Given** tenants A and B, each with a company · **When** a request resolved to A lists companies, and a request with no resolvable tenant is made · **Then** only A's company is returned; the unresolved request gets 401 and runs no SQL; the pooled connection carries no tenant context afterwards; `/health` answers 200 without a tenant

### SS-PLAT-29 — Timeline components honour P3, P13, P15 and the genericness probes
- Phase: MVP · Layer: **e2e-playwright** · Screenshot evidence: yes · Task(s): T-0106
- **Given** a fixture page rendering every Timeline component with Harbour & Co data · **When** Playwright runs at 1440 and 390, light and dark · **Then** money is right-aligned tabular figures; every open item has data-turn and data-due; expected series are dashed and labelled; no horizontal scroll at 390; axe WCAG 2.2 AA 0 violations; genericness probes find nothing; screenshots saved as evidence

### SS-PLAT-UI-01 — Static UI pages load cleanly at 1440 and 390 with evidence
- Phase: Sprint 0 · Layer: **e2e-playwright** · Screenshot evidence: yes · Task(s): T-0009
- **Given** the v0.1 mockups and the chosen Timeline reference screens · **When** each loads at 1440 and 390 · **Then** each has a title and an h1, logs no console errors, and leaves a full-page screenshot in .agent/evidence/T-0009/ (registered 2026-10-24: the id was already used by the spec)

### SS-PLAT-30 — Every successful API mutation leaves one audit row
- Phase: MVP · Layer: **db-integration** · Screenshot evidence: no · Task(s): T-0014
- **Given** an authenticated user · **When** they make a successful mutating request (e.g. logout), a read, and a refused request · **Then** the mutation leaves exactly one audit.audit_log row in the same tenant transaction with actor_type user, actor_user_id, action (method + route), ip, user agent and the request id (echoed in `x-request-id`); reads and refused requests write none; handler-supplied entity before/after are recorded

### SS-PLAT-31 — System-role accounts are protected by the database
- Phase: MVP · Layer: **db-integration** · Screenshot evidence: no · Task(s): T-0018
- **Given** a company loaded with the AU services SMB template, as lf_app in a tenant transaction · **When** someone archives a bound account, makes it non-postable, changes it to a type its role does not allow, clears the control flag of a control account, re-binds a role to an account of the wrong type, binds a role twice, or deletes an account or binding · **Then** each change is refused by the database and nothing changes; an unbound account can still be archived; all 17 roles are bound exactly once; the SQL role→type rule equals the TypeScript map

### SS-PLAT-32 — AU services SMB chart template is valid
- Phase: MVP · Layer: **unit** · Screenshot evidence: no · Task(s): T-0018
- **Given** the shipped `au-services-smb` template · **When** it is validated · **Then** it has no errors, binds every one of the 17 system roles exactly once to an account of an allowed type; and the validator reports duplicated, missing or mistyped roles, duplicate or malformed codes, a control flag off the control roles, and a postable CURRENT_YEAR_EARNINGS

### SS-PLAT-33 — Dimension sets are deduplicated by a hash of their sorted pairs
- Phase: MVP · Layer: **db-integration + property** · Screenshot evidence: no · Task(s): T-0019
- **Given** a company with four dimensions (two primary) · **When** dimension sets are requested for any combination of values in any order (fast-check, genuine permutations) · **Then** the same pairs always give the same set id and different pairs different ids; the empty combination is one real set; the two primary values are copied into indexed columns; two values of one dimension, a value of another tenant, an unknown value or an archived value are refused; a caller cannot store a forged hash; lf_app cannot UPDATE or DELETE sets

### SS-PLAT-34 — Required dimensions per account are enforced; dimension identity is stable
- Phase: MVP · Layer: **db-integration** · Screenshot evidence: no · Task(s): T-0019
- **Given** an account requiring `department` and `project` · **When** the posting engine asks which required dimensions a set lacks · **Then** it gets the missing codes in the account's order (none for a complete set or an account with no requirements); an account cannot require a dimension the company lacks; a dimension's code and primary slot never change; a primary slot is held by at most one dimension and only slots 1–2 exist; a dimension required by an active account cannot be archived

### SS-PLAT-35 — Party identifiers are validated and normalised
- Phase: MVP · Layer: **unit + property** · Screenshot evidence: no · Task(s): T-0036
- **Given** RQ-0017's rules · **When** ABNs, Peppol IDs and Salesforce Ids are checked · **Then** the ATO's ABN 51 824 753 556 passes and any single-digit change fails; spaces are stripped; the Peppol participant ID is 0151:<ABN> and needs a valid ABN; a 15-character Salesforce Id becomes 18 characters (003G000001SUbc4 → …IAD), an 18-character Id with a wrong suffix is refused, and case-only differences give different 18-character Ids

### SS-PLAT-36 — One party with roles, addresses, contacts and contact roles
- Phase: MVP · Layer: **db-integration** · Screenshot evidence: no · Task(s): T-0036
- **Given** a company · **When** parties are created and changed as lf_app · **Then** one party holds customer and supplier roles with billing and shipping addresses; the database refuses an ABN failing the checksum even when written directly (SQL and TS checks agree, fast-check); Peppol delivery needs an ABN; the Salesforce Account Id is stored 18-char and unique per company; remittance needs a supplier, billing roles need a customer; a contact role can only name a contact of the same party; lf_app cannot delete from any party table

### SS-PLAT-37 — An invoice cannot be approved for a customer with no Billing To contact
- Phase: MVP · Layer: **db-integration** · Screenshot evidence: no · Task(s): T-0036 (helper; the approval itself is T-0040, SS-UC01-05)
- **Given** a party · **When** invoice approval asks for blockers and recipients · **Then** a customer without an active Billing To contact gets `no_billing_to_contact`, cleared by adding one; an inactive role or archived contact does not count; a non-customer gets `not_a_customer`, an archived party `party_archived`; recipients are active Billing To (To) and Billing CC (CC) contacts with email, sorted

### SS-PLAT-38 — Envelope encryption fails closed and survives key rotation
- Phase: MVP · Layer: **unit** · Screenshot evidence: no · Task(s): T-0037
- **Given** the local keyring KMS (ADR-0018) · **When** values are sealed and opened · **Then** the sealed parts never contain the plaintext; each seal uses a fresh data key and IV; a different record/field (AAD), any flipped bit, a wrong key or an unknown key id fails closed; after rotation old data still opens and new seals use the new key; malformed keyrings are refused without echoing key material

### SS-PLAT-39 — Company bank account bound to a bank GL account, number encrypted
- Phase: MVP · Layer: **db-integration** · Screenshot evidence: no · Task(s): T-0058
- **Given** a company with the AU chart · **When** a bank account is set up (design §4.1 step 4) · **Then** it binds only to an active, postable, non-control asset GL account of subtype bank whose currency allows it, one active bank account per GL account; the account number is envelope-encrypted at rest and masked on read; BSB, APCA user id, ABA user name and FI mnemonic are validated by the service and by database CHECKs; lf_app cannot change payment details in place or delete accounts, statements or lines

### SS-PLAT-40 — Statement parsers read bank files exactly and fail loudly
- Phase: MVP · Layer: **unit + property** · Screenshot evidence: no · Task(s): T-0058
- **Given** OFX 1.x/2.x, CAMT.053 and CSV inputs (RQ-0019) · **When** they are parsed · **Then** OFX dates keep the day the bank wrote whatever the offset; OFX 1.x CHARSET and entities decode; only booked CAMT entries count and balances must add up; CSV quoting, amount styles, date orders and debit/credit columns follow the stored mapping; impossible dates, inexact amounts, wrong currencies and broken mappings are refused with the row; property: CSV and OFX render → parse round-trips in order; duplicate keys are deterministic and unique within a file

### SS-PLAT-41 — OIDC login creates a session for an invited user (PKCE, state, nonce)
- Phase: MVP · Layer: **db-integration** · Screenshot evidence: no · Task(s): T-0011 (ADR-0016, RQ-0020)
- **Given** a tenant with slug `harbour`, an IdP (in-process OpenID Provider) and a user invited with (issuer, subject) · **When** they open `/t/harbour/auth/login`, authenticate at the IdP and return to `/auth/callback` · **Then** the redirect used code + PKCE S256 + state + nonce, with the pre-auth record kept server-side (10 minutes, single use) and bound to the browser by the `lf_oidc` cookie; the callback sets `lf_session` (HttpOnly, SameSite=Lax, Path=/; Secure on https); `/auth/me` returns the user; the invitation becomes active; the login is audited; a wrong nonce or PKCE verifier gets 400 with no session; `app.tenant_id_for_slug` returns only an id and lf_app still sees only its own tenant

### SS-PLAT-42 — Login refuses unknown users, replayed or expired state and unknown tenants
- Phase: MVP · Layer: **db-integration** · Screenshot evidence: no · Task(s): T-0011 (ADR-0016)
- **Given** the login flow of SS-PLAT-41 · **When** the subject is unknown, belongs to another tenant or another issuer, or is disabled; the callback is replayed, more than 10 minutes old, or arrives without (or with another or a forged-tenant) `lf_oidc` cookie; or the slug is unknown, suspended, missing or malformed · **Then** 403 `not_invited` with no session and no user created (no just-in-time accounts); 400 `invalid_request` with no session, and the pre-auth record is not consumed by a mismatched cookie; the same 404 `{"error":"not_found"}` with no cookie and no pre-auth row

### SS-PLAT-45 — Salesforce package metadata matches the connector contract (offline)
- Phase: MVP · Layer: **unit** · Screenshot evidence: no · Task(s): T-0062
- **Given** the SFDX project in `salesforce/` (RQ-0022, DL-0094..0096) · **When** it is read offline by the strict metadata reader · **Then** `sfdx-project.json` is one unlocked-package directory on API 67.0 with no namespace; every metadata file is strict XML in the metadata namespace and named after its component; every apiVersion is 67.0; LF_Invoice__c, LF_Payment__c, Account, Opportunity and LF_Billing_Request__e carry exactly the contracted LF fields with the contracted types; `LF_Id__c` is an external ID, unique and case-insensitive; lookups never block deletion of Salesforce-owned records; mirrors are deployed and public read-only; the event is HighVolume and published after commit; no credentials are in `salesforce/`; and `sf project convert source` converts the project without warnings

### SS-PLAT-46 — Salesforce permission sets grant least privilege; only the integration user writes
- Phase: MVP · Layer: **unit** · Screenshot evidence: no · Task(s): T-0062
- **Given** the package's permission sets (DL-0097) · **When** their grants are listed · **Then** `LF_Integration_User` has exactly create/read/edit on the mirrors, read/edit on Account and Opportunity, read on the billing-request event, edit on every LF field, `ApiEnabled` and the `LF_Integration_Write` custom permission, and no delete, view-all or modify-all; `LF_Billing_Requester` may only create the event; there are exactly three permission sets and one custom permission; none needs activation or a licence

### SS-PLAT-47 — A company ABN must pass the ABR checksum
- Phase: MVP · Layer: **db-integration** · Screenshot evidence: no · Task(s): T-0107
- **Given** RQ-0017's ABR rule · **When** a company is created or changed as lf_app · **Then** a valid ABN or none is accepted; an 11-digit ABN failing the mod-89 checksum is refused (23514) on insert and on update

### SS-PLAT-48 — Role templates grant exactly the design §6.4 matrix
- Phase: MVP · Layer: **unit** · Screenshot evidence: no · Task(s): T-0012 (ADR-0023)
- **Given** the permission catalogue and the ten role templates (`@ledgerforce/shared/rbac`) · **When** each role's permissions are listed · **Then** every write permission has exactly the holders the test lists; each role can and cannot what §6.4 says; Owner holds everything; Auditor every read permission and no write; Sales user and Integration nothing and no interactive login; MFA is flagged for Owner, Finance Admin, Accountant, AP Clerk and Payroll Officer (§6.2); several roles give the union, unknown roles nothing; templates are frozen

### SS-PLAT-49 — Every endpoint checks a permission; role changes are audited, never deleted and revoke sessions
- Phase: MVP · Layer: **unit + db-integration** · Screenshot evidence: no · Task(s): T-0012 (ADR-0023)
- **Given** the API with real sessions and `app.user_role` (migration 0016) · **When** routes are called and roles granted or revoked · **Then** every route declares public, any-member or a catalogue permission, and an undeclared route gets 403 `permission: null`; a permission route without a verified user gets 403; a missing permission gets 403 `{error:'forbidden', permission}` with a `permission_denied` audit row; bank details need `parties.bank_account.read`; a grant (201, or 200 if already active) or revoke (200) is audited and bumps `session_epoch` in the same transaction, so the user's sessions end; Owner grants need `users.roles.assign_owner`; the last Owner cannot be revoked (409); unknown roles 400; other tenants' users 404; grants are never deleted, edited or un-revoked (42501/23514), one active grant per user and role (23505)

### SS-PLAT-50 — Salesforce JWT bearer assertion is signed and exchanged per contract; failures map to clear codes; certificate expiry alerts 30 days ahead
- Phase: MVP · Layer: **unit + contract** · Screenshot evidence: no · Task(s): T-0063 (ADR-0007, RQ-0024, DL-0105)
- **Given** an RSA-2048 key and self-signed certificate generated at runtime and a local fake token endpoint that verifies signatures with the certificate's public key (documented responses, no Salesforce org) · **When** the connector builds an assertion and exchanges it · **Then** the header is RS256 and the claims are iss = consumer key, sub = integration username, aud = `https://login.salesforce.com` or `https://test.salesforce.com`, exp ≤ 180 s after iat, fresh jti; the signature verifies with the public key and fails for another key or altered claims; non-RSA or < 2048-bit keys, other audiences and lifetimes over 180 s are refused locally; the request is the form-encoded jwt-bearer grant to `<aud>/services/oauth2/token` with no client secret; another key or an expired assertion gives `invalid_assertion`, and `not_preauthorized`, `invalid_user`, `invalid_client`, `invalid_audience`, `ip_restricted`, `unsupported_grant_type` map from the documented errors; 5xx and network errors are retryable `token_endpoint_unavailable`; a 200 without a token or an https instance URL is `malformed_response`; no error carries the assertion or a token; no source requests the password grant; certificate status is `ok` at 31 days, `expiring_soon` at 30 and 29 days (whole days left), `expired` at notAfter; a key that does not match the certificate, or an expired certificate, is refused

### SS-PLAT-51 — Salesforce connection secrets are envelope-encrypted at rest and never returned by reads
- Phase: MVP · Layer: **db-integration** · Screenshot evidence: no · Task(s): T-0063 (ADR-0018, migration 0017)
- **Given** a tenant company with a JWT bearer connection saved as lf_app via `withTenant` · **When** tokens are obtained and the connection is read · **Then** no stored column (text, hex or base64) nor the row dump contains the private-key PEM or the access token; the token is cached sealed and reused for 15 minutes, then re-signed, and after a 401 invalidation the next call re-signs; two concurrent callers share one exchange (row lock); `getConnection`/`listConnections` return login URL, username, consumer key, instance URL, certificate status and fingerprint but no key, token or encryption column; a ciphertext copied onto another connection (other company, or a newer row of the same company) fails to decrypt; a refused exchange stores no token; a new connection supersedes the previous one (one active per company) and superseded rows give no token; lf_app cannot change key, identity or certificate columns nor delete; the database refuses other login URLs and half-written token columns; the SS-PLAT-04 cross-tenant suite covers the table

### SS-PLAT-52 — Web sign-in, session check and sign-out follow the T-0011 auth contract
- Phase: MVP · Layer: **e2e-playwright + component** · Screenshot evidence: yes · Task(s): T-0081
- **Given** the web app served on the API's origin (RQ-0025) and the auth API of SS-PLAT-41/42 (`/auth/me`, `/auth/logout`, `/t/:slug/auth/login`) · **When** a visitor without a session opens any shell page; enters an organisation sign-in name; the session ends while the shell is open; the session check fails for another reason; the person signs out from the user menu by keyboard, or sign-out fails · **Then** the visitor lands on `/sign-in` with no navigation shown; a name breaking the migration-0014 slug rule is refused in place (`aria-invalid`, message tied to the field, focus kept) and a valid one, trimmed and lower-cased, sends the whole page to `/t/<slug>/auth/login`; a 401 on a later check sends the person to sign-in; other failures show an alert with Try again (no redirect loop); sign-out POSTs `/auth/logout` once and lands on sign-in with "You have signed out." (Back does not show the shell again); a failed sign-out says so and keeps the person signed in; screenshots at 1440 and 390, light and dark

### SS-PLAT-53 — Authenticated web shell: navigation, states, keyboard path, WCAG 2.2 AA, genericness
- Phase: MVP · Layer: **e2e-playwright + component** · Screenshot evidence: yes · Task(s): T-0081
- **Given** a signed-in person · **When** the shell is opened at 1440 and 390 in light and dark, each section is followed, the keyboard is used, and an unknown path is opened · **Then** the person's name and the sections Timeline, Sales, Purchases, Bank, Reports, Settings are shown; exactly the current section has `aria-current="page"` and the ink mark; each section has one `<h1>`, a plain gloss and an empty state saying what will appear; the title follows the section; a skip link comes first; focus moves to the new heading after navigation and focus rings are 2px solid; not-found stays inside the shell with a way back; while checking the session a status says so; axe WCAG 2.0/2.1/2.2 A+AA reports 0 violations, the genericness probes find nothing, nothing scrolls sideways at 390, no console errors and no third-party requests

### SS-PLAT-54 — CAMT batch entries, multi-statement files and camt.052/054 import correctly
- Phase: MVP · Layer: **unit + db** · Screenshot evidence: no · Task(s): T-0059
- **Given** a camt.053 batch entry with 3 TxDtls, a file with 2 statements, and camt.052/054 fixtures · **When** imported · **Then** the batch becomes 3 lines summing exactly to the entry amount, each statement lands on its own bank account, duplicate detection holds across re-imports, and unsupported variants fail loudly


### SS-PLAT-55 — A verify run writes evidence only for the task being verified
- Phase: MVP · Layer: **unit + e2e** · Screenshot evidence: no · Task(s): T-0109
- **Given** `verify.sh --task X` (LF_EVIDENCE_ONLY_TASK=X) · **When** the whole e2e suite runs · **Then** specs filed under X write evidence into `.agent/evidence/X/` as before, every other task's specs still run and screenshot but into a temp dir, so no other task's evidence folder changes; without the variable, behaviour is unchanged

