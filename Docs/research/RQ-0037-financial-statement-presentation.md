---
id: RQ-0037
title: How should the MVP trial balance, profit and loss and balance sheet be computed and presented (AU SMB, AASB/IFRS minimum)?
status: resolved
opened: 2026-10-25
resolved: 2026-10-25
opened_by: claude
linked_tasks: [T-0076]
linked_adrs: [ADR-0004, ADR-0005]
superseded_by:
---

# RQ-0037 — Financial statement computation and presentation for the MVP reports

## Question

T-0076 builds the trial balance (TB), profit and loss (P&L) and balance sheet (BS) for design
§8.1 *Reporting* (MVP), reading `app.account_balance` (design §3.3) with retained earnings
"computed at report time (cumulative prior-year P&L), as Xero does, so no closing entry is
required" (design §3.5).

- Q1. Which data source answers a report for an arbitrary date or date range, when
  `account_balance` is kept per *period* (migration 0023)?
- Q2. How is retained earnings / current-year earnings computed at report time so that
  assets = liabilities + equity always holds, including when a company *does* post the optional
  year-end closing entry?
- Q3. What is the minimum presentation an AU SMB statement needs (AASB 101 / IAS 1 line items,
  current/non-current, analysis of expenses), and which of those choices does the design leave
  open?
- Q4. What can SS-UC10-08 ("AR/AP subledgers = controls") check today, when no
  `subledger_entry` table exists yet (T-0028)?
- Q5. How should a dimension filter apply?

## Why it matters

A wrong retained-earnings formula makes the balance sheet not balance, or double counts profit
once a closing entry exists. Presentation choices (gross profit, current/non-current split, TB
roll-up of prior-year P&L) are accounting presentation and belong to the product owner when the
design does not settle them (AGENTS.md §6). Reading outside the posting engine's tables from a
module would break `packages/ledger/AGENTS.md` ("any SQL touching these tables outside this
package is a defect").

## Sources consulted

The proxy refused outbound HTTPS to ifrs.org, aasb.gov.au, legislation.gov.au and
central.xero.com on 2026-10-25 (`curl: (56) CONNECT tunnel failed, response 403`), as recorded
for RQ-0032. Rows S3–S7 are cited from prior reading and are marked so; the computational
claims are proved by the executed experiments S8–S9 instead of by those sources.

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S1 | `Docs/solution-design/solution-design.md` §3.3, §3.5, §8.1 | 2026-10-25 | primary (scope) | account_balance per company/account/period/dimension set, "reports read from here"; retained earnings computed at report time as cumulative prior-year P&L, optional year-end closing entry; Reporting MVP = TB, P&L, BS, GL detail, ageing. |
| S2 | `packages/db/migrations/0005`, `0018`, `0023`; `packages/modules/gl/templates/au-services-smb.json` | 2026-10-25 | source code | Accounts carry type and subtype (`bank`, `receivable`, `current_asset`, `fixed_asset`, `payable`, `current_liability`, `credit_card`, `equity`, `retained_earnings`, `current_year_earnings`, `operating_revenue`, `other_revenue`, `direct_cost`, `operating_expense`, `employment_expense`, `other_expense`); CURRENT_YEAR_EARNINGS is bound to a non-postable account; periods have dates and belong to a fiscal year; account_balance counts non-draft entries only, keyed by period. |
| S3 | AASB 101 *Presentation of Financial Statements* (≡ IAS 1), paras 54, 60–61, 82, 99 — https://www.aasb.gov.au/ (not reachable, proxy 403; prior reading) | 2026-10-25 | primary (standard) | Para 54 lists minimum statement-of-financial-position line items (PP&E, receivables, cash, payables, provisions, tax liabilities, issued capital and reserves …). Para 60: present current and non-current assets and liabilities separately unless a liquidity presentation is more reliable. Para 82: P&L must at least show revenue, finance costs, tax expense and profit or loss. Para 99: analyse expenses by nature or by function. |
| S4 | AASB 18 / IFRS 18 *Presentation and Disclosure in Financial Statements* (issued 2024, effective for annual periods beginning on or after 1 January 2027) — https://www.ifrs.org/ (not reachable; prior reading) | 2026-10-25 | primary (standard) | Replaces IAS 1's P&L requirements: income and expenses classified into operating, investing and financing categories with required subtotals "operating profit" and "profit or loss before financing and income taxes". |
| S5 | AASB 1060 *General Purpose Financial Statements — Simplified Disclosures for For-Profit and Not-for-Profit Tier 2 Entities* (not reachable; prior reading) | 2026-10-25 | primary (standard) | Tier 2 keeps AASB 101 recognition/presentation with reduced disclosures. Most AU SMBs are non-reporting entities that prepare special-purpose or tax-driven accounts, where the minimum is set by the users (owners, ATO, lenders), not by a standard. |
| S6 | Xero Central, "Retained earnings and current year earnings" help article (not reachable; prior reading) | 2026-10-25 | secondary (vendor) | Xero has no year-end close entry: the balance sheet shows *Current Year Earnings* = net profit from the start of the financial year to the report date, and rolls all earlier profit into *Retained Earnings*. Xero's trial balance "as at" a date shows P&L accounts year-to-date and adds prior-year profit to Retained Earnings. |
| S7 | Xero Central, "Profit and Loss report" (not reachable; prior reading) | 2026-10-25 | secondary (vendor) | Default layout: Trading Income, Cost of Sales, **Gross Profit**, Other Income, Operating Expenses, Net Profit, grouped by account type. |
| S8 | Experiment: `pnpm test:db -- packages/modules/reporting/src/reports.prop.db.test.ts` (fast-check, default numRuns, random balanced entries over FY2026 and FY2027 posted through the engine, read back mid-period and at period ends) | 2026-10-25 | experiment | TB from account_balance (whole periods) + posted lines (partial periods) equals a model of the postings; TB nets to zero; BS balances at every random date; CYE equals P&L for the year to date. Output in `.agent/evidence/T-0076/`. |
| S9 | Experiment: `reports.tb-pl-bs.db.test.ts` "a year-end closing entry does not change equity" | 2026-10-25 | experiment | Posting a closing journal (Dr revenue / Cr retained earnings) dated in the prior year leaves total equity, RE and CYE lines unchanged. |

## Findings

1. **Q1 — data source.** account_balance is keyed by period, not date (S2). A range made of
   whole periods is answered exactly from account_balance; a range that cuts a period needs the
   posted lines of that period by `entry_date` (inference; proved by S8). Every posted entry
   belongs to the one period that contains its date (0018), so splitting periods into "whole in
   range" (account_balance) and "cut" (lines filtered by date) counts every line once.
2. **Q2 — earnings.** With all postings summed to date D, Σ(debit − credit) over all accounts is
   0 (each entry balances). Splitting accounts by type: assets = liabilities + equity +
   (revenue − expenses), all credit-positive except assets (inference from the balance
   invariant). Hence the BS balances when equity includes the *whole* cumulative P&L to D:
   P&L before the start S of the fiscal year containing D goes to the RETAINED_EARNINGS line,
   P&L from S to D to the CURRENT_YEAR_EARNINGS line (S1, S6). A closing entry (Dr revenue /
   Cr RE, dated in year Y−1) lowers prior-year P&L and raises posted RE by the same amount, so
   the formula needs no special case (S9).
3. **Q3 — presentation minimum.** AASB 101 asks for line items, a current/non-current split and
   an expense analysis (S3); AASB 18 changes P&L categories for years from 2027-01-01 (S4); most
   AU SMBs are not reporting entities (S5). The design names no layout; Xero's layout (S7) adds
   a Gross Profit subtotal. Which subtotals to show, whether to split current/non-current (the
   chart has no current/non-current flag, only subtypes) and whether the TB rolls prior-year
   P&L into retained earnings are **presentation choices the design leaves open** → human.
4. **Q4 — subledgers.** No `subledger_entry` table exists before T-0028 (S2). The control-account
   balances can be reported; the subledger side cannot be checked yet.
5. **Q5 — dimensions.** A dimension set holds a sorted list of value ids (0006). Filtering the
   sets that contain all requested values (`value_ids @> filter`) gives "department = SALES" and
   combinations. A filtered TB need not net to zero (one entry may split across departments),
   so a filtered TB reports its totals but does not claim balance; the BS has no filter.

## Conclusion / decision

- Put the period/line read in `packages/ledger` (`accountMovements`, read-only, next to
  `trialBalance`) and the statements in a new module `packages/modules/reporting` (design §8.1
  names *Reporting* as a module); the module never touches ledger tables itself.
- TB: one row per account with posted activity in [from, to] (from omitted = from the first
  period), its net balance on the debit or credit side; totals and `netsToZero`. No computed
  lines (rows are real ledger balances) until the human decides the roll-up question.
- P&L for [from, to]: sections revenue then expense, grouped by subtype in chart-template order,
  revenue credit-positive, expenses debit-positive, net profit = revenue − expenses. No gross
  profit subtotal until decided.
- BS at D: requires the fiscal year containing D; assets (debit-positive), liabilities and equity
  (credit-positive) grouped by subtype; RETAINED_EARNINGS line = its posted balance + P&L
  before S; CURRENT_YEAR_EARNINGS line = its posted balance + P&L from S to D; both lines always
  shown and flagged `computed`; `balanced` = assets equal liabilities + equity.
- TB review (SS-UC10-08): TB as at the period end, `netsToZero`, and the AR/AP control balances
  with `subledger: not_available` until T-0028 adds subledger_entry (decision-log entry).
- Money stays NUMERIC text from SQL and `Money` (decimal.js) in code.

## Confidence

`high` for Q1, Q2, Q4, Q5 (source code and executed experiments S8, S9). `medium` for Q3: the
standards could not be re-opened in this session; the build hedges by not choosing — the open
presentation items go to the product owner and the layout is data-driven by type/subtype.

## Follow-ups

- Human (presentation, design silent): (a) TB as-at — keep raw account balances, or roll
  prior-year P&L into retained earnings like Xero? (b) P&L — add a Gross Profit subtotal
  (operating revenue − direct cost)? adopt AASB 18 categories for years from 2027? (c) BS —
  current/non-current split (needs a chart flag or a subtype mapping)? (d) BS by dimension?
- T-0028 / T-0078: fill the subledger side of the TB review once subledger_entry exists.
- Re-open S3–S7 when network access allows and update this record's source rows.

**Affects:** packages/ledger (read API), packages/modules/reporting, T-0077, T-0078, T-0090.
