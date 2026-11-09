---
id: RQ-0116
title: How does a supplier bill move from entry to approval to posting, and how does §6.5 rule 3 apply to it?
status: answered
opened: 2026-11-08
resolved: 2026-11-08
opened_by: claude
linked_tasks: [T-0052]
linked_adrs: [ADR-0026]
superseded_by:
---

# RQ-0116 — Bill approval workflow, thresholds and small-team mode

## Question

- **Q1.** Which amount is compared with the bill self-approval threshold ("above $1,000"): the
  net (ex-GST) amount or the gross bill total, and when is it fixed?
- **Q2.** Does every bill need an approval, or only bills above the threshold? What does
  "routing by amount" mean?
- **Q3.** Does approval post the bill (UC-05 step 4), and what happens when posting is refused
  (AP-locked period, UC-05 A2)?
- **Q4.** Who counts as "entered-by" once a bill has been sent back and edited?
- **Q5.** How is small-team mode applied to bills, and where does the exception show?
- **Q6.** How is a refused (SoD) approval audited when the refusal happens inside the caller's
  transaction?
- **Q7.** How is "re-approval after edit" enforced?

## Sources

1. Design §6.5 rule 3 ("Bills: entered-by ≠ approved-by above $1,000") and the small-team
   paragraph; §6.4 (AP Clerk enters, Approver approves; "Approver cannot create bills they
   approve"); §6.8 audit; §3.3 posted = immutable.
2. `Docs/specs/UC-05.md` main flow 3–4, A1, A2; scenarios SS-UC05-03..06 (SS-UC05-05: "a $2,750
   bill entered by user A").
3. `Docs/accounting/postings.md` GP-008 (Approved, DL-0253): net 2,500.00, GST 250.00, AP
   control credit 2,750.00.
4. ADR-0026 and the T-0015 SoD engine: `packages/shared/src/sod/{rules,evaluate}.ts`
   (SOD_BILL_SELF_APPROVAL: step `bill.approve` conflicts with `bill.enter` above
   `bill_self_approval`, small-team exception allowed), `apps/api/src/sod/sod.service.ts`
   (advisory lock key, history from `app.sod_action`, settings history, eligibility by
   permission), migration 0021 (`app.sod_exception`, `app.sod_exception_report`).
5. Precedent: manual journal approval, migration 0029 and `packages/modules/journals` (T-0029):
   deferred constraint trigger repeating preparer ≠ approver at commit.
6. RBAC catalogue `packages/shared/src/rbac/catalogue.ts`: `ap.bill.approve` held by owner and
   approver; `ap.bill.enter` by owner and ap_clerk.

## Findings

- **F1 (Q1).** The amount is the **gross bill total** (the AP control credit, base currency),
  because SS-UC05-05 calls GP-008's bill "a $2,750 bill" and 2,750.00 is its gross (net 2,500.00).
  It is computed by the posting engine's preview at **submit** and frozen on the bill
  (`approval_amount`); a changed bill must be sent back to draft and resubmitted, which
  recomputes it. "Above" is strictly greater (evaluate.ts).
- **F2 (Q2).** Every bill needs an approval before it posts (UC-05 step 3 "routes to an
  Approver"; SS-UC05-03 "nothing posts before approval"). The threshold only decides whether the
  person who entered (or edited) the bill may approve it. Routing by amount: the approval queue
  lists every bill awaiting approval with whether *this* approver may approve it — bills at or
  below the threshold may be approved by anyone holding `ap.bill.approve`, bills above it only
  by someone who did not enter it (or with a small-team exception).
- **F3 (Q3).** UC-05 step 4: on approval the bill posts. `approveBill` approves and, unless the
  caller asks not to (`post: false`), posts through the posting engine **in the same
  transaction**; a posting refusal (e.g. PERIOD_LOCKED) rolls the approval back too. For A2 the
  approver approves with `post: false` and a holder of `period.lock.override` posts the approved
  bill with `postBill(..., { periodOverride })`. `postBill` posts **approved bills only**
  (DL-0292 tightened); `previewBill` still previews draft, awaiting and approved bills.
- **F4 (Q4).** Each person who enters or edits a bill records SoD step `bill.enter` on it
  (`app.sod_action`), so an editor is an "enterer" for rule 3. This is the T-0015 action-ledger
  model; `entered_by` on the bill stays the original clerk (immutable since 0038).
- **F5 (Q5).** Small-team mode uses `evaluateSod` unchanged: when the rule is violated, the
  tenant is in small-team mode and no *other* active user holds `ap.bill.approve`, the approval
  succeeds only with an exception request (reason; optional external reviewer ≠ actor). The
  exception is written to `app.sod_exception` and therefore appears on
  `app.sod_exception_report(week)` (the Owner's weekly review report, T-0015).
- **F6 (Q6).** A refusal is not thrown: `approveBill` writes the refusal (an `audit.audit_log`
  row `sod_violation` in the same shape as the API interceptor, plus a bill approval event) and
  returns `{ outcome: 'denied', rule }` with the bill unchanged, so the caller's transaction
  commits the audit. Concurrency: the same per-subject advisory lock key as the API
  (`lf.sod:<tenant>:bill:<id>`).
- **F7 (Q7).** Approved and awaiting bills cannot be edited (0038 guard: header and lines change
  only while draft). Migration 0041 adds the workflow transitions: draft → awaiting_approval →
  approved → posted, awaiting_approval → draft (reject, reason), approved → draft (send back,
  reason); **draft → posted is refused** by the database; leaving approval for draft clears the
  approval. A deferred constraint trigger repeats rule 3 at commit (as 0029 does for journals),
  accepting a self-approval above the threshold only in small-team mode with an exception
  recorded for this bill, step and actor since the bill's submission.

## Conclusion

Implement in `@ledgerforce/ap` (`bill-approval.ts`) with migration 0041 (approval columns,
`app.bill_approval_event`, transition guard, deferred SoD check). No accounting treatment
changes: the posted journal is still GP-008. Thresholds remain the §11.2 placeholders (DL-0131).
