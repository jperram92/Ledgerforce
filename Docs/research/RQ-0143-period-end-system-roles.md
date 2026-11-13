---
id: RQ-0143
title: How can seven period-end system roles be added without widening the inline CHECK, and which account type does each role take?
status: resolved
opened: 2026-11-13
resolved: 2026-11-13
opened_by: claude
linked_tasks: [T-0117]
linked_adrs: [ADR-0061]
superseded_by:
---

# RQ-0143: Period-end system roles, additive storage and account types

## Question

1. `app.account_system_role.role` (migration 0005) has an inline `CHECK (role IN (…17 roles…))`.
   Can PostgreSQL 16/17 widen that list without `DROP CONSTRAINT`, which the forward-only
   migration gate forbids? If not, what additive design works?
2. Which account type(s) must each new role allow: AR_ECL_ALLOWANCE, PREPAYMENTS,
   ACCUM_DEPRECIATION, DEPRECIATION_EXPENSE, ACCRUED_EXPENSES, SGC_PAYABLE,
   PRIOR_PERIOD_ADJUSTMENTS?

## Why it matters

Design §3.2 says the posting engine finds accounts by role, never by code, and §3.10 (T-0115,
RQ-0095/RQ-0096, owner decision DL-0256) adds these roles for AASB 9, AASB 116, AASB 108,
accruals and Payday Super/SGC. T-0116 bound them through template `suggestedSettings` as a
stop-gap. The type rule is enforced by `app.system_role_allows()` and mirrored in
`packages/modules/gl/src/system-roles.ts`, so a wrong type would let a bound account be
re-typed into the wrong statement section.

## Sources consulted

- PostgreSQL 16 and 17 manuals, `ALTER TABLE` (`ALTER CONSTRAINT` changes only the
  deferrability of foreign-key constraints; a CHECK expression can only be changed by dropping
  and re-adding it), `CREATE VIEW … WITH (security_invoker = true)` (since PostgreSQL 15: the
  view's base relations are checked with the privileges and row-level-security policies of
  the invoking user) and §5.4.1 "Check Constraints" (PostgreSQL assumes CHECK conditions are
  immutable; a function in a CHECK is not re-evaluated for existing rows). postgresql.org was
  not reachable from this environment (proxy 403), so each behaviour was **verified
  empirically** on the local PostgreSQL 16.15 test cluster:
  [`.agent/evidence/T-0117/rq-0143-probe-output.txt`](../../.agent/evidence/T-0117/rq-0143-probe-output.txt)
  (probe source alongside). Results: `ALTER CONSTRAINT … CHECK (…)` is a syntax error;
  `ALTER CONSTRAINT … NOT VALID` is refused; a CHECK calling an IMMUTABLE SQL function refuses
  a value, and accepts it after `CREATE OR REPLACE FUNCTION` widens the list; a
  `security_invoker` view over a FORCE-RLS table returns 1 of 2 rows to a non-owner role,
  while an ordinary view owned by the table owner returns 2.
  All features used exist unchanged in PostgreSQL 17 (security_invoker views since 15).
- Repository precedent: `app.source_type_class()` (migrations 0018 → 0031) is a CASE
  function widened forward-only with `CREATE OR REPLACE`, used by a CHECK; the payment-batch
  guard (0047 → 0054) likewise.
- Design §3.2 (system roles; "AASB note") and §3.10 / §3.10.1 table rows *Credit losses*,
  *Capital assets / Depreciation*, *Accruals and prepayments*, *Payroll / Payday Super*,
  *Prior-period errors*; RQ-0095 and RQ-0096 (with their sourcing caveat: official AASB/ATO
  hosts were not reachable, findings rest on secondary text).
- AASB 9 §5.5 and AASB 7 §16A: the loss allowance reduces the carrying amount of the
  financial asset; it is not a liability. AASB 116 §73(d), §75: the gross carrying amount and
  accumulated depreciation are disclosed for each class of property, plant and equipment, so
  accumulated depreciation is a contra-asset; depreciation is recognised in profit or loss
  (§48). AASB 108 §42: a prior-period error is corrected by restating the opening balance of
  equity (retained earnings) — an equity account. Accrued expenses are a present obligation
  (liability, Conceptual Framework §4.26); prepayments are a right to future goods/services
  (asset). Superannuation Guarantee (Administration) Act 1992: the SG charge is a debt owed to
  the Commissioner (liability).
- Approved golden postings GP-024/025 (ECL), GP-030 (depreciation), GP-031 (accrual),
  GP-032 (prepayment), GP-034 (SGC) and the prior-period adjustment entries: the bound accounts
  sit on the side these types imply; the AU services template (T-0116) already gives the seven
  accounts exactly these types (1220 asset, 1300 asset, 1510 asset, 6600 expense, 2360
  liability, 2370 liability, 3400 equity).
- How comparable systems model it: Xero and MYOB place "Less accumulated depreciation" and
  "Allowance for doubtful debts" as negative lines inside the asset class with a credit
  balance; neither offers a separate "contra" account type. LedgerForce does the same: the
  type is `asset`, `normal_balance` is `credit`.

## Findings

1. A CHECK cannot be widened in place; DROP + ADD is the only route and is forbidden here.
   A NOT VALID replacement constraint still requires dropping the old one, so it does not help.
2. Additive options that work on 16 and 17: (a) a second binding table with the same shape,
   RLS and triggers, plus a `security_invoker` view that unions the two; (b) a new column or
   table plus a backfill that would eventually replace the old table (a two-phase shape change
   with a deprecation, more churn for no gain). Option (a) can avoid repeating the problem by
   gating its role column with a CHECK that calls an IMMUTABLE function, widened later with
   `CREATE OR REPLACE` like `app.source_type_class()`. Widening never invalidates stored
   rows, so the immutability assumption is safe as long as the function is only widened.
3. Account types:

   | Role | Allowed type | Basis |
   | --- | --- | --- |
   | AR_ECL_ALLOWANCE | asset (contra, credit normal balance) | AASB 9 §5.5, AASB 7 §16A |
   | PREPAYMENTS | asset | accrual basis; Conceptual Framework asset definition |
   | ACCUM_DEPRECIATION | asset (contra, credit normal balance) | AASB 116 §73(d) |
   | DEPRECIATION_EXPENSE | expense | AASB 116 §48 |
   | ACCRUED_EXPENSES | liability | accrual basis; present obligation |
   | SGC_PAYABLE | liability | SG(A) Act 1992 debt to the Commissioner |
   | PRIOR_PERIOD_ADJUSTMENTS | equity | AASB 108 §42 |

   None is a control role (no subledger owns them) and all are postable.

## Conclusion

Use option (a): `app.account_system_role_ext` with an identical shape, a function-gated role
CHECK, the same assert trigger, RLS ENABLE + FORCE, `tenant_isolation`, `lf_app`
SELECT/INSERT/UPDATE; widen `app.system_role_allows()` with the seven type rules above; make
`app.account_guard_bound()` read both tables; add the `security_invoker` view
`app.account_role_binding` that every role reader uses. Recorded in ADR-0061 and DL-0470.
