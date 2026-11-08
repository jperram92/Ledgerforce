---
id: RQ-0043
title: How do manual journals move from draft to posted, when do they need approval, and how are control accounts protected from manual, imported and rule journals?
status: resolved
opened: 2026-10-26
resolved: 2026-10-26
opened_by: claude
linked_tasks: [T-0029]
linked_adrs: [ADR-0004, ADR-0026, ADR-0039]
superseded_by:
---

# RQ-0043 — manual journals, approval rule, control accounts

## Question

T-0029 asks for a manual journal document (draft → approve → post) "requiring approval above
$5,000 or on control/tax/equity accounts", and for every manual, imported or rule line on a
control account without a subledger source to be refused with `CONTROL_ACCOUNT` (SS-PLAT-07).

- Q1. Is there a golden posting for manual journals, and what may the build post?
- Q2. What exactly is the approval rule: amount measure, threshold, and which accounts are
  "control, tax or equity"?
- Q3. Which states and which SoD steps does the document go through, and who may do each?
- Q4. Does any manual-journal action need step-up re-authentication?
- Q5. What already enforces the control-account rule, and what do "CSV journal import" and
  "rule line" mean today, when neither feature exists?
- Q6. Where is the approver recorded on the posted entry?

## Sources consulted

| # | Source | Accessed | Kind | What it says |
|---|---|---|---|---|
| S1 | `Docs/solution-design/solution-design.md` §3.2 | 2026-10-26 | design | "Control accounts (AR, AP, payroll clearing) accept postings only from their subledger, never from manual journals, so subledger and GL can't drift." |
| S2 | same, §3.3 | 2026-10-26 | design | `journal_entry` has `created_by`, `approved_by`, `posted_at`. |
| S3 | same, §3.9 and §3 intro | 2026-10-26 | design | Every business document, "manual journal" included, passes through the one posting engine. |
| S4 | same, §6.2 | 2026-10-26 | design | Step-up re-authentication "to release payment batches, change bank details or reopen a locked period" — journals are not in the list. |
| S5 | same, §6.4 | 2026-10-26 | design | Accountant: "Post manual journals"; AR Clerk cannot post manual journals; Approver: "Approve … journals … within limits", cannot "create the items they approve". |
| S6 | same, §6.5 rule 4 and §11.2 | 2026-10-26 | design | "Manual journals: approval required above $5,000 or on any control, tax or equity account"; thresholds are configurable and the defaults are placeholders (open decision). |
| S7 | same, §4.5, §11.3 item 3 | 2026-10-26 | design | Custom rules produce journals (the example posts AR_CONTROL for a deposit *invoice*); reviewer asks whether control accounts are "protected from manual journals in every flow, including imports and custom rules". |
| S8 | `Docs/accounting/postings.md` index | 2026-10-26 | golden postings | No GP covers manual journals (GP-001…GP-019 are event postings, all Draft). |
| S9 | `packages/shared/src/sod/rules.ts`, `evaluate.ts` (T-0015, ADR-0026) | 2026-10-26 | source | Subject `manual_journal` with steps `post`, `approve`; rule `SOD_JOURNAL_SELF_APPROVAL` (approve vs post, condition `journal_approval_required`); `journalApprovalRequired({amount, controlTaxOrEquity}, settings)`; threshold `journal_approval` = 5000.0000 (DL-0131). |
| S10 | `packages/shared/src/rbac/catalogue.ts` | 2026-10-26 | source | `gl.journal.post` (Owner, Finance Admin, Accountant), `gl.journal.approve` (Owner, Finance Admin, Approver); neither is in `STEP_UP_PERMISSIONS`. |
| S11 | `packages/ledger/src/posting-command.ts`, `posting-engine.ts`; DL-0136, DL-0139 | 2026-10-26 | source | The engine refuses a line on an `is_control` account unless a control role bound to it accepts the command's source type (`CONTROL_ACCOUNT`), in validate (so also in preview). Unknown source types are refused before (`UNKNOWN_SOURCE_TYPE`). |
| S12 | `packages/ledger/src/period-matrix.ts` (RQ-0026) | 2026-10-26 | source | The source-type catalogue has one journal-class type, `manual_journal`; there is no import or rule source type. The SS-PLAT-06 tests pin the catalogue exactly. |
| S13 | `packages/modules/gl/templates/au-services-smb.json`, migration 0005 | 2026-10-26 | source | Tax-related system roles: GST_COLLECTED, GST_PAID, PAYG_WITHHOLDING; account `type` includes `equity`; control flag `is_control` exactly on AR_CONTROL, AP_CONTROL, PAYROLL_CLEARING. |
| S14 | Xero Help, "Manual journals" / "Import manual journals" (https://central.xero.com/s/article/Add-edit-or-delete-a-manual-journal, https://central.xero.com/s/article/Import-manual-journals) | not reachable from this session (proxy policy, as RQ-0032 S3); cited from prior reading | vendor docs | A manual journal is a draft, then posted; a CSV import creates manual journals (as drafts) — an import is a bulk way of entering manual journals, not a different journal kind. Xero blocks manual journals to its AR/AP system accounts. |

## Findings

1. **No golden posting** (S8). A manual journal is user-specified lines posted by the generic
   engine with source type `manual_journal` (S3, S11): the engine posts exactly the lines it is
   given and no posting rule is involved. Nothing beyond the generic engine is implemented.
2. **Approval rule** (S6, S9): approval is required when Σdebit (= Σcredit, base currency) is
   *strictly greater* than the tenant's `journal_approval` threshold (default 5,000.0000, a
   placeholder, §11.2), **or** any line touches a sensitive account: a control account
   (`is_control`), an equity account (`type = 'equity'`), or a tax account — bound to
   GST_COLLECTED, GST_PAID or PAYG_WITHHOLDING — or a line carrying a tax code or tax amount
   (it feeds the BAS). The evaluator `journalApprovalRequired` already implements the rule;
   the document computes the two facts. Control lines are refused anyway (finding 5), so the
   control part only matters fail-closed.
3. **States and SoD** (S5, S9, S10): `draft` → `submitted` → (`approved`) → `posted`, and
   `submitted` → `draft` on rejection. The preparer *submits for posting*: that is the SoD step
   `manual_journal.post` (the existing step name — the person who asks for the journal to be
   posted); the approver does `manual_journal.approve`, guarded by `SOD_JOURNAL_SELF_APPROVAL`.
   Posting is allowed from `approved`, or from `submitted` when approval is not required,
   re-evaluated with the settings at posting time (fail closed if the threshold was lowered).
   Create, edit, submit and post need `gl.journal.post`; approve and reject need
   `gl.journal.approve`.
4. **No step-up** (S4, S10): the design lists step-up actions and journals are not among them.
5. **Control accounts** (S1, S7, S11, S12, S14): the engine already refuses every non-subledger
   source type on a control account, in post and in preview, before anything is written. A CSV
   journal import is a bulk way to enter manual journals (S14), so its journals carry the
   `manual_journal` source type and meet the same check. Custom rules (§4.5) do not exist yet;
   a rule line *with* a subledger source is an AR/AP document (the §4.5 deposit is a deposit
   invoice, source `ar_invoice`); a rule journal *without* one has no subledger source type and
   is refused. Because unknown source types are refused outright and every catalogued source
   type is checked against the control mapping, a future import or rule source type cannot
   reach a control account unless it is added to the control mapping (DL-0136) — which is an
   accounting decision for the product owner. SS-PLAT-07 therefore proves the refusal at the
   engine boundary for every catalogued source type × control role, for the three labelled
   paths (manual, import, rule) and through the manual-journal document.
6. **Approver on the entry** (S2): `journal_entry.approved_by` exists (migration 0007) and is
   part of the hash chain (0009); the engine never set it. The command gets an optional
   `approvedBy` (validated like `createdBy`), written to `approved_by`.

## Conclusion

Build the manual-journal document in a new module package (`packages/modules/journals`,
table `app.manual_journal`, migration 0029) that posts only through `post()`/`preview()` of the
engine; reuse the SoD subject/steps and evaluator as they are; no step-up; no new source type;
prove SS-PLAT-07 at the engine boundary and through the document. Open for the product owner:
the tax-account interpretation of §6.5 rule 4 and whether imports/rules get their own source
types (DL-0210).
