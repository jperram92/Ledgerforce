---
id: RQ-0026
title: How are periods, the §3.5 source-type × status matrix, overrides, reopen and the lock-date policy enforced, and what happens to bank/Stripe payouts under AR lock?
status: resolved
opened: 2026-10-25
resolved: 2026-10-25
opened_by: claude
linked_tasks: [T-0023]
linked_adrs: [ADR-0004, ADR-0023]
superseded_by:
---

# RQ-0026 — Period matrix, overrides, reopen and lock-date policy

## Question

Q1. Which source types fall under which §3.5 column (AR, AP, journals), and what does each
period status allow, need an override for, or refuse? In particular (design §11.3 item 4,
RQ-0012 item 4): may a **bank/Stripe payout** dated in an **AR-locked** period post?

Q2. How does the database enforce invariant 3 (design §3.3: `entry_date` must fall in a period
whose status allows the source type), including overrides, without racing a concurrent status
change, and how does the engine tell "period locked" apart from other check violations?

Q3. Who may change a period's status, and how is "hard locked → reopen needs two approvers and an
audit reason" enforced when role → permission mapping lives in TypeScript (ADR-0023)?

Q4. What exactly does the tenant lock-date policy "post to first open date with a note" do
(design §2, §5.6 rule 5)?

Q5. How are fiscal periods generated so that the AU 1 July – 30 June year is data, not code?

## Why it matters

T-0023 is the period control of the ledger (design §3.5). Guessing a matrix cell either lets a
late document land in a closed month (misstated BAS / management accounts) or blocks automated
feeds at every month end (Sync issues backlog, RQ-0012 item 4).

## Sources consulted

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S1 | `Docs/solution-design/solution-design.md` §3.5 | 2026-10-25 | primary (scope) | Open: everyone with the permission; AR locked: "AP and journals only; AR needs override"; AP locked: "Journals only; AR/AP need override"; Soft closed: "Finance Admin with override only"; Hard locked: "Nobody; reopening needs two approvers and an audit reason". |
| S2 | same, §2 table and bullet "Lock dates are the SMB-friendly control", §5.6 rule 5 | 2026-10-25 | primary (scope) | Each tenant chooses "reject" or "post to first open date with a note"; integrations hit lock-date errors and need a rule. |
| S3 | same, §3.3 invariant 3; §11.3 item 4 | 2026-10-25 | primary (scope) | Invariant is database-enforced; reviewer asked whether §3.5 conflicts with UC-03 late Stripe payouts. |
| S4 | `Docs/research/RQ-0012-design-review-checklist.md` item 4 | 2026-10-25 | secondary (internal review) | Bank transactions, Stripe settlements, payroll journals, recurring journals are not mapped to lock stages; late payouts in AR lock "hit an undefined rule". |
| S5 | `Docs/accounting/postings.md` (GP-001..GP-019 headers) | 2026-10-25 | primary (human-owned, Draft) | Source types are dotted: `ar.invoice`, `ar.receipt`, `payments.stripe.charge`, `payments.stripe.payout`, `ap.bill`, `ap.payment`, `payroll.pay_run`, `ledger.reversal` … |
| S6 | `packages/db/migrations/0007_ledger_journal.sql` | 2026-10-25 | source code | `journal_entry.source_type CHECK (source_type ~ '^[a-z][a-z0-9_]*$')` — no dots; `period_id` has no FK yet (left for T-0023). |
| S7 | Oracle NetSuite help "Using the Period Close Checklist", "Accounting Period Close", "Locking Accounting Periods in NetSuite OneWorld" (docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N1455781.html, …N1452509.html, …N1452163.html), via web search result summaries | 2026-10-25 | secondary (vendor docs, summarised by search) | Checklist: Lock A/R, Lock A/P (payroll with them), Lock All, then Close. "Users with the Override Period Restrictions permission can add and edit posting transactions even if the transaction type has been locked"; in a closed period no one can make GL-impacting changes. |
| S8 | Experiment: `node scratchpad/t0023/exp.ts` on the repo's throw-away PostgreSQL 16.15 harness | 2026-10-25 | experiment | (a) a role with SELECT only: `SELECT … FOR SHARE` → 42501 permission denied; (b) `pg_advisory_xact_lock_shared(hashtextextended(text, 0))` works for any role; (c) `RAISE … USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_entry_period_allows'` reaches node-pg as `code 23514`, `constraint 'journal_entry_period_allows'`; (d) `'payments.stripe.payout' ~ '^[a-z][a-z0-9_]*$'` is false. |
| S9 | `packages/shared/src/rbac/catalogue.ts`, migration 0016 | 2026-10-25 | source code | Permissions `period.close`, `period.lock`, `period.lock.override`, `period.reopen` exist (Owner, Finance Admin). The DB mirrors only role ids (`app.role_template_exists`), with a test proving agreement. |

## Findings

1. §3.5 names three posting classes: AR, AP and journals (S1). NetSuite's model is the same
   staged lock by transaction class with a single "override period restrictions" permission, and
   nobody posts in a closed period (S7). LedgerForce's "override" is therefore one permission,
   `period.lock.override` (S9), used for AR lock, AP lock and soft close.
2. The golden-posting source types (S5) cannot be stored as they are: the 0007 CHECK refuses dots
   (S6, S8 d) and a forward-only migration cannot loosen a CHECK (no DROP). *Inference:* the
   stored code is the golden name with `.` replaced by `_` (`payments.stripe.payout` →
   `payments_stripe_payout`); the matrix catalogue keeps both spellings. Rule-produced source
   types (`rule:<id>@<v>`, GP-014) need a later decision by the rules task.
3. Classification (inference from S1/S5, conservative where S1 is silent):
   AR = `ar_invoice`, `ar_credit_note`, `ar_receipt`, `ar_refund`, `ar_write_off`,
   `ar_prepayment`, `ar_prepayment_application`, `payments_stripe_charge` (a customer payment);
   AP = `ap_bill`, `ap_payment`, and — conservatively — `payroll_pay_run`,
   `payroll_net_pay_batch` (Phase 1; they are payables to staff/ATO, so AP lock needs an override);
   journals = `manual_journal`; reversal = `ledger_reversal` (needs an override whenever any lock is
   on, because voiding a locked-period invoice is an AR change); payout =
   `payments_stripe_payout` (the open question). Unknown source types are refused (fail closed).
4. Payout under AR lock is genuinely undecided (S3, S4): a payout is a settlement of AR-side cash
   (GP-004 clears Stripe clearing to bank, fee and GST) — arguably AR — but it is also a bank
   event outside the AR clerk's control. Under AP lock S1 says "journals only", so a payout needs
   an override there regardless; soft close and hard lock are unambiguous.
5. A BEFORE INSERT trigger can resolve the period and refuse the row before anything else is
   written; the engine maps the refusal by constraint name (S8 c). A posting must not race a
   status change: `FOR SHARE` on the period row needs UPDATE privilege, which lf_app must not have
   (S8 a), so a transaction-scoped advisory lock keyed by the period id is used — shared by
   posters, exclusive by status changes (S8 b). Under READ COMMITTED each statement in a PL/pgSQL
   function takes a new snapshot, so the status read after the lock sees the committed change.
6. Permissions in the DB: the same pattern as 0016 — an IMMUTABLE mirror
   `app.role_allows_period_permission(role, permission)` for the four `period.*` permissions,
   proven equal to the catalogue by a test — lets SECURITY DEFINER status functions and the
   override trigger check the actor's active roles.
7. "First open date" (S2): the earliest date after the locked period that lies in a period whose
   status *allows* the source type without override, i.e. that period's start date (October hard
   locked → 2026-11-01, UC-01 A4, SS-UC10-05). The note records the original date, the period and
   its status. If no later period allows it, the policy falls back to rejecting.

## Conclusion / decision

- Implement the matrix as a TypeScript constant (`packages/ledger/src/period-matrix.ts`), mirrored
  by IMMUTABLE SQL functions `app.source_type_class` and `app.period_decision` in migration 0018,
  with a unit table test (SS-PLAT-06), a fast-check property that DB and TS agree, and an
  exhaustive DB test that the trigger enforces every cell.
- Matrix: Open → allow all. AR locked → AR override, AP allow, journal allow, reversal override,
  **payout = tenant setting**. AP locked → AR/AP/payout/reversal override, journal allow. Soft
  closed → everything override. Hard locked → everything deny (no override; reopen only).
- **Payout under AR lock**: tenant setting `payout_under_ar_lock` = `override` (default, safe:
  treated as AR) | `allow`. Flag for the product owner (HANDOVER open question via the lead). Do
  not decide silently.
- Overrides: a row in `app.period_override` (company, period, source type, the entry's idempotency
  key, granted_by, reason), allowed only when the cell is `override` and granted_by holds
  `period.lock.override`; the posted entry's `created_by` must be that user.
- Status changes only through SECURITY DEFINER functions; hard-locked periods leave that status
  only through a reopen request + approval by a different user, both holding `period.reopen`,
  with a reason; every change is in `app.period_status_change` and `audit.audit_log`.
- Lock-date policy: tenant setting `lock_date_policy` = `reject` (default) | `post_to_first_open_date_with_note`,
  applied by `resolvePostingDate()` in the engine; the database only enforces invariant 3.
- Fiscal years: conventions as data (`AU`: 1 July; `calendar`: 1 January), 12 monthly periods per
  year, no overlaps (trigger under an advisory lock per company).

## Confidence

`high` for the mechanics (S6, S8 executed); `medium` for the classification of source types §3.5
does not name (inference, conservative); `low` for the payout cell — hedged as a tenant setting
with a safe default and flagged for the human.

## Follow-ups

- Product owner: confirm the payout cell (and the conservative AP classification of payroll
  source types, the override requirement for reversals under any lock).
- Rules task: storable source types for `rule:<id>@<v>`; bank-feed "spend/receive money" source
  types when bank rec posts journals (T-0060/T-0061) must be added to the catalogue.
- 4-4-5 / 53-week fiscal calendars are out of MVP scope.

**Affects:** packages/ledger (period control), migration 0018, design §3.3/§3.5, UC-01/03/05/08/10.
