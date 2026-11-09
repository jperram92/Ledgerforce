---
adr: 0045
title: "GST attribution for deposits and part payments: a gst_supply_pattern classification on the deposit document and a GST_ATTRIBUTED_UNBILLED system role for single (non-Div 156) supplies"
status: Proposed            # Proposed | Accepted | Rejected | Superseded by ADR-NNNN
date: 2026-11-09
author: claude
category: accounting
human_gate: yes             # accounting; claude may accept under DL-0282 only after an accountant-reviewer persona re-review with no BLOCKER
supersedes: none
superseded_by: none
---

# ADR-0045: `gst_supply_pattern` and the `GST_ATTRIBUTED_UNBILLED` role

## Status

Proposed (claude, T-0124, 2026-11-09) — human gate `accounting` (AGENTS.md §6). Under the owner's
extended delegation **DL-0282**, claude may accept it **only after** the accountant-reviewer persona
(DL-0248) has re-reviewed this file together with the golden Drafts GP-012-B and GP-015-B and found no
BLOCKER. The acceptance line must then read "Accepted <date> by claude under owner delegation DL-0282
after persona re-review <evidence path>". Until then T-0047 may not be claimed for build (its
`adr_required` gate).

## Context and problem statement

LedgerForce treats every deposit or uninvoiced part payment as a **Div 156 progressive component**:
GP-012 (uninvoiced prepayment, Option B, RQ-0095 Q7) attributes GST on 1/11 of the amount received;
GP-014 (deposit tax invoice) attributes GST on the deposit only; GP-013/GP-015 net the deposit on the
final invoice. The accountant-reviewer persona review (DL-0280 MAJOR 1,
`.agent/evidence/T-0007/accounting-review-20261108.md`) confirmed this is right **only where Div 156
applies** — a progressive or periodic supply with progressive consideration, or a deposit that is a
separate component. For a **single (non-progressive) supply** on the **accruals** basis, GST Act
s 29-5(1) attributes **all** the GST payable on the supply to the first period in which any
consideration is received or an invoice is issued. In the GP-012 example that understates 1A by
700.00 in November. A genuine security deposit (Div 99) is not consideration until applied or
forfeited (GP-012's Div 99 variant). Cash-basis attribution (s 29-5(2)) is unaffected.

The software has no way to record which case applies, and the single-supply journal (Drafts GP-012-B,
GP-015-B in `Docs/accounting/postings.md`, T-0124) needs an account for the GST reported ahead of
billing. DL-0283 and DL-0286 (M6) route both to "a separate accounting decision" for T-0047; this ADR
is that decision. ADR-0044 (tax determination) does not cover attribution timing.

Facts relied on (persona review source table; primary hosts unreachable from the build environment, so
section wording is **unverified** and rests on corroborated extracts and prior knowledge, as RQ-0095):
ATO "Progressive or periodic sales and purchases" (each component a separate sale — corroborated);
ATO edited private ruling citing GSTR 2000/35 (Div 99 deposits attributed when forfeited/applied; a
genuine deposit is not a part payment — corroborated); s 29-5(1)/(2), Div 156, Div 99 (unverified
wording, agrees with RQ-0095).

## Decision drivers

- BAS correctness on the accruals basis: never under-report 1A by silently assuming Div 156.
- The classification is a legal judgement about the contract; software must record it, not infer it.
- Balance-sheet presentation: the GST reported ahead of billing is a claim on the customer, not a
  reduction of the contract liability (AASB 101 ¶32, no offsetting).
- Fit the existing model: system roles resolve accounts (design §3.2), tax codes drive BAS labels
  (T-0035), golden postings are exact (design §3.8).
- Additive, forward-only data changes (AGENTS.md §4).

## Considered options

1. **Option A — classification + new non-control asset role, role-based BAS rule.** Store
   `gst_supply_pattern` on the deposit invoice / prepayment receipt; for `single_supply` on accruals
   post the whole GST at first payment or invoice, carrying the unbilled part on
   `system:GST_ATTRIBUTED_UNBILLED`; the BAS query treats a GST-coded line on that role as an
   attribution.
2. **Option B — classification + dedicated attribution tax code** (e.g. a sales code whose BAS
   mapping is "attribution, G1/1A positive regardless of side") on the same new role.
3. **Option C — no new role: net the unbilled GST into CUSTOMER_PREPAYMENTS** (contract liability
   2,300 instead of 3,000 + asset 700).
4. **Option D — refuse single-supply deposits permanently** and require a full tax invoice for the
   whole supply at first payment.

### Option A — rejected

Rejected (persona re-review DL-0386, M2/M3): the BAS map reads a GST debit on an asset as a purchase (G11/1B), and
the line carries no base for G1.

- Good, because the journal is exactly the reviewer's proposal (GP-012-B / GP-015-B) and keeps the
  liability and the GST asset gross.
- Good, because no new tax code: the existing GST code and rate apply; the role says why.
- Bad, because the BAS query needs a role-aware rule (a debit GST line normally reduces 1A, F4).

### Option B

- Good, because BAS stays purely code-driven (T-0035 mapping only).
- Bad, because a second sales GST code invites mis-coding on ordinary lines and needs a guard that it
  is used only on the role; more template data to maintain.

### Option C

- Good, because no new role.
- Bad, because it offsets an asset against a liability (AASB 101 ¶32) and makes the contract liability
  differ from the consideration received ex GST.

### Option D

- Good, because simplest.
- Bad, because it blocks a legitimate, common case (a single-supply job paid partly in advance) and
  forces an invoice the business may not want to issue yet.

## Decision outcome

Proposed: **Option B** (dedicated attribution tax code) on the Option A role and journal shape, per persona
re-review Q12 (DL-0386). The new role and the gross presentation of Option A are kept; the BAS stays purely
data-driven (T-0035), the code's rows are accruals-only, and a posting-engine guard ties the code to the role.

Rules (each checkable):

- **R1 — classification.** `gst_supply_pattern` ∈ {`progressive_div156`, `single_supply`,
  `security_deposit_div99`} is stored on every deposit invoice and every prepayment receipt (additive
  column, tenant table under RLS as today), NOT NULL with a CHECK and **no column default**; stored with
  `gst_supply_pattern_confirmed_by` and `_confirmed_at`. The UI pre-selects `progressive_div156` only when the
  document comes from a billing schedule with at least two milestone or period components; otherwise nothing is
  pre-selected. A document without an explicit, recorded choice is refused. Help text names the three cases and
  says that, when in doubt, `single_supply` is the conservative choice on the accruals basis. Changing it after posting is impossible (posted documents are
  immutable); a wrong classification is corrected by reversal / credit note and a new document.
- **R2 — role.** New system role **`GST_ATTRIBUTED_UNBILLED`**: account type `asset`, **not** a
  control account, postable, party optional (lines carry the customer for reconciliation). Added to
  `SYSTEM_ROLES`, the SQL role CHECK of `app.account_system_role` (additive migration that widens the
  list) and a new chart template version binding it (e.g. "GST attributed — unbilled", next free
  current-asset code, chosen by the template task). Not offset against CUSTOMER_PREPAYMENTS. Presented as an
  other current asset ('GST attributed on unbilled supplies'), outside trade receivables and outside the ECL base
  (AASB 15 ¶108: the right to the unbilled consideration is conditional).
- **R3 — single supply, accruals.** For `single_supply` on the accruals basis, the first receipt or
  invoice attributes the whole GST of the supply: GST collected is credited with the full GST; the part
  not covered by the document (supply GST − GST on the document amount) is debited to
  `GST_ATTRIBUTED_UNBILLED` with the code `GST-UB` (R6) and that tax amount (GP-012-B; deposit-invoice form in
  the GP-015-B note). The final invoice reports no further GST and credits `GST_ATTRIBUTED_UNBILLED`
  with the balance (GP-015-B). The role's balance per contract nets to 0.00 when fully billed.
- **R4 — cash basis.** On the cash basis the pattern does not change the journal: GP-012 / GP-013 /
  GP-014 / GP-015 apply (s 29-5(2)). `single_supply` R3 lines are produced only on accruals.
- **R5 — Div 99.** `security_deposit_div99` keeps the GP-012 security-deposit variant (no GST until
  applied or forfeited).
- **R6 — attribution code.** New AU tax code **`GST-UB`** ('GST attributed on unbilled
  consideration — single supply, s 29-5(1)'), rate 10%, GST account GST_COLLECTED, effective-dated
  template row. BAS map rows, **accruals only** (no cash rows): `1A` amount `tax`, flow `any`,
  positive side debit; `G1` amount `tax_grossed` (= tax × (1 + rate) / rate, half-up to cents),
  flow `any`, positive side debit. (The alternative is an additive nullable
  `journal_line.tax_base_amount` with G1 amount `base + tax`; the ADR must pick one before T-0047.)
  The posting engine refuses `GST-UB` on any account not bound to `GST_ATTRIBUTED_UNBILLED`, and
  refuses any other tax code on that role. The clearing credit in the final invoice carries no tax
  code. Test: GP-012-B gives G1 11,000.00 and 1A 1,000.00 for 2026-11; GP-015-B gives 0.00 and
  0.00 for 2026-12; reversing GP-012-B gives 0.00 and 0.00; a `GST-UB` line on any other account
  is refused.
- **R7 — display.** The BAS-preparation report lists, for each deposit or prepayment contributing to
  the period, its `gst_supply_pattern` (DL-0280 MAJOR 1 point 3; T-0047 AC-2).
- **R8 — refusal until built.** Until R2–R6 are built, posting a `single_supply` document is refused
  with a named refusal and writes nothing; it is never posted as Div 156 (DL-0286 M6, T-0047 AC-1).
- **R9 — lifecycle.**
  (a) `single_supply` requires the supply's total GST-exclusive consideration on the document. If it is
  not ascertainable (for example time and materials), `single_supply` is refused and the user chooses
  another pattern or issues a tax invoice for the ascertained amount.
  (b) Final invoice: the GST shown on the final invoice less the GST already attributed is posted as
  follows. An excess is posted with code GST on the revenue line, as an increasing Div 19 adjustment.
  A shortfall is posted as a decreasing adjustment, with an adjustment note (s 29-75) and 1B, or G1/1A
  in the same period, per `sales_adjustment_presentation`. The role is credited with its full balance.
  (c) Cancellation before the final invoice: a credit to `GST_ATTRIBUTED_UNBILLED` of its balance with
  `GST-UB`, and a debit to GST collected, posted as a Div 19 decreasing adjustment with an adjustment
  note. The 300.00 on the received part follows the refund or forfeiture path (GP-005/GP-006).
  (d) The BAS-preparation report lists every contract with a non-zero `GST_ATTRIBUTED_UNBILLED`
  balance older than 90 days.
  Golden Drafts for (b) and (c) are written by T-0047 before build.

## Consequences

### Good

- Accruals BAS is right for single supplies; the default path (Div 156) is unchanged and already golden.
- The classification is auditable on the document and visible at BAS preparation.

### Bad / accepted trade-offs

- One more system role and one more tax code (`GST-UB`) with an engine guard.
- The user must make (and own) the legal classification; the help text cannot decide it.

### Follow-ups

- T-0047 builds R1–R8 (its AC-1…AC-3 already name GP-012-B/GP-015-B; SS-PLAT-137/138).
- T-0035 (or a T-0047 sub-step) adds the `GST-UB` code, its accruals-only BAS rows (`tax_grossed` or
  `tax_base_amount`, chosen before T-0047) and the R6 tests; T-0047 adds the R9 lifecycle with golden Drafts for
  R9(b)/(c) and prompts for a tax invoice for the whole supply when `single_supply` is chosen (re-review m4).
- Golden Drafts GP-012-B / GP-015-B are approved under DL-0282 together with this ADR; the runner's
  `requires` marker (T-0047) opens them when T-0047 is done.

## Compliance and verification

| Check | Where | Gate |
|---|---|---|
| GP-012-B and GP-015-B reproduced line for line (PENDING with reason until T-0047 is done) | `packages/ledger/src/golden/golden-postings.golden.db.test.ts` | verify.sh gate 4 (golden) |
| `gst_supply_pattern` stored, CHECKed, `single_supply` refused until built | `packages/modules/ar/src/deposits.db.test.ts` (T-0047 AC-1) | test:db |
| R6: GP-012-B gives G1 11,000.00 / 1A 1,000.00 in 2026-11, GP-015-B 0 / 0 in 2026-12, reversal 0 / 0; `GST-UB` refused off the role | T-0035/T-0047 BAS report and posting-engine db tests | test:db |
| R1: no column default; a document without a recorded choice is refused | T-0047 deposits db test | test:db |
| R9: unascertainable total refused for `single_supply`; role-balance report lists balances older than 90 days | T-0047 db tests | test:db |
| Role is asset, not control; template binds it once | `packages/modules/gl` template validation tests | unit |

## Links

- Design: §3.2 (system roles), §3.8 row 10, §4.3 deposits, §4.5
- Research: RQ-0095 (Q7, Q10)
- Decision log: DL-0280, DL-0283, DL-0286 (M6), DL-0384, DL-0386 (persona re-review), DL-0387 (acceptance)
- Related ADRs: ADR-0044 (tax determination; not affected)
- Golden: `Docs/accounting/postings.md` GP-012-B, GP-015-B (T-0124); postings.md Q12
- Re-review: `.agent/evidence/T-0124/accounting-rereview-20261109.md` (RC-2 to RC-5 applied)
- Review: `.agent/evidence/T-0007/accounting-review-20261108.md` (MAJOR 1, "Proposed superseding entries")
