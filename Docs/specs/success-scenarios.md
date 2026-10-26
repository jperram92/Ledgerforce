# Success-scenario register

**The** list of every success scenario (SS) LedgerForce must prove. A scenario is the "expected result defined
before build" (AGENTS.md §0.2): each one names the test layer that proves it and, for UI/report behaviour, whether
Playwright screenshot evidence is required.

- Use-case scenarios `SS-UCnn-mm` are defined in [UC-nn.md](README.md); platform invariants `SS-PLAT-nn` are defined here.
- Status values: `not-started` → `red` (failing test exists, fails for the right reason) → `green` (passes in CI on the task
  branch) → `evidenced` (merged, evidence linked, verified at the commit shown).
- Generated on 2026-10-24; totals recomputed from the rows on 2026-10-26. Totals: 172 scenarios (19 need screenshots).

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
| SS-UC01-08 | Closed Won dated in a hard-locked period follows lock policy | UC-01 | MVP | db-integration | no | packages/ledger/src/period.enforce.db.test.ts | T-0069, T-0023 | green (period/policy layer; Closed Won draft invoice and Sync issue in T-0069) | [.agent/evidence/T-0023/manifest.json](../../.agent/evidence/T-0023/manifest.json) | 0296919 |
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
| SS-UC03-09 | Late payout in an AR-locked period follows the period matrix | UC-03 | MVP | db-integration | no | packages/ledger/src/period.enforce.db.test.ts | T-0075, T-0023 | green (period/matrix layer; payout cell is tenant setting `payout_under_ar_lock` awaiting product owner, RQ-0026; payout posting in T-0075) | [.agent/evidence/T-0023/manifest.json](../../.agent/evidence/T-0023/manifest.json) | 0296919 |
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
| SS-UC05-05 | SoD: clerk cannot approve own bill above $1,000 | UC-05 | MVP | db-integration | no | apps/api/src/sod/sod.db.test.ts | T-0052, T-0015 | green (SoD layer; bill endpoint in T-0052) | [.agent/evidence/T-0015/manifest.json](../../.agent/evidence/T-0015/manifest.json) | 58f5048 |
| SS-UC05-06 | Small-team mode records a visible exception | UC-05 | MVP | db-integration | no | apps/api/src/sod/sod.db.test.ts; packages/db/src/sod.db.test.ts | T-0015, T-0052 | green (SoD layer; bill endpoint in T-0052) | [.agent/evidence/T-0015/manifest.json](../../.agent/evidence/T-0015/manifest.json) | 58f5048 |
| SS-UC05-07 | Bill in AP-locked period rejected | UC-05 | MVP | db-integration | no | packages/ledger/src/period.enforce.db.test.ts | T-0050, T-0023 | green (period/matrix layer; bill posting in T-0050) | [.agent/evidence/T-0023/manifest.json](../../.agent/evidence/T-0023/manifest.json) | 0296919 |
| SS-UC05-08 | Bill entry and approval screens | UC-05 | MVP | e2e-playwright | yes | — | T-0086 | not-started | — | — |
| SS-UC06-01 | Batch created from 12 due bills | UC-06 | MVP | db-integration | no | — | T-0054 | not-started | — | — |
| SS-UC06-02 | Creator cannot release own batch | UC-06 | MVP | db-integration | no | apps/api/src/sod/sod.db.test.ts | T-0054, T-0015 | green (SoD layer; batch endpoint in T-0054) | [.agent/evidence/T-0015/manifest.json](../../.agent/evidence/T-0015/manifest.json) | 58f5048 |
| SS-UC06-03 | Release requires step-up MFA | UC-06 | MVP | db-integration | no | apps/api/src/authz/mfa-step-up.db.test.ts (stand-in release route; the real one is T-0054) | T-0054, T-0013 | green (step-up part, T-0013; the batch release itself pending T-0054) | [.agent/evidence/T-0013/manifest.json](../../.agent/evidence/T-0013/manifest.json) | e48639b |
| SS-UC06-04 | Batch over $10,000 needs two releasers | UC-06 | MVP | db-integration | no | — | T-0054 | not-started | — | — |
| SS-UC06-05 | Recently changed bank details excluded with reason | UC-06 | MVP | db-integration | no | packages/modules/parties/src/bank-change.workflow.db.test.ts (eligibility check; the batch itself is T-0054, DL-0157) | T-0054, T-0053 | green | [.agent/evidence/T-0053/manifest.json](../../.agent/evidence/T-0053/manifest.json) | 1434ee7 |
| SS-UC06-06 | ABA file is byte-exact | UC-06 | MVP | contract | no | — | T-0056 | not-started | — | — |
| SS-UC06-07 | Batch posts GP-009 on confirmation only | UC-06 | MVP | golden | no | — | T-0057 | not-started | — | — |
| SS-UC06-08 | Remittance advices emailed | UC-06 | MVP | db-integration | no | — | T-0057, T-0042 | not-started | — | — |
| SS-UC06-09 | Bank-detail change needs a different verifier and notifies the old contact | UC-06 | MVP | db-integration | no | packages/modules/parties/src/bank-change.workflow.db.test.ts, apps/api/src/parties/bank-change.workflow.db.test.ts | T-0053 | green | [.agent/evidence/T-0053/manifest.json](../../.agent/evidence/T-0053/manifest.json) | 1434ee7 |
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
| SS-UC08-07 | Reconciled lines locked after hard lock | UC-08 | MVP | db-integration | no | packages/ledger/src/period.enforce.db.test.ts | T-0061, T-0023 | green (database layer; unmatch action in T-0061) | [.agent/evidence/T-0023/manifest.json](../../.agent/evidence/T-0023/manifest.json) | 0296919 |
| SS-UC08-08 | Reconciliation screens | UC-08 | MVP | e2e-playwright | yes | — | T-0088 | not-started | — | — |
| SS-UC09-01 | Three sample previews balance | UC-09 | Phase 1 | unit | no | — | T-0100 | not-started | — | — |
| SS-UC09-02 | Unbalanced rule cannot be activated | UC-09 | Phase 1 | unit | no | — | T-0100 | not-started | — | — |
| SS-UC09-03 | Author cannot activate own rule | UC-09 | Phase 1 | db-integration | no | — | T-0100 | not-started | — | — |
| SS-UC09-04 | Activated rule produces GP-014 tagged with rule id and version | UC-09 | Phase 1 | golden | no | — | T-0100 | not-started | — | — |
| SS-UC09-05 | Rule cannot hit a control account without a party | UC-09 | Phase 1 | unit | no | — | T-0100 | not-started | — | — |
| SS-UC10-01 | Checklist steps recorded with user and time | UC-10 | MVP | db-integration | no | — | T-0078 | not-started | — | — |
| SS-UC10-02 | AR lock blocks AR posting except with override | UC-10 | MVP | db-integration | no | packages/ledger/src/period.enforce.db.test.ts | T-0023, T-0078 | green (period/matrix layer; close checklist in T-0078) | [.agent/evidence/T-0023/manifest.json](../../.agent/evidence/T-0023/manifest.json) | 0296919 |
| SS-UC10-03 | AP lock allows journals only | UC-10 | MVP | db-integration | no | packages/ledger/src/period.enforce.db.test.ts | T-0023 | green (period/matrix layer) | [.agent/evidence/T-0023/manifest.json](../../.agent/evidence/T-0023/manifest.json) | 0296919 |
| SS-UC10-04 | Soft close: Finance Admin override only | UC-10 | MVP | db-integration | no | packages/ledger/src/period.enforce.db.test.ts | T-0023 | green (period/matrix layer) | [.agent/evidence/T-0023/manifest.json](../../.agent/evidence/T-0023/manifest.json) | 0296919 |
| SS-UC10-05 | Hard lock rejects or redirects per policy | UC-10 | MVP | db-integration | no | packages/ledger/src/period.enforce.db.test.ts | T-0023, T-0078 | green (period/policy layer; close checklist in T-0078) | [.agent/evidence/T-0023/manifest.json](../../.agent/evidence/T-0023/manifest.json) | 0296919 |
| SS-UC10-06 | Reopen needs two approvers and a reason | UC-10 | MVP | db-integration | no | — | T-0079 | not-started | — | — |
| SS-UC10-07 | Close cannot pass with unreconciled bank | UC-10 | MVP | db-integration | no | — | T-0078 | not-started | — | — |
| SS-UC10-08 | TB review step shows TB nets to zero | UC-10 | MVP | db-integration | no | packages/modules/reporting/src/reports.tb-pl-bs.db.test.ts | T-0078, T-0076 | green (TB layer; subledger = control pending T-0028, DL-0175) | [.agent/evidence/T-0076/manifest.json](../../.agent/evidence/T-0076/manifest.json) | fdc062f |
| SS-UC10-09 | Void posts a reversal, never an edit | UC-10 | MVP | golden | no | — | T-0032 | not-started | — | — |
| SS-UC10-10 | Close checklist screen | UC-10 | MVP | e2e-playwright | yes | — | T-0090 | not-started | — | — |
| SS-UC11-01 | Partial credit note posts GP-005 | UC-11 | MVP | golden | no | — | T-0045 | not-started | — | — |
| SS-UC11-02 | Credit on a paid invoice is held as customer credit | UC-11 | MVP | db-integration | no | — | T-0045 | not-started | — | — |
| SS-UC11-03 | Refund via payment batch posts GP-006 | UC-11 | MVP | golden | no | — | T-0055 | not-started | — | — |
| SS-UC11-04 | Refund via Stripe calls the refund API | UC-11 | MVP | contract | no | — | T-0055, T-0074 | not-started | — | — |
| SS-UC11-05 | Salesforce shows net amount paid | UC-11 | MVP | contract | no | — | T-0055, T-0067 | not-started | — | — |
| SS-UC11-06 | Clerk cannot approve own credit note above threshold | UC-11 | MVP | db-integration | no | apps/api/src/sod/sod.db.test.ts | T-0045, T-0015 | green (SoD layer; credit-note endpoint in T-0045) | [.agent/evidence/T-0015/manifest.json](../../.agent/evidence/T-0015/manifest.json) | 58f5048 |
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
| SS-PLAT-06 | Period status matrix is enforced as data | — | MVP | unit | no | packages/ledger/src/period-matrix.test.ts; packages/ledger/src/period-control.db.test.ts | T-0023 | green | [.agent/evidence/T-0023/manifest.json](../../.agent/evidence/T-0023/manifest.json) | 0296919 |
| SS-PLAT-07 | Control accounts reject manual journals, imports and rule lines | — | MVP | db-integration | no | — | T-0029 | not-started | — | — |
| SS-PLAT-08 | Audit log is append-only | — | MVP | db-integration | no | packages/db/src/platform.db.test.ts | T-0014 | green | [.agent/evidence/T-0014/manifest.json](../../.agent/evidence/T-0014/manifest.json) | 93e3e18 |
| SS-PLAT-09 | Failover resume works | — | Sprint 0 | unit | no | — | T-0003 | not-started | — | — |
| SS-PLAT-10 | No-delete guard | — | Sprint 0 | unit | no | — | T-0003 | not-started | — | — |
| SS-PLAT-11 | Invariants hold over 10,000 random documents | — | MVP | property | no | — | T-0033 | not-started | — | — |
| SS-PLAT-12 | Every Approved golden posting is reproduced exactly | — | MVP | golden | no | — | T-0031 | not-started | — | — |
| SS-PLAT-13 | Float arithmetic on money is a lint error | — | MVP | unit | no | packages/testing/eslint-rules/no-float-money.config.test.ts; packages/shared/src/money/*.test.ts | T-0017 | green | [.agent/evidence/T-0017/manifest.json](../../.agent/evidence/T-0017/manifest.json) | 5385095 |
| SS-PLAT-14 | Same idempotency key posts once | — | MVP | db-integration | no | packages/ledger/src/engine.idempotency.db.test.ts; packages/ledger/src/posting-invariants.prop.db.test.ts | T-0025 | green | [.agent/evidence/T-0025/manifest.json](../../.agent/evidence/T-0025/manifest.json) | afb5dad |
| SS-PLAT-15 | Preview writes nothing | — | MVP | db-integration + property | no | packages/ledger/src/engine.preview.db.test.ts; packages/ledger/src/engine.preview.prop.db.test.ts; packages/outbox/src/preview.db.test.ts | T-0026 | green | [.agent/evidence/T-0026/manifest.json](../../.agent/evidence/T-0026/manifest.json) | fa6e6a5 |
| SS-PLAT-16 | SoD rules 1–6 evaluated as configured | — | MVP | unit | no | packages/shared/src/sod/sod.rules.test.ts | T-0015 | green | [.agent/evidence/T-0015/manifest.json](../../.agent/evidence/T-0015/manifest.json) | 58f5048 |
| SS-PLAT-17 | Migrations are forward-only on the previous schema | — | MVP | db-integration | no | — | T-0008 | not-started | — | — |
| SS-PLAT-18 | Security gates fail on seeded issues | — | MVP | contract | no | — | T-0095 | not-started | — | — |
| SS-PLAT-19 | Evidence harness captures screenshots | — | Sprint 0 | e2e-playwright | yes | tests/e2e/evidence-harness.spec.ts | T-0009 | green | [.agent/evidence/T-0009/manifest.json](../../.agent/evidence/T-0009/manifest.json) | 2e661fa |
| SS-PLAT-20 | MFA and session policy for finance roles | — | MVP | db-integration | no | apps/api/src/auth/session.db.test.ts (session part); apps/api/src/auth/oidc.db.test.ts (login part); apps/api/src/authz/mfa-step-up.db.test.ts, apps/api/src/authz/mfa.test.ts, apps/api/src/authz/routes.test.ts (MFA part) | T-0105, T-0013, T-0011 | green (session part, T-0105; login part, T-0011; MFA enforcement, T-0013) | [.agent/evidence/T-0105/manifest.json](../../.agent/evidence/T-0105/manifest.json); [.agent/evidence/T-0011/manifest.json](../../.agent/evidence/T-0011/manifest.json); [.agent/evidence/T-0013/manifest.json](../../.agent/evidence/T-0013/manifest.json) | bc07686 (session); c259211 (login); e48639b (MFA) |
| SS-PLAT-21 | Leaver is disabled, never deleted | — | MVP | db-integration | no | packages/db/src/user-lifecycle.db.test.ts; apps/api/src/users/users.lifecycle.db.test.ts | T-0016 | green | [.agent/evidence/T-0016/manifest.json](../../.agent/evidence/T-0016/manifest.json) | a60876f |
| SS-PLAT-22 | Bank details encrypted and masked | — | MVP | db-integration | no | packages/modules/parties/src/bank-accounts.db.test.ts; apps/api/src/parties/bank-accounts.db.test.ts | T-0037 | green | [.agent/evidence/T-0037/manifest.json](../../.agent/evidence/T-0037/manifest.json) | 1219bbc |
| SS-PLAT-23 | Self-hosted compose install works | — | MVP | e2e-playwright | yes | tests/install/install.smoke.spec.ts (run by infra/compose/smoke.sh) | T-0094 | green | [.agent/evidence/T-0094/manifest.json](../../.agent/evidence/T-0094/manifest.json) | 07361da |
| SS-PLAT-24 | Outbox delivers at least once, handlers idempotent | — | MVP | db-integration | no | apps/worker/src/outbox.delivery.db.test.ts; packages/outbox/src/deliver.test.ts | T-0030 | green | [.agent/evidence/T-0030/manifest.json](../../.agent/evidence/T-0030/manifest.json) | ceaac00 |
| SS-PLAT-25 | Sync failures back off then land in the Sync issues inbox | — | MVP | db-integration | no | — | T-0071 | not-started | — | — |
| SS-PLAT-26 | Missed Salesforce events recovered by nightly reconciliation | — | MVP | db-integration | no | — | T-0070, T-0066 | not-started | — | — |
| SS-PLAT-27 | Replay id resume after restart | — | MVP | db-integration | no | packages/connectors/salesforce/src/pubsub/replay-resume.db.test.ts | T-0064 | green | [.agent/evidence/T-0064/manifest.json](../../.agent/evidence/T-0064/manifest.json) | 5c70899 |
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
| SS-PLAT-54 | CAMT batch entries, multi-statement files and camt.052/054 import correctly | — | MVP | unit + db | no | packages/modules/bank/src/camt-extensions.test.ts; packages/modules/bank/src/camt-extensions.db.test.ts | T-0059 | green | [.agent/evidence/T-0059/manifest.json](../../.agent/evidence/T-0059/manifest.json) | 2e8fca8 |
| SS-PLAT-55 | A verify run writes evidence only for the task being verified | — | MVP | unit + e2e | no | packages/testing/src/evidence/destination.test.ts; tests/e2e/evidence-harness.spec.ts | T-0109 | green | [.agent/evidence/T-0109/manifest.json](../../.agent/evidence/T-0109/manifest.json) | 2b04331 |
| SS-PLAT-56 | Period status changes only through guarded functions by permission holders; hard-locked reopen needs two different approvers and a reason; history and audit, nothing deleted | — | MVP | db-integration | no | packages/ledger/src/period-control.db.test.ts | T-0023 | green | [.agent/evidence/T-0023/manifest.json](../../.agent/evidence/T-0023/manifest.json) | 0296919 |
| SS-PLAT-57 | Fiscal years are generated from a convention held as data (AU 1 July) with contiguous, non-overlapping monthly periods | — | MVP | unit + db-integration | no | packages/ledger/src/period-matrix.test.ts; packages/ledger/src/period-control.db.test.ts | T-0023 | green | [.agent/evidence/T-0023/manifest.json](../../.agent/evidence/T-0023/manifest.json) | 0296919 |
| SS-PLAT-58 | Step-up re-authenticates on the existing session (prompt=login, max_age, MFA acr_values; same session, no new cookie; audited) | — | MVP | db-integration | no | apps/api/src/authz/mfa-step-up.db.test.ts | T-0013 | green | [.agent/evidence/T-0013/manifest.json](../../.agent/evidence/T-0013/manifest.json) | e48639b |
| SS-PLAT-59 | Step-up and MFA fail closed (other user, non-MFA or stale answer, wrong session, missing auth_time, step-up permissions without the decorator) | — | MVP | unit + db-integration | no | apps/api/src/authz/mfa-step-up.db.test.ts; apps/api/src/authz/mfa.test.ts | T-0013 | green | [.agent/evidence/T-0013/manifest.json](../../.agent/evidence/T-0013/manifest.json) | e48639b |
| SS-PLAT-62 | SoD action ledger, settings, small-team exceptions and weekly acknowledgements are tenant-scoped, append-only, Owner-only, audited, not back-datable; the weekly report cuts weeks in the tenant time zone | — | MVP | db-integration | no | packages/db/src/sod.db.test.ts | T-0015 | green | [.agent/evidence/T-0015/manifest.json](../../.agent/evidence/T-0015/manifest.json) | 58f5048 |
| SS-PLAT-63 | SoD runs after MFA, permission and step-up; 403 sod_violation audited; @SoD without a permission fails closed; SoD settings Owner-only, report and acknowledgement permission-checked | — | MVP | db-integration | no | apps/api/src/sod/sod.db.test.ts | T-0015 | green | [.agent/evidence/T-0015/manifest.json](../../.agent/evidence/T-0015/manifest.json) | 58f5048 |
| SS-PLAT-64 | The posting engine refuses an invalid command with a typed error and writes nothing (shape, >4/>8 decimals, unbalanced before SQL; accounts, control accounts, party, dimensions, series, period) | — | MVP | unit + db-integration | no | packages/ledger/src/posting-command.test.ts; packages/ledger/src/posting-balance.prop.test.ts; packages/ledger/src/engine.pipeline.db.test.ts | T-0025 | green | [.agent/evidence/T-0025/manifest.json](../../.agent/evidence/T-0025/manifest.json) | afb5dad |
| SS-PLAT-65 | A valid command posts as one numbered, chained entry in one transaction; preview writes nothing | — | MVP | db-integration | no | packages/ledger/src/engine.pipeline.db.test.ts; packages/ledger/src/posting-invariants.prop.db.test.ts | T-0025 | green | [.agent/evidence/T-0025/manifest.json](../../.agent/evidence/T-0025/manifest.json) | afb5dad |
| SS-PLAT-66 | Every posting maintains account_balance per company/account/period/dimension set/currency in the same transaction; lf_app cannot write it; a failed post changes no balance | — | MVP | db-integration + property | no | packages/ledger/src/account-balance.db.test.ts; packages/ledger/src/account-balance.prop.db.test.ts | T-0027 | green | [.agent/evidence/T-0027/manifest.json](../../.agent/evidence/T-0027/manifest.json) | 0cc1eb5 |
| SS-PLAT-67 | Concurrent postings to the same accounts lose no balance update | — | MVP | db-integration | no | packages/ledger/src/account-balance.db.test.ts | T-0027 | green | [.agent/evidence/T-0027/manifest.json](../../.agent/evidence/T-0027/manifest.json) | 0cc1eb5 |
| SS-PLAT-68 | The outbox event and its delivery job commit atomically with the posting (job id = event id, ids-only payload; rollback, failed job insert or replay leaves no extra event or job) | — | MVP | db-integration | no | packages/outbox/src/outbox.db.test.ts | T-0030 | green | [.agent/evidence/T-0030/manifest.json](../../.agent/evidence/T-0030/manifest.json) | ceaac00 |
| SS-PLAT-69 | Outbox rows are append-only for every role; pg-boss schema owned by lf_migrator, lf_app DML only (no DDL, TRUNCATE, TRIGGER); queue install refuses any role but lf_migrator | — | MVP | db-integration | no | packages/outbox/src/outbox.db.test.ts; apps/worker/src/queue-admin.db.test.ts | T-0030 | green | [.agent/evidence/T-0030/manifest.json](../../.agent/evidence/T-0030/manifest.json) | ceaac00 |
| SS-PLAT-70 | Scoped API tokens: hashed at rest, issued under fresh MFA step-up, scopes ∩ owner permissions, never step-up, SoD as owner, expire, revocable, last use tracked, tenant-bound | — | MVP | db-integration | no | packages/db/src/user-lifecycle.db.test.ts; apps/api/src/tokens/tokens.scope.db.test.ts | T-0016 | green | [.agent/evidence/T-0016/manifest.json](../../.agent/evidence/T-0016/manifest.json) | a60876f |
| SS-PLAT-71 | Joiner activated only after MFA for MFA roles, with a welcome audit event; invite needs users.manage; nobody grants themselves a role or grants one to a disabled user | — | MVP | db-integration | no | apps/api/src/auth/oidc.db.test.ts; apps/api/src/users/users.lifecycle.db.test.ts; packages/db/src/user-lifecycle.db.test.ts | T-0016 | green | [.agent/evidence/T-0016/manifest.json](../../.agent/evidence/T-0016/manifest.json) | a60876f |
| SS-PLAT-72 | Preview and post agree: a command preview accepts posts exactly the previewed journal, and a command post refuses is refused by preview with the same typed error (incl. unknown createdBy, override without period.lock.override, a used idempotency key → ALREADY_POSTED / IDEMPOTENCY_CONFLICT) | — | MVP | db-integration + property | no | packages/ledger/src/engine.preview.db.test.ts; packages/ledger/src/engine.preview.prop.db.test.ts | T-0026 | green | [.agent/evidence/T-0026/manifest.json](../../.agent/evidence/T-0026/manifest.json) | fa6e6a5 |
| SS-PLAT-74 | CDC subscriber: a rejected (expired/invalid) replay id resets the cursor and requests a reconcile since the last commit, then resubscribes at LATEST; gap and overflow events are never applied but become resync requests; cursor, inbox and resync rows are per tenant and company | — | MVP | db-integration | no | packages/connectors/salesforce/src/pubsub/replay-resume.db.test.ts | T-0064 | green | [.agent/evidence/T-0064/manifest.json](../../.agent/evidence/T-0064/manifest.json) | 5c70899 |
| SS-PLAT-75 | Pub/Sub API contract: vendored proto byte-identical to the published one; CDC Avro payloads decode losslessly (BigInt longs, field bitmaps, gap/overflow kinds); idempotency keys per record; error-code trailer classified | — | MVP | contract | no | packages/connectors/salesforce/src/pubsub/pubsub.decode.contract.test.ts | T-0064 | green | [.agent/evidence/T-0064/manifest.json](../../.agent/evidence/T-0064/manifest.json) | 5c70899 |
| SS-PLAT-76 | Trial balance, P&L and balance sheet from the ledger for any period, date range or balance-sheet date: base currency, sections by type/subtype, optional dimension filter (TB, P&L), retained earnings = prior-year P&L, current-year earnings on its own line, assets = liabilities + equity | — | MVP | unit + db-integration | no | packages/modules/reporting/src/statements.test.ts; packages/modules/reporting/src/reports.tb-pl-bs.db.test.ts; packages/ledger/src/account-movements.db.test.ts | T-0076 | green | [.agent/evidence/T-0076/manifest.json](../../.agent/evidence/T-0076/manifest.json) | fdc062f |
| SS-PLAT-77 | For random posted ledgers the trial balance nets to zero and matches the postings, the balance sheet balances, current-year and prior-year earnings equal the P&L, and a P&L for any range matches the postings | — | MVP | property + db-integration | no | packages/modules/reporting/src/statements.test.ts; packages/modules/reporting/src/reports.prop.db.test.ts | T-0076 | green | [.agent/evidence/T-0076/manifest.json](../../.agent/evidence/T-0076/manifest.json) | fdc062f |
| SS-PLAT-78 | Users and roles screens: list with roles and status, invite, offboard with a successor, grant and revoke roles; self-grant refused with its message; actions hidden or disabled with a reason when the caller lacks the permission; loading, empty, error and forbidden states; step-up challenges go to the step-up flow | — | MVP | e2e-playwright | yes | tests/e2e/web/admin.spec.ts; apps/api/src/users/users.list.db.test.ts; apps/web/src/admin/admin.test.tsx; apps/web/src/admin/admin-logic.test.ts | T-0093 | green | [.agent/evidence/T-0093/manifest.json](../../.agent/evidence/T-0093/manifest.json) | ecdd62e |
| SS-PLAT-79 | SoD weekly exceptions report screen: the week's exceptions with rule, person and reason in plain words; the Owner acknowledges the week; others see who must acknowledge; states and week navigation | — | MVP | e2e-playwright | yes | tests/e2e/web/admin.spec.ts; apps/web/src/admin/admin.test.tsx | T-0093 | green | [.agent/evidence/T-0093/manifest.json](../../.agent/evidence/T-0093/manifest.json) | ecdd62e |
| SS-PLAT-80 | Audit log viewer: read-only, newest first, filter by actor, action, entity and date, keyset pages; read through `audit.read_log` (tenant-scoped, audit-reading roles only, lf_app still INSERT-only on the table) | — | MVP | e2e-playwright | yes | tests/e2e/web/admin.spec.ts; packages/db/src/audit-read.db.test.ts; apps/api/src/audit/audit-log.db.test.ts | T-0093 | green | [.agent/evidence/T-0093/manifest.json](../../.agent/evidence/T-0093/manifest.json) | ecdd62e |
| SS-PLAT-85 | First-start setup: refuses unsafe roles (lf_migrator/lf_app only, no superuser, no BYPASSRLS), migrates and installs the queue as lf_migrator, creates the tenant and invites the first Owner as lf_app under RLS, gives the IdP account a unique one-time password with MFA enrolment and password change, prints the owner setup link once; re-runs change nothing; reissue only while invited | — | MVP | db-integration | no | apps/worker/src/setup/setup.db.test.ts; apps/worker/src/setup/keycloak-admin.test.ts; apps/worker/src/setup/setup-config.test.ts | T-0094 | green | [.agent/evidence/T-0094/manifest.json](../../.agent/evidence/T-0094/manifest.json) | 07361da |
| SS-PLAT-86 | Install contract: digest-pinned non-root images with no baked secret, each compose secret only where needed, runtime as lf_app, start order and health checks, only the web origin published, nginx proxies exactly the API's routes and hides Keycloak admin, realm MFA/ACR mapping, secrets from env or file never in errors, http only on loopback | — | MVP | unit | no | infra/test/install-contract.test.ts; apps/api/src/deploy/nginx-routes.test.ts; apps/api/src/config.test.ts; packages/db/src/env.test.ts | T-0094 | green | [.agent/evidence/T-0094/manifest.json](../../.agent/evidence/T-0094/manifest.json) | 07361da |
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
- Proven (T-0026, RQ-0035) with a whole-database fingerprint taken before and after preview: every table in every non-system schema (row count and content hash, so journal, lines, dimension sets, account_balance, number-series counters, the hash-chain head, period overrides, audit rows, outbox_event and pgboss.job are all covered) and every sequence's last value; for manual journals, new dimension combinations, foreign-currency lines, control accounts from their subledger, period overrides and lock-date redirects, inside a read-write and a READ ONLY transaction, with pg-boss installed; plus a property (default numRuns) that preview changes nothing and equals the journal post() then stores

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
- Proven by `bash infra/compose/smoke.sh` (local dockerd and `.github/workflows/install-smoke.yml`): the spec also checks lf_app-only runtime connections, the Owner's first sign-in with MFA enrolment landing in LedgerForce, that the one-time password is then spent, and that Keycloak's `/admin/` and `/realms/master/` are not public (RQ-0041, ADR-0037).

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
- Note (2026-10-25, T-0059, RQ-0028, DL-0127): camt.052 and camt.054 are the "unsupported variants" — no AU bank was found offering them to SMB customers, so they are recognised and refused with a reason; a multi-statement file is imported per company (DL-0126), atomically.


### SS-PLAT-55 — A verify run writes evidence only for the task being verified
- Phase: MVP · Layer: **unit + e2e** · Screenshot evidence: no · Task(s): T-0109
- **Given** `verify.sh --task X` (LF_EVIDENCE_ONLY_TASK=X) · **When** the whole e2e suite runs · **Then** specs filed under X write evidence into `.agent/evidence/X/` as before, every other task's specs still run and screenshot but into a temp dir, so no other task's evidence folder changes; without the variable, behaviour is unchanged

### SS-PLAT-56 — Period status changes are guarded, audited history; hard-locked reopen needs two approvers and a reason
- Phase: MVP · Layer: **db-integration** · Screenshot evidence: no · Task(s): T-0023
- **Given** periods of a company and users holding different roles · **When** lf_app tries UPDATE/DELETE on period tables, users without period.lock/period.close/period.reopen change a status, a soft-closed period is moved back without a reason, a hard-locked period is changed directly, and a reopen is requested and approved by the same user, by a user without period.reopen, then by a second holder · **Then** every attempt but the last is refused; the last reopens the period; each change is a period_status_change row (user, time, reason, request) and an audit_log row; app.role_allows_period_permission equals the role catalogue; the owner can change nothing but status and nothing is deleted

### SS-PLAT-57 — Fiscal years are generated from a convention held as data
- Phase: MVP · Layer: **unit + db-integration** · Screenshot evidence: no · Task(s): T-0023
- **Given** the AU convention (start month 7) and the calendar convention · **When** a fiscal year is generated for any start month and year · **Then** FY2027 (AU) is 2026-07-01 … 2027-06-30 in 12 monthly periods, every plan is 12 contiguous months covering exactly one year (property), periods are inserted open inside their fiscal year, and an overlapping year or period is refused

### SS-PLAT-58 — Step-up re-authenticates on the existing session
- Phase: MVP · Layer: **db-integration** · Screenshot evidence: no · Task(s): T-0013
- **Given** a signed-in user whose last authentication is older than a route's step-up maximum age · **When** they open `/auth/step-up` and authenticate again at the IdP with MFA · **Then** the IdP is asked for `prompt=login`, `max_age` and the MFA `acr_values` (with PKCE, state and nonce) and re-authenticates even with an SSO session; the callback updates `auth_time`, `amr` and `acr` of the same session, creates no session and sets no session cookie, writes an audit row `step_up`, redirects to `return_to`, and refuses a replay

### SS-PLAT-59 — Step-up and MFA fail closed
- Phase: MVP · Layer: **unit + db-integration** · Screenshot evidence: no · Task(s): T-0013
- **Given** a step-up in progress or a step-up route · **When** the IdP authenticates another user, answers without MFA or with a stale `auth_time`, the callback comes with no or another session cookie, the session has ended or has no recorded `auth_time`, or a route holds a step-up permission without `@RequireStepUp` · **Then** each is refused (403 step_up_mismatch / mfa_required, 400 login_failed / invalid_request, 401 step_up_required) and the session is left unchanged; refusals at the callback are audited as `step_up_refused`

### SS-PLAT-62 — SoD store is append-only, checked and audited
- Phase: MVP · Layer: **db-integration** · Screenshot evidence: no · Task(s): T-0015
- **Given** migration 0021 and users of two tenants (Owner, Finance Admin, clerk, reviewer, a disabled user) · **When** lf_app records steps, changes settings, records exceptions and acknowledges weeks — including unknown steps or rules, non-Owners, blank reasons, negative thresholds, unknown time zones, self or disabled reviewers, back-dated times, rows for another tenant, and UPDATE/DELETE by lf_app and by the superuser · **Then** only the valid inserts succeed (others 23514 / 42501), nothing can be changed or deleted, settings/exception/acknowledgement inserts are audited, time columns are the database clock, the SQL step/rule/role mirrors equal the TypeScript constants and the setting defaults equal the placeholders; `app.sod_exception_report(monday)` lists exactly the exceptions of that week in the report time zone with their acknowledgement status and none of another tenant

### SS-PLAT-63 — SoD check order, contract and administration
- Phase: MVP · Layer: **db-integration** · Screenshot evidence: no · Task(s): T-0015
- **Given** routes declaring `@SoD` · **When** they are called by a user without the permission, a finance user without MFA, a user with a stale step-up, on a route declaring `@SoD` without a permission, without a subject id, and SoD settings / the weekly report are used by users with and without settings.sod.manage, settings.read and audit_log.read · **Then** permission, MFA and step-up refusals come first (forbidden / mfa_required / step_up_required), a misdeclared route is refused (forbidden, permission null), a missing subject is 400 invalid_sod_subject, settings change only for the Owner with valid values (unchanged values add no row), and the report needs audit_log.read and a Monday

### SS-PLAT-64 — The posting engine refuses an invalid command with a typed error and writes nothing
- Phase: MVP · Layer: **unit + db-integration** · Screenshot evidence: no · Task(s): T-0025
- **Given** a raw posting command · **When** it has fewer than two lines, a line with both or no side, an amount with more than 4 decimals or a rate with more than 8, is unbalanced, names an unknown source type, an unknown company or account, an unbound system role, an archived, non-postable or currency-restricted account, a control account outside its subledger, an inactive or foreign party, an invalid dimension value, lacks a required dimension, has no entry number series, or is dated where the period does not allow its source type · **Then** it is refused with a typed error (code and line) — the shape, decimal and balance checks before any SQL — and no entry, line, dimension set, override or number is written

### SS-PLAT-65 — A valid command posts as one numbered, chained entry in one transaction; preview writes nothing
- Phase: MVP · Layer: **db-integration** · Screenshot evidence: no · Task(s): T-0025
- **Given** a valid raw posting command (accounts by system role or id, base or foreign currency lines, party, dimensions) · **When** it is posted · **Then** one posted entry with the next gapless number of its source type's series is written with its lines exactly as built (rate 1 for base-currency lines, transaction currency, amount and rate carried as given), the hash chain verifies, the lock-date policy and recorded overrides apply, and the outbox hook runs inside the same transaction; a failure anywhere in the write leaves nothing, even if the caller commits; **and** preview of the same command returns the same journal inside a read-only transaction without writing anything

### SS-PLAT-66 — Every posting maintains account_balance in the same transaction
- Phase: MVP · Layer: **db-integration + property** · Screenshot evidence: no · Task(s): T-0027
- **Given** migration 0023 and a company with posted entries (base and foreign currency lines, dimension sets, several periods) · **When** commands are posted through the engine, replayed with the same key, refused in the write step, written as draft and later posted by the owner, and lf_app or the owner try to write account_balance directly · **Then** account_balance holds exactly one row per (company, account, period, dimension set, transaction currency) whose base and transaction debit/credit totals equal the sums of the posted lines, a replay or a failed post changes nothing, draft lines count only once the entry leaves draft, lf_app gets 42501 on INSERT/UPDATE/DELETE, the owner cannot decrease a total, change a key or delete a row, `accountBalanceDrift` (packages/ledger) reports no difference but finds a tampered row, and over random postings (property) the balances equal the sum of posted lines and the trial balance read from account_balance nets to zero

### SS-PLAT-67 — Concurrent postings to the same accounts lose no balance update
- Phase: MVP · Layer: **db-integration** · Screenshot evidence: no · Task(s): T-0027
- **Given** one company and two accounts with no balance row yet · **When** many postings to the same accounts, period and dimension set run at the same time on separate connections (some debiting A and crediting B, some the reverse, so lock order varies) · **Then** every posting commits, the balance rows equal the sum of all posted lines (no lost update, no deadlock), and the drift report is empty

### SS-PLAT-68 — The outbox event and its delivery job commit atomically with the posting
- Phase: MVP · Layer: **db-integration** · Screenshot evidence: no · Task(s): T-0030
- **Given** a raw posting command posted with the outbox (`ledgerOutbox`) · **When** the post commits, is rolled back by its caller, cannot insert its pg-boss job, or is replayed with the same idempotency key · **Then** a committed post has exactly one `ledger.entry.posted` event and one job whose id is the event id and whose payload is only `{ tenantId, eventId }`; otherwise no entry, event or job is added

### SS-PLAT-69 — Outbox and queue privileges
- Phase: MVP · Layer: **db-integration** · Screenshot evidence: no · Task(s): T-0030
- **Given** migration 0024 and pg-boss installed by `installQueue` · **When** lf_app or the owner try to change or delete an outbox event, and installation is attempted as lf_app · **Then** lf_app gets 42501 and the owner the append-only refusal; schema `pgboss` and its tables are owned by lf_migrator with lf_app holding only SELECT/INSERT/UPDATE/DELETE (no CREATE, TRUNCATE, TRIGGER); installation as lf_app is refused and creates nothing; installing twice as lf_migrator is idempotent

### SS-PLAT-70 — Scoped API tokens are hashed, expire and cannot exceed their owner
- Phase: MVP · Layer: **db-integration** · Screenshot evidence: no · Task(s): T-0016
- **Given** users with sessions · **When** they issue personal API tokens and use them as `Authorization: Bearer` · **Then** issuing needs a fresh MFA step-up and returns the secret once (`Cache-Control: no-store`) while the database stores only its SHA-256; scopes must be known, token-allowed (no step-up, user/role administration, SoD-settings or subscription permission) and held by the owner; at each request the token's permissions are its scopes ∩ the owner's current role permissions; a token never satisfies a step-up, cannot mint tokens and is not a session; SoD treats the owner as the actor; revoked, expired, forged, foreign-tenant, malformed or cookie-plus-bearer requests are 401; last use is tracked; every audit row names the token; rows are tenant-isolated, never deleted, and only usage and one revoke can change

### SS-PLAT-71 — Joiner and mover controls
- Phase: MVP · Layer: **db-integration** · Screenshot evidence: no · Task(s): T-0016
- **Given** an administrator and invited users · **When** users are invited, log in for the first time and receive roles · **Then** an invite needs users.manage (and the right to assign each role) and creates an invited user with grants; a joiner whose roles need MFA is activated only by an MFA login (otherwise 403 mfa_enrolment_required, audited, still invited) and activation writes `user.joined`; nobody grants a role to themselves (API 403 self_grant, audited; database 42501) and no role is granted to a disabled user

### SS-PLAT-72 — Preview and post agree
- Phase: MVP · Layer: **db-integration + property** · Screenshot evidence: no · Task(s): T-0026
- **Given** a raw posting command · **When** it is previewed and then posted · **Then** either both succeed and post stores exactly the previewed journal, or both refuse with the same typed error code and nothing is written; the shared validate step refuses an unknown createdBy (UNKNOWN_USER) and an override by a user without period.lock.override (OVERRIDE_NOT_PERMITTED) before any write; preview of a key that already posted this document is ALREADY_POSTED with that entry's id and number (post would replay it), of a key used by another document IDEMPOTENCY_CONFLICT; over random commands with at most one fault each (property, default numRuns) every fault gives its expected code in both

### SS-PLAT-74 — Rejected replay id, gap and overflow events become resync requests
- Phase: MVP · Layer: **db-integration** · Screenshot evidence: no · Task(s): T-0064
- **Given** a CDC subscriber with a stored replay id · **When** Salesforce rejects that id (INVALID_ARGUMENT, `error-code` …fetch.replayid.corrupted, e.g. older than 72 h), or the stream delivers `GAP_*` or `GAP_OVERFLOW` events · **Then** the cursor is cleared and a `replay_id_invalid` resync request records the last commit time and the next run subscribes at LATEST; gap events record their records and overflow events their entity for the reconcile job, and neither is applied; another tenant sees none of these rows and keeps its own cursor and inbox

### SS-PLAT-75 — Pub/Sub API contract and CDC decoding
- Phase: MVP · Layer: **contract** · Screenshot evidence: no · Task(s): T-0064
- **Given** the vendored `pubsub_api.proto` and documented AccountChangeEvent fixtures (RQ-0036) · **When** the contract test runs · **Then** the proto's SHA-256 matches the published file, Subscribe is a bidi stream with the documented field numbers and presets, payloads decode with BigInt commit numbers and expanded field bitmaps, gap/overflow are classified, idempotency keys are per record (entity, id, commit number, sequence), and Pub/Sub errors are classified from the `error-code` trailer

### SS-PLAT-76 — Trial balance, profit and loss and balance sheet
- Phase: MVP · Layer: **unit + db-integration** · Screenshot evidence: no · Task(s): T-0076
- **Given** postings through the engine over two fiscal years, including drafts, another company, a foreign-currency line and dimension values · **When** the trial balance (date range, optional dimension filter), the P&L (range) and the balance sheet (date) are run · **Then** amounts are in base currency; whole periods come from account_balance and cut periods from posted lines; drafts and other companies are left out; the TB shows each account's net balance on its side and its totals; the P&L groups revenue and expenses by subtype; the BS shows prior-year profit in retained earnings and the year to date on the current-year earnings line, both computed, and balances (also after an optional closing entry); bad dates, unknown companies and dates without a fiscal year are refused

### SS-PLAT-77 — Report invariants over random ledgers
- Phase: MVP · Layer: **property + db-integration** · Screenshot evidence: no · Task(s): T-0076
- **Given** random balanced entries posted through the engine on random days of FY2026–FY2027 · **When** the TB to a random date, the BS at a random date and the P&L for a random range are run · **Then** the TB nets to zero and equals a model of the postings; the BS balances, its current-year earnings equal the model's profit for the year to date and its prior-year earnings the profit before; the P&L equals the model's profit for the range

### SS-PLAT-78 — Users and roles administration screens
- Phase: MVP · Layer: **e2e-playwright** (+ db-integration for `GET /users`, `GET /auth/me/access`) · Screenshot evidence: yes · Task(s): T-0093
- **Given** a signed-in Owner, Finance Admin or Auditor at `/settings/users` · **When** they list users, invite one, open a user, grant or revoke a role, try to grant themselves a role, or offboard a user naming an active successor · **Then** the list shows each user's status and active roles; invite and offboard (Owner, `users.manage`) and role changes (`users.roles.assign`, Owner role only with `users.roles.assign_owner`) are offered only to callers who hold them, otherwise the reason is shown; a self-grant shows the API's refusal in plain words; offboarding reports what was revoked and who now acts on approvals; a caller without `users.read` sees a forbidden state naming who can; loading, empty and error (with retry) states exist; a `401 step_up_required` answer sends the browser to `/auth/step-up` with `max_age` and `return_to`; axe WCAG 2.2 AA clean at 1440 and 390

### SS-PLAT-79 — SoD weekly exceptions report and Owner acknowledgement
- Phase: MVP · Layer: **e2e-playwright** · Screenshot evidence: yes · Task(s): T-0093
- **Given** small-team exceptions recorded in a week · **When** a caller with `audit_log.read` opens `/reports/control-exceptions` and moves between weeks, and the Owner acknowledges the week · **Then** each exception shows the rule in plain words, the person, the kind and the reason, with whether it is acknowledged; the Owner (`settings.sod.manage`) acknowledges with an optional note and sees the acknowledgement time; other roles see that the Owner must acknowledge (no enabled button); an empty week says so; loading, error and forbidden states exist; axe clean at 1440 and 390

### SS-PLAT-80 — Audit log viewer, read-only and permissioned
- Phase: MVP · Layer: **e2e-playwright** + **db-integration** · Screenshot evidence: yes · Task(s): T-0093
- **Given** audit rows in two tenants · **When** an Owner, Finance Admin or Auditor opens `/reports/audit-log`, filters by actor, action, entity and date range and pages back · **Then** rows come newest first, 50 per page with a "Older entries" cursor, each with time, actor, action, entity and before/after on demand; nothing on the screen can change a row; the API reads through `audit.read_log` (SECURITY DEFINER, owner lf_migrator), which requires a tenant, re-checks that the actor holds an audit-reading role, returns only the tenant's rows and at most 100 per call; lf_app still gets 42501 on a direct SELECT; a caller without `audit_log.read` gets 403 and a forbidden state; axe clean at 1440 and 390

### SS-PLAT-85 — First-start setup provisions the first Owner once, with no default password
- Phase: MVP · Layer: **db-integration** + unit · Screenshot evidence: no · Task(s): T-0094
- **Given** an empty database and a Keycloak realm · **When** the compose `setup` service runs (once, again, and with `LF_SETUP_REISSUE=1`) · **Then** it refuses swapped roles, a superuser or a BYPASSRLS role; applies every migration and installs pg-boss as lf_migrator; as lf_app creates the tenant (slug) and an invited Owner bound to the IdP subject with `granted_by` NULL and `system` audit rows; sets a unique 25-character temporary password with CONFIGURE_TOTP + UPDATE_PASSWORD on the IdP account and prints the owner setup link with it; a second run writes nothing and prints no password; reissue works only while the Owner is invited

### SS-PLAT-86 — Self-hosted install contract
- Phase: MVP · Layer: **unit** · Screenshot evidence: no · Task(s): T-0094
- **Given** the Dockerfiles, compose.yaml, nginx template, realm export and configuration code · **When** they are checked without a Docker daemon · **Then** base images are pinned by digest and run as non-root; no image bakes a secret; each file secret reaches only its services; api and worker use lf_app and only setup holds the migrator password; only the web origin is published (loopback default); start order and health checks are declared; nginx proxies exactly the API's controller prefixes, never shadows an SPA route and returns 404 for Keycloak `/admin/` and `/realms/master/`; the realm has no self-registration, PKCE S256 and `default.acr.values` equal to the API's MFA ACR; secrets come from `<NAME>` or `<NAME>_FILE` and never appear in errors; http is accepted only for loopback hosts
