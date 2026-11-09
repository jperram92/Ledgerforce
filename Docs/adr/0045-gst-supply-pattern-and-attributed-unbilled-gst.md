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

### Option A

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

Proposed: **Option A**, because it keeps the statements gross, needs no new tax code, and matches the
golden Drafts that the persona proposed. Option B remains the fallback if the persona prefers
code-driven BAS (postings.md Q12).

Rules (each checkable):

- **R1 — classification.** `gst_supply_pattern` ∈ {`progressive_div156`, `single_supply`,
  `security_deposit_div99`} is stored on every deposit invoice and every prepayment receipt (additive
  column, NOT NULL with a CHECK; tenant table under RLS as today). Default **`progressive_div156`** for
  milestone or periodic service contracts, with help text naming the three cases; the user confirms
  it, the software never infers it. Changing it after posting is impossible (posted documents are
  immutable); a wrong classification is corrected by reversal / credit note and a new document.
- **R2 — role.** New system role **`GST_ATTRIBUTED_UNBILLED`**: account type `asset`, **not** a
  control account, postable, party optional (lines carry the customer for reconciliation). Added to
  `SYSTEM_ROLES`, the SQL role CHECK of `app.account_system_role` (additive migration that widens the
  list) and a new chart template version binding it (e.g. "GST attributed — unbilled", next free
  current-asset code, chosen by the template task). Not offset against CUSTOMER_PREPAYMENTS.
- **R3 — single supply, accruals.** For `single_supply` on the accruals basis, the first receipt or
  invoice attributes the whole GST of the supply: GST collected is credited with the full GST; the part
  not covered by the document (supply GST − GST on the document amount) is debited to
  `GST_ATTRIBUTED_UNBILLED` with the GST code and that tax amount (GP-012-B; deposit-invoice form in
  the GP-015-B note). The final invoice reports no further GST and credits `GST_ATTRIBUTED_UNBILLED`
  with the balance (GP-015-B). The role's balance per contract nets to 0.00 when fully billed.
- **R4 — cash basis.** On the cash basis the pattern does not change the journal: GP-012 / GP-013 /
  GP-014 / GP-015 apply (s 29-5(2)). `single_supply` R3 lines are produced only on accruals.
- **R5 — Div 99.** `security_deposit_div99` keeps the GP-012 security-deposit variant (no GST until
  applied or forfeited).
- **R6 — BAS rule.** The BAS query (T-0035) counts a GST-coded line on `GST_ATTRIBUTED_UNBILLED` as a
  sale attribution: G1 += base + tax, 1A += tax, positive on the debit side; the clearing credit in the
  final invoice carries no tax code and has no BAS effect. Project totals across periods equal the
  supply (G1 11,000.00, 1A 1,000.00 in the example).
- **R7 — display.** The BAS-preparation report lists, for each deposit or prepayment contributing to
  the period, its `gst_supply_pattern` (DL-0280 MAJOR 1 point 3; T-0047 AC-2).
- **R8 — refusal until built.** Until R2–R6 are built, posting a `single_supply` document is refused
  with a named refusal and writes nothing; it is never posted as Div 156 (DL-0286 M6, T-0047 AC-1).

## Consequences

### Good

- Accruals BAS is right for single supplies; the default path (Div 156) is unchanged and already golden.
- The classification is auditable on the document and visible at BAS preparation.

### Bad / accepted trade-offs

- One more system role and a role-aware BAS rule.
- The user must make (and own) the legal classification; the help text cannot decide it.

### Follow-ups

- T-0047 builds R1–R8 (its AC-1…AC-3 already name GP-012-B/GP-015-B; SS-PLAT-137/138).
- T-0035 (or a T-0047 sub-step) adds the R6 BAS rule and its test.
- Golden Drafts GP-012-B / GP-015-B are approved under DL-0282 together with this ADR; the runner's
  `requires` marker (T-0047) opens them when T-0047 is done.

## Compliance and verification

| Check | Where | Gate |
|---|---|---|
| GP-012-B and GP-015-B reproduced line for line (PENDING with reason until T-0047 is done) | `packages/ledger/src/golden/golden-postings.golden.db.test.ts` | verify.sh gate 4 (golden) |
| `gst_supply_pattern` stored, CHECKed, `single_supply` refused until built | `packages/modules/ar/src/deposits.db.test.ts` (T-0047 AC-1) | test:db |
| BAS rule R6: example project totals G1 11,000.00 / 1A 1,000.00 in 2026-11 and 0 / 0 in 2026-12 | T-0035/T-0047 BAS report db test | test:db |
| Role is asset, not control; template binds it once | `packages/modules/gl` template validation tests | unit |

## Links

- Design: §3.2 (system roles), §3.8 row 10, §4.3 deposits, §4.5
- Research: RQ-0095 (Q7, Q10)
- Decision log: DL-0280, DL-0283, DL-0286 (M6), DL-0384
- Related ADRs: ADR-0044 (tax determination; not affected)
- Golden: `Docs/accounting/postings.md` GP-012-B, GP-015-B (Draft, T-0124); postings.md Q12
- Review: `.agent/evidence/T-0007/accounting-review-20261108.md` (MAJOR 1, "Proposed superseding entries")
