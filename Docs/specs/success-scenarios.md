# Success-scenario register

**The** list of every success scenario (SS) LedgerForce must prove. A scenario is the "expected result defined
before build" (AGENTS.md §0.2): each one names the test layer that proves it and, for UI/report behaviour, whether
Playwright screenshot evidence is required.

- Use-case scenarios `SS-UCnn-mm` are defined in [UC-nn.md](README.md); platform invariants `SS-PLAT-nn` are defined here.
- Status values: `not-started` → `red` (failing test exists, fails for the right reason) → `green` (passes in CI on the task
  branch) → `evidenced` (merged, evidence linked, verified at the commit shown).
- Generated on 2026-10-24. Totals: 121 scenarios (12 need screenshots).

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
| SS-UC02-06 | Consecutive gapless numbers; failed invoice consumes none | UC-02 | MVP | db-integration | no | — | T-0044, T-0024 | not-started | — | — |
| SS-UC02-07 | Permission required to run a batch | UC-02 | MVP | unit | no | — | T-0012, T-0043 | not-started | — | — |
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
| SS-UC08-01 | CSV, OFX and CAMT.053 normalise identically | UC-08 | MVP | contract | no | — | T-0058, T-0059 | not-started | — | — |
| SS-UC08-02 | Duplicate statement import detected | UC-08 | MVP | db-integration | no | — | T-0058 | not-started | — | — |
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
| SS-UC12-02 | Mirror fields are read-only for sales users | UC-12 | MVP | contract | no | — | T-0062 | not-started | — | — |
| SS-UC12-03 | Empty state with no invoices | UC-12 | MVP | unit | no | — | T-0072 | not-started | — | — |
| SS-UC12-04 | Sales rep sees the component in a scratch org | UC-12 | MVP | e2e-playwright | yes | — | T-0072 | not-started | — | — |
| SS-UC12-05 | Salesforce values reconcile to LedgerForce aged AR | UC-12 | MVP | db-integration | no | — | T-0067, T-0049 | not-started | — | — |
| SS-PLAT-01 | Balance trigger rejects unbalanced entries | — | MVP | db-integration | no | packages/ledger/src/journal-balance.db.test.ts | T-0020 | evidenced | [.agent/evidence/T-0020/manifest.json](../../.agent/evidence/T-0020/manifest.json) | 878cfc8 |
| SS-PLAT-02 | Posted journal rows are immutable | — | MVP | db-integration | no | packages/ledger/src/journal-immutability.db.test.ts | T-0021 | evidenced | [.agent/evidence/T-0021/manifest.json](../../.agent/evidence/T-0021/manifest.json) | 26e7823 |
| SS-PLAT-03 | Hash chain detects tampering | — | MVP | db-integration | no | — | T-0022 | not-started | — | — |
| SS-PLAT-04 | RLS isolates tenants on every tenant table | — | MVP | db-integration | no | packages/db/src/rls.db.test.ts; packages/db/src/tenant-context.db.test.ts | T-0008, T-0010 | evidenced | [.agent/evidence/T-0010/manifest.json](../../.agent/evidence/T-0010/manifest.json) | merge (re-verified below) |
| SS-PLAT-05 | Gapless numbering under concurrency and rollback | — | MVP | db-integration | no | — | T-0024 | not-started | — | — |
| SS-PLAT-06 | Period status matrix is enforced as data | — | MVP | unit | no | — | T-0023 | not-started | — | — |
| SS-PLAT-07 | Control accounts reject manual journals, imports and rule lines | — | MVP | db-integration | no | — | T-0029 | not-started | — | — |
| SS-PLAT-08 | Audit log is append-only | — | MVP | db-integration | no | packages/db/src/platform.db.test.ts | T-0014 | evidenced | [.agent/evidence/T-0014/manifest.json](../../.agent/evidence/T-0014/manifest.json) | 93e3e18 |
| SS-PLAT-09 | Failover resume works | — | Sprint 0 | unit | no | — | T-0003 | not-started | — | — |
| SS-PLAT-10 | No-delete guard | — | Sprint 0 | unit | no | — | T-0003 | not-started | — | — |
| SS-PLAT-11 | Invariants hold over 10,000 random documents | — | MVP | property | no | — | T-0033 | not-started | — | — |
| SS-PLAT-12 | Every Approved golden posting is reproduced exactly | — | MVP | golden | no | — | T-0031 | not-started | — | — |
| SS-PLAT-13 | Float arithmetic on money is a lint error | — | MVP | unit | no | packages/testing/eslint-rules/no-float-money.config.test.ts; packages/shared/src/money/*.test.ts | T-0017 | evidenced | [.agent/evidence/T-0017/manifest.json](../../.agent/evidence/T-0017/manifest.json) | 5385095 |
| SS-PLAT-14 | Same idempotency key posts once | — | MVP | db-integration | no | — | T-0025 | not-started | — | — |
| SS-PLAT-15 | Preview writes nothing | — | MVP | db-integration | no | — | T-0026 | not-started | — | — |
| SS-PLAT-16 | SoD rules 1–6 evaluated as configured | — | MVP | unit | no | — | T-0015 | not-started | — | — |
| SS-PLAT-17 | Migrations are forward-only on the previous schema | — | MVP | db-integration | no | — | T-0008 | not-started | — | — |
| SS-PLAT-18 | Security gates fail on seeded issues | — | MVP | contract | no | — | T-0095 | not-started | — | — |
| SS-PLAT-19 | Evidence harness captures screenshots | — | Sprint 0 | e2e-playwright | yes | tests/e2e/evidence-harness.spec.ts | T-0009 | evidenced | [.agent/evidence/T-0009/manifest.json](../../.agent/evidence/T-0009/manifest.json) | 2e661fa |
| SS-PLAT-20 | MFA and session policy for finance roles | — | MVP | db-integration | no | apps/api/src/auth/session.db.test.ts (session part) | T-0105, T-0013, T-0011 | green (session part, T-0105; MFA part pending T-0013) | [.agent/evidence/T-0105/manifest.json](../../.agent/evidence/T-0105/manifest.json) | bc07686 |
| SS-PLAT-21 | Leaver is disabled, never deleted | — | MVP | db-integration | no | — | T-0016 | not-started | — | — |
| SS-PLAT-22 | Bank details encrypted and masked | — | MVP | db-integration | no | — | T-0037 | not-started | — | — |
| SS-PLAT-23 | Self-hosted compose install works | — | MVP | e2e-playwright | yes | — | T-0094 | not-started | — | — |
| SS-PLAT-24 | Outbox delivers at least once, handlers idempotent | — | MVP | db-integration | no | — | T-0030 | not-started | — | — |
| SS-PLAT-25 | Sync failures back off then land in the Sync issues inbox | — | MVP | db-integration | no | — | T-0071 | not-started | — | — |
| SS-PLAT-26 | Missed Salesforce events recovered by nightly reconciliation | — | MVP | db-integration | no | — | T-0070, T-0066 | not-started | — | — |
| SS-PLAT-27 | Replay id resume after restart | — | MVP | db-integration | no | — | T-0064 | not-started | — | — |
| SS-PLAT-28 | Every API request runs in its own tenant transaction | — | MVP | db-integration | no | apps/api/src/tenancy/tenant-transaction.db.test.ts | T-0104 | evidenced | [.agent/evidence/T-0104/manifest.json](../../.agent/evidence/T-0104/manifest.json) | 3ca2bd9 |
| SS-PLAT-29 | Timeline components honour P3, P13, P15 and the genericness probes | — | MVP | e2e-playwright | yes | — | T-0106 | not-started | — | — |
| SS-PLAT-30 | Every successful API mutation leaves one audit row | — | MVP | db-integration | no | apps/api/src/audit/audit.db.test.ts | T-0014 | evidenced | [.agent/evidence/T-0014/manifest.json](../../.agent/evidence/T-0014/manifest.json) | 93e3e18 |
| SS-PLAT-31 | System-role accounts are protected by the database | — | MVP | db-integration | no | packages/modules/gl/src/chart.db.test.ts | T-0018 | evidenced | [.agent/evidence/T-0018/manifest.json](../../.agent/evidence/T-0018/manifest.json) | 42fc3ba |
| SS-PLAT-32 | AU services SMB chart template is valid | — | MVP | unit | no | packages/modules/gl/src/templates.test.ts | T-0018 | evidenced | [.agent/evidence/T-0018/manifest.json](../../.agent/evidence/T-0018/manifest.json) | 42fc3ba |
| SS-PLAT-33 | Dimension sets are deduplicated by a hash of their sorted pairs | — | MVP | db-integration + property | no | packages/ledger/src/dimension-set.db.test.ts | T-0019 | evidenced | [.agent/evidence/T-0019/manifest.json](../../.agent/evidence/T-0019/manifest.json) | 361b38f |
| SS-PLAT-34 | Required dimensions per account are enforced; dimension identity is stable | — | MVP | db-integration | no | packages/ledger/src/dimension-set.db.test.ts | T-0019 | evidenced | [.agent/evidence/T-0019/manifest.json](../../.agent/evidence/T-0019/manifest.json) | 361b38f |
| SS-PLAT-UI-01 | Static UI pages load cleanly at 1440 and 390 with evidence | — | Sprint 0 | e2e-playwright | yes | tests/e2e/ui-mockups.spec.ts | T-0009 | evidenced | [.agent/evidence/T-0009/manifest.json](../../.agent/evidence/T-0009/manifest.json) | 2e661fa |

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

