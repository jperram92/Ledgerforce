---
id: RQ-0012
title: Design review checklist (design §11.3 items 1–11) — reviewer findings
status: resolved
opened: 2026-10-24
resolved: 2026-10-24
opened_by: claude
linked_tasks: []
linked_adrs: [ADR-0003, ADR-0004]
---

# RQ-0012 — Design review checklist §11.3 items 1–11

## Question

Acting as the reviewing LLM: answer each §11.3 item 1–11 with pass / fail / unclear, reasons and
design references; list concrete gaps for the backlog. (Item 12 is RQ-0011.)

## Why it matters

These findings feed the backlog and the human's accounting/security decisions before build.

## Sources consulted

| # | Source | Accessed | Kind |
|---|---|---|---|
| S1 | `Docs/solution-design/solution-design.md` (2026-10-24) | 2026-10-24 | primary (design) |
| S2 | RQ-0004, RQ-0007 (executed SQL), RQ-0009, RQ-0010, RQ-0090 | 2026-10-24 | research |
| S3 | ATO GST guidance cited in RQ-0009 / RQ-0090 (attribution, bad debts) | 2026-10-24 | primary (extract) |

## Findings

### 1. Do the §3.8 standard postings balance with correct AU GST treatment? — **unclear (3 issues)**

All eleven rows balance arithmetically (e.g. sales invoice Dr AR gross = Cr revenue net + Cr GST;
Stripe settlement Dr bank net + Dr fee + Dr GST on fee = Cr Stripe clearing gross). Issues:
- **Customer prepayment** (Dr Bank / Cr Customer prepayments) has no GST. On the accruals basis GST
  is attributable when *any* consideration is received (S3, RQ-0090) — a part-payment deposit for
  a taxable supply carries GST on receipt (security deposits differ). Conflicts with the §4.5 deposit
  rule, which *does* charge GST. → human decision (golden posting).
- **Bad debt write-off** (Dr bad debts, Dr GST collected / Cr AR) is valid only on the accruals
  basis and only when written off or ≥ 12 months overdue; on the cash basis no GST adjustment
  arises (S3). The BAS mapping must report it at **1B** (decreasing adjustment), not net it in 1A.
- **Card receipt via Stripe** is the payout leg only; the receipt leg (Dr Stripe clearing /
  Cr AR at payment) and refunds/disputes are missing (RQ-0010). UC-11 (refund via Stripe) has no
  standard posting.

### 2. Can any path write journal tables without the posting engine's invariants? — **fail**
- Executed proof (RQ-0007): with only UPDATE/DELETE triggers, `lf_app` can **append balanced
  lines to a posted entry**. Needs a BEFORE INSERT guard.
- `account_balance`, `subledger_entry`, `allocation` have no DB-level invariant; any code path
  with the `lf_app` connection can write them (§3.3 lists invariants only for journal rows). The
  "posting engine only" rule (§4.6) is enforced by lint/convention, not the database.
- Recommendation: revoke INSERT on ledger tables from `lf_app`; post via a SECURITY DEFINER
  `ledger.post_entry()` owned by `lf_owner` (security ADR, human gate). Opening balances (§4.1
  step 9) and importers must also go through it.

### 3. Are control accounts protected in every flow (imports, custom rules)? — **unclear**
§3.2 says control accounts accept postings only from their subledger, but §4.5's sample rule posts
`system:AR_CONTROL` from a custom rule (with `party`). Not specified: whether a rule line on a
control account must create a `subledger_entry`, how opening-balance imports seed open items, and
whether "manual journal" includes CSV journal import. Gap: DB/engine rule "every line on a control
account has party_id and exactly one matching subledger_entry; source_type ∈ {document types}".

### 4. Does the period-status model conflict with any use case? — **unclear (gaps)**
- §3.5 states who can post by *AR/AP/journals*, but source types for **bank transactions, Stripe
  settlements, payroll journals, FX revaluation reversals, recurring journals** are not mapped to
  lock stages. Late Stripe payouts / bank fees dated in an AR-locked period (UC-03, UC-08 during
  UC-10 day 1–2) hit an undefined rule.
- With policy "reject", webhook-driven receipts would land in Sync issues every close; recommend
  default "post to first open date with note" for automated sources.
- Unrealised FX auto-reversal on day 1 of the next period (§3.7) requires that period open.
- Hard lock "after BAS lodgement" (UC-10) — BAS report is Phase 1 (see item 10).

### 5. Any field owned by both Salesforce and LedgerForce (§5.5)? — **pass, with undefined owners**
No field is listed as owned by both. Unassigned: Party payment terms, credit limit, currency, tax
status and ABN (§4.2 lists them on Party, §5.5 only says Account → Party owned by Salesforce).
ABN/tax status drive tax invoices; recommend LF-owned after initial import, or explicit
per-field ownership rows (§5.5 says ownership is data — seed it).

### 6. Are all Salesforce sync paths idempotent and recoverable after a 3-day outage? — **unclear**
- Inbound idempotency keys (§5.6.1) ✔. But CDC retention is **72 h** (RQ-0004): a 3-day outage is
  exactly at the edge; beyond it the replay ID is invalid and only reconciliation recovers. The
  design's reconciliation is *nightly*; trigger it immediately on replay-invalid.
- SystemModstamp delta queries miss **hard deletes** — need `queryAll`/`getDeleted`.
- Outbound: retries cap at 6 h then land in Sync issues requiring a click (§5.6.2) — after a 3-day
  Salesforce outage every write-back needs manual retry. Recommend automatic resume when the org
  is reachable again; manual inbox only for non-transient errors.
- Hosted orgs: refresh-token 30-day idle expiry and rotation (RQ-0005) can break recovery.

### 7. Can one user, in default mode, create a supplier, change its bank details, enter a bill and pay it? — **pass in standard mode, fail in small-team mode (by design), with gaps**
- Standard mode: payment batch creator ≠ releaser *always* (§6.5.1) and bank-detail requester ≠
  verifier (§6.5.2), so one user cannot complete the chain alone. ✔
- Small-team mode (§6.5, "one or two users"): the action is **allowed** with an exception report —
  one person can do all four steps. Visible, but the weekly acknowledgement is by the owner, who
  may be that same person; require the external reviewer (Approver) for bank-detail verification
  and batch release when an external accountant is invited.
- Gaps: (a) **who may create suppliers** is not assigned to any role; (b) **initial** bank
  details on a new supplier are not stated to require verification/cooling-off (only "changes");
  (c) bills: §6.5.3 says entered-by ≠ approved-by only **above $1,000**, while §6.4 says AP Clerk
  cannot approve own bills at all — contradiction, and the threshold invites bill-splitting;
  (d) **Owner** can create and verify? Owner "can everything" except releasing own batch — so Owner
  can request *and* verify bank details unless the requester ≠ verifier rule applies to Owner too
  (state it); (e) role combination rules (one user holding AP Clerk + Approver) not defined.

### 8. Is every tenant-owned table covered by forced RLS, and the migration role separated? — **unclear**
Intent is right (§6.7) and verified feasible (RQ-0007). Not covered: **pg-boss** tables (job
payloads contain tenant data, library-owned schema without tenant_id/RLS), the outbox, the audit
schema (§6.8), views (run as owner unless `security_invoker = true`), SECURITY DEFINER functions,
and global reference tables (need an explicit "not tenant-owned" allow-list). Policy expressions
must use `NULLIF(current_setting('app.tenant_id', true), '')` (pooled-connection trap, RQ-0007).

### 9. Can a new agent resume a half-finished task from the repository alone (§10.5)? — **pass, with tooling caveats**
HANDOVER, state.json, task card, run logs and wip commits make the state repo-resident. Caveats
from RQ-0001/0002: Codex in workspace-write cannot commit (`.git` protected) → conductor commits;
`claude -p` defaults to Manual mode → must pass `--permission-mode`; quota messages need broader
patterns and stdout scanning, otherwise a failed run is not detected as a failover trigger.

### 10. Does any MVP task depend on a Phase 1 capability? — **fail**
- **UC-12** is an MVP use case (§8.2, §9.1 MVP exit list) but the "LWC Account component" is
  listed under **Phase 1** scope (§9.1).
- **UC-05** (MVP) needs a bills inbox for emailed PDFs with suggested coding, but "receipt
  capture" is **Phase 1** (§9.1).
- **UC-10** (MVP) hard-locks "after BAS", but the BAS report is **Phase 1** (§8.1 Tax module).
- §4.1 step 9 offers "Xero import" in the MVP wizard; the Xero/MYOB importer is **Phase 1**.
- §3.2 says NZ/UK/US chart templates in Phase 1; §9.1 puts NZ/UK/US tax packs in **Phase 3**.

### 11. Missing SMB accounting areas? — **fail (gaps)**
Present: bad debts (with caveats), deferred revenue (Phase 2), payroll journals, FX, rounding.
Missing or unspecified: **GST/BAS settlement journal** (clearing GST collected/paid to an ATO
liability and payment/refund), **PAYG instalments / ATO integrated client account**; **prepaid
expenses** and **accruals with auto-reversal** (only FX revaluation auto-reverses);
**owner drawings / capital contributions** (no equity system roles); **supplier prepayments /
deposits** (no SUPPLIER_PREPAYMENTS role); **petty cash** and **credit-card accounts** as bank
types; **employee expense claims**; **early-payment discounts and small-balance write-offs**;
**GST adjustments for mixed/apportioned purchases** (private use, input-taxed use); **loan
principal/interest splits**; **depreciation journals** until the Phase 2 asset register;
**customer deposit GST** (item 1).

## Conclusion / decision

Backlog items to create (owner: backlog/scribe agents; human gates noted):
1. Golden-posting decisions (human): customer prepayment GST, bad-debt basis/BAS label, Stripe
   receipt + refund legs, AU rounding default (RQ-0009).
2. DB: BEFORE INSERT guard on journal_line; NULLIF tenant GUC; post_entry SECURITY DEFINER
   function + revoke INSERT (security ADR, human).
3. Control-account rule: party + subledger entry mandatory on control-account lines (accounting ADR).
4. Period model: source-type → lock-stage matrix incl. bank, Stripe, payroll, FX, recurring.
5. Salesforce: immediate reconciliation on replay-invalid; deletes via queryAll; auto-resume
   outbound after outage; per-field ownership seed for Party fields.
6. SoD: assign "create supplier" and "verify bank details" permissions; verification of initial
   bank details; resolve §6.4 vs §6.5.3 bill-approval contradiction; Owner subject to
   requester ≠ verifier; role-combination rules (security ADR, human — §11.2 lists SoD thresholds
   as an open decision).
7. RLS coverage list incl. pg-boss/outbox/audit/views; cross-tenant tests per table.
8. Phase alignment (human, phase gate): UC-12 LWC, UC-05 bill capture, UC-10 BAS dependency,
   wizard Xero import, template phase.
9. Accounting coverage (accounting ADRs, human): GST settlement, prepaid/accruals with
   auto-reverse, owner equity roles, supplier prepayments, petty cash/credit cards, expense claims,
   discounts/write-offs, apportionment.

## Confidence

High for items 2, 7, 10 (direct text contradictions or executed proof). Medium for accounting
judgements in items 1 and 11 — these are proposals for the human accountant, not decisions.

## Follow-ups

- Human review of items 1, 3, 6–8, 10, 11 (accounting/security/phase gates).

**Affects:** backlog generation, golden postings, ADR-0003/0004, security ADRs, design §3.2–3.8,
§4.1, §4.5, §5.5–5.6, §6.4–6.7, §8, §9.1.
