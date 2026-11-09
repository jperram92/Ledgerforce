# Accounting re-review: T-0124 Drafts GP-007-A, GP-012-B and GP-015-B, errata E-001 to E-004, and ADR-0045 (2026-11-09)

> **Honesty statement.** This is an AI persona modelled on the knowledge and professional standards
> of an Australian Chartered Accountant / CPA who is also a registered tax agent. It is **not** a
> registered practitioner, holds no TPB registration, carries no professional indemnity insurance
> and cannot sign or lodge anything. The product owner chose this persona instead of paid external
> review (DL-0248). Its findings are the best available technical review, not professional advice.

Reviewer: accountant-reviewer (claude persona). Worktree `agent-a09be205b24e68430`, branch
`feat/T-0124-golden-drafts`, reviewed at 57b162f. Everything was read-only except this file and DL-0386.
`Docs/accounting/postings.md` and the ADR were not changed.

**Independence note.** The Drafts implement this persona's own earlier proposals (DL-0280 MAJOR 1 and
MAJOR 2, plus MINORs). Re-reviewing my own proposals is a self-review threat (APES 110). I therefore
re-derived each journal from its scenario before reading the drafted lines. I also re-tested my
earlier proposals against the engine's BAS map and AASB 9 instead of assuming they were right. One
of them (Q14, ECL net of GST) I now withdraw. See M1.

## Overall: **PASS WITH MAJORS**: 0 BLOCKER, 5 MAJOR, 7 MINOR, 16 CONFIRMED

- Every journal balances.
- Each drafted line matches my independent derivation: A1/A2/A3, GP-012-B, GP-015-B, and the
  single-supply deposit-invoice note.
- E-001 to E-004 are correct. All 23 E-001 rows match `packages/modules/gl/templates/au-services-smb.v2.json`.

**No BLOCKER.** Nothing here misstates the BAS or the statements as it can run today:
- GP-012-B and GP-015-B are PENDING behind T-0047, and ADR-0045 R8 refuses a `single_supply`
  document until the path is built.
- GP-007-A's A1 is an estimate posted by a manual journal.

**Why the MAJORs.** They concern what would be *built* from these texts:
- **M2/M3.** If built as written, ADR-0045 Option A would misreport the BAS. The shipped label map
  reads a GST debit on an asset as a purchase. The 7,000.00 base needed for G1 is carried nowhere.
  The ADR's own compliance test (G1 11,000.00) would catch both errors, so they fail closed, but they
  must be fixed in the text first.
- **M1.** My earlier proposal to measure the ECL net of GST is not the AASB 9 measure.
- **M4/M5.** These are gaps in the ADR rules: a silent default, and the contract lifecycle.

Under DL-0282, claude may approve and accept **after** applying the required changes RC-1 to RC-5
below. This follows the ADR-0044 precedent (DL-0285): MAJORs that tests would lock in are fixed in
the wording before approval. E-001 to E-004 may be approved now.

### Method

- For each scenario I wrote out the journal, tax amounts and BAS labels before reading the drafted
  tables.
- I checked the engine's actual behaviour:
  - `packages/modules/tax/src/bas-compute.ts`: the flow is decided by account type, and `net` is the
    line amount.
  - The BAS rows in `packages/modules/tax/templates/au-tax-codes.json`: GST sales rows credit +, GST
    purchase rows debit +, ADJ-BD flow `any` 1B debit, accruals only.
  - `packages/ledger/src/tax-lines.ts`: the tax amount is stored as given and is not reconciled to
    the GST line.
  - `packages/modules/journals/src/manual-journals.ts`.
- I checked the chart v2 JSON.
- I checked the T-0124 runner output: GP-007-A passes in draft mode, and GP-012-B/GP-015-B are
  PENDING.
- I checked every weekday and business-day count with a date library.

### Source confirmation (2026-11-09)

Primary hosts are still blocked: `www.ato.gov.au`, `www.legislation.gov.au` and `www.aasb.gov.au`
return proxy `CONNECT tunnel failed, response 403`. Search extracts only:

| Source / claim | Status |
|---|---|
| ATO "choosing an accounting method" / "when to account for GST": on accruals, account for the GST payable on the sale in the period you issue a tax invoice or receive full **or part** payment, whichever is first | Corroborated by extract (two ATO pages). Supports the whole-GST attribution in GP-012-B. s 29-5(1) wording not opened. |
| ATO "Progressive or periodic sales": do not report the whole amount at the first payment for a progressive sale | Corroborated by extract (a fresh extract, the same as on 2026-11-08). |
| ATO edited private ruling 1011792288728: a Div 99 deposit is attributed when forfeited or applied; a genuine deposit is not a part payment | Corroborated by extract (cites GSTD 2000/1). |
| AASB 9 ¶5.5.15 (simplified approach), ¶5.5.17 / B5.5.55 (cash shortfalls; only credit enhancements integral to the contract count), ¶5.4.4 (write-off); AASB Int 1031 (receivables include GST) | **Unverified**: prior knowledge. No search result addresses the GST-inclusive ECL base directly. The NT government report extract shows the allowance held against trade receivables, with GST receivable a separate line. |
| s 21-5 attribution when the 12-month-overdue date falls in an earlier month than the write-off | **Unverified** (see m2). |
| GST (Particular Attribution Rules) Determination: consideration not ascertainable at attribution | **Unverified**. The search returned only Indian GST material (see M5). |

---

## Findings

| Item | Verdict | Severity | Standard / law | Finding | Proposed change |
|---|---|---|---|---|---|
| GP-007-A A1 amount / Q14 | Non-preferred measurement | **MAJOR (M1)** | AASB 9 ¶5.5.15, ¶5.5.17, B5.5.55; AASB Int 1031; AASB 101 ¶32; AASB 137 ¶31–35 (contingent assets) | The receivable's gross carrying amount is 1,375.00, GST-inclusive under Int 1031. The ECL is the shortfall of the *contractual* cash flows from Acme, which is 1,375.00. The Div 21 relief of 125.00 is a statutory right against the ATO. It is not a cash flow of the receivable and not a credit enhancement integral to its terms. It arises only at write-off or 12 months overdue. Netting it into the allowance (1,250.00) recognises a contingent recovery early and offsets a tax item against a receivable. **I proposed the net figure on 2026-11-08 and withdraw it.** Net profit over the life of the debt is the same (1,250.00); only timing and presentation differ, so this is not a BLOCKER. | RC-1: A1 becomes 1,375.00. A2 lines are unchanged: the write-off charges the ex-GST amount to the allowance and ADJ-BD relieves the GST. A new A4 releases the 125.00 left in the allowance. Net measurement may remain a documented tenant policy (A1 is a manual journal, so there is no engine change). |
| GP-007-A A2 | Confirmed | CONFIRMED | AASB 9 ¶5.4.4; s 21-5; ADJ-BD map (1B, accruals, flow any) | Dr allowance 1,250.00 (ADJ-BD, tax 125.00), Dr GST collected 125.00, Cr AR 1,375.00. The engine map gives 1B +125.00 on accruals and nothing on cash. The 1290 asset line with flow `any` matches. Correct under either measurement basis. | — |
| GP-007-A A3 | Confirmed | CONFIRMED | as A2 | 1,000.00 (tax 100.00) + 250.00 (tax 25.00) + 125.00 = 1,375.00. 1B 125.00. Correct. | Scenario wording only (RC-1: "allowance available 1,000.00"). |
| GP-007-A allowance rule | Ambiguous | MINOR (m1) | AASB 9 ¶5.5.15 (portfolio provision matrix) | "Up to the amount held for the debt" cannot be computed: A1 is portfolio-level and has no subledger or party. | RC-1 wording: the user states the charge, with a default and a cap. |
| GP-007-A 1B period | Note | MINOR (m2) | s 21-5 (attribution wording unverified) | The debt reached 12 months overdue on 2027-11-19 (Fri), and the write-off is 2027-12-01. A quarterly reporter has both dates in Oct–Dec 2027, so there is no difference. A monthly reporter may have an entitlement attributable to November. Claiming in December is conservative (later), so it is safe. | Note only: "monthly reporters: see s 21-5; the engine attributes 1B at the write-off date". Re-check the primary text. |
| GP-007-A A1 source type / Q13 | Confirmed | CONFIRMED | AASB 108 ¶32–38 (estimates); design §6.5 rule 4 | `manual_journal` fits: it touches no control account and no subledger, and it is a judgement. It goes through SoD submit → approve → post (manual-journals.ts). | See the Q13 answer. |
| GP-007-A wording "Supersedes GP-007 (part)" | Wording | MINOR (m3) | — | GP-007-A changes nothing in GP-007. It is a variant, so "supersedes" misleads a reader into thinking GP-007 is partly invalid. The same applies to GP-015-B versus GP-015. For GP-012-B the superseded part is real: GP-012's *Residual risk* paragraph ("treats deposit + final invoice as progressive components") is no longer true once the classification exists. | Write "Variant of GP-007 (complements; GP-007 unchanged)" and "Variant of GP-015". In GP-012-B write "Variant of GP-012; supersedes only GP-012's *Residual risk* note". |
| GP-007-A presentation (1290 deducted from trade receivables) | Confirmed | CONFIRMED | AASB 9; AASB 7 ¶35H (Tier 1); AASB 1060 | Correct. | — |
| GP-012-B journal | Confirmed | CONFIRMED | s 29-5(1) (corroborated by extract); AASB 15 ¶106; AASB 101 ¶32 | My derivation: Dr bank 3,300.00, Dr unbilled-GST asset 700.00 / Cr contract liability 3,000.00, Cr GST collected 1,000.00. Σ 4,000.00. Identical to the draft. The contract liability is the consideration received net of GST. The 700.00 is gross, not offset. | — |
| GP-012-B BAS expectation | Confirmed | CONFIRMED | s 29-5(1); ATO accruals guidance (extract) | November: G1 +11,000.00, 1A +1,000.00. Cash basis: GP-012 (G1 3,300.00, 1A 300.00). Correct. | — |
| GP-012-B line 2 carrier / Q12 (ADR Option A, R6) | Fails unsafe | **MAJOR (M2)** | BAS 1A/1B; DL-0277 flow rule | With the shipped map, a debit with code `GST` on an **asset** has flow `purchases`. It would give **G11 +1,400.00 and 1B +700.00**: a 700.00 credit claimed instead of 700.00 reported. That is a 1,400.00 swing in net GST. Option A only works if a role-aware exception overrides the code-driven map. If that exception is missed, or the role is bound to an unexpected account, the failure is under-reporting. R8 and the PENDING marker stop it today. | RC-2: adopt **Option B**, a dedicated accruals-only attribution code with an engine guard (Q12 answer). |
| GP-012-B G1 base / ADR R6 | Spec gap | **MAJOR (M3)** | BAS G1 | R6 says "G1 += base + tax". The engine's `net` is the line amount, which is **700.00**, not 7,000.00. So R6 as written gives G1 +1,400.00 for line 2, and a November G1 of **4,700.00, not 11,000.00**. The 7,000.00 base is recorded nowhere in the journal. The golden's own expectation would catch this in a test (fails closed), but the ADR text is wrong. | RC-2: define the G1 amount. Either a new map amount kind `tax_grossed` = tax × (1 + rate) / rate, half-up to cents, or an additive nullable `journal_line.tax_base_amount`. The ADR picks one, and the R6 test asserts G1 11,000.00. |
| GP-012-B subledger and classification text | Confirmed | CONFIRMED | — | Unapplied −3,000.00 net. The classification is stored and shown on BAS preparation, and refused until built. | — |
| GP-015-B journal | Confirmed | CONFIRMED | AASB 15 ¶31/¶38; s 29-5(1) | My derivation: Dr AR 7,700.00, Dr contract liability 3,000.00 / Cr revenue 10,000.00, Cr unbilled-GST asset 700.00. Σ 10,700.00. Identical. December G1 0 and 1A 0. The project's GST of 1,000.00 is all in November. | — |
| GP-015-B single-supply deposit-invoice note | Confirmed | CONFIRMED | s 29-5(1)(b) | Dr AR 3,300.00, Dr unbilled 700.00 / Cr liability 3,000.00, Cr GST 1,000.00. Correct: invoice issue attributes the whole GST. Under RC-2 the 700.00 line carries the new code. | Wording follows RC-2. |
| GP-012-B / GP-015-B tax invoice | Note | MINOR (m4) | s 29-70 (tax invoice within 28 days of request); s 29-10(3) | A registered customer on the accruals basis can claim the full 1,000.00 only when it holds a tax invoice. When the whole GST is attributed at first payment, the natural document is a tax invoice for the whole supply. Otherwise the recipient's credit lags the supplier's 1A. | T-0047 should prompt "issue a tax invoice for the whole supply (GST 1,000.00)" when `single_supply` is chosen. Note only. |
| ADR-0045 R1 default | Unsafe default | **MAJOR (M4)** | s 29-5(1); Div 156; APES 110 due care | "NOT NULL … Default `progressive_div156`" can be read as a column DEFAULT, or as a pre-selection the user clicks past. Either way the software silently assumes Div 156. That is the very behaviour DL-0280 MAJOR 1 found unsafe, because it can understate 1A. The conservative position (over-attribution, with no penalty exposure) is the opposite. | RC-3: no DB default. Pre-select `progressive_div156` only when the document comes from a billing schedule with at least 2 milestone or period components. Always store an explicit recorded choice (`confirmed_by`, `confirmed_at`). Refuse to post without it. |
| ADR-0045 lifecycle | Incomplete | **MAJOR (M5)** | Div 19 (adjustment events), s 29-75 (adjustment notes), s 29-5; particular attribution rules (unverified) | R3 assumes the supply is fully billed at the attributed price. Gaps: (a) cancellation leaves the 700.00 stranded; (b) a final price above or below 10,000.00 needs an increasing or decreasing adjustment; (c) the "whole GST" needs a fixed total consideration, which time-and-materials work lacks; (d) a balance left on the role shows no exception. | RC-4: add R9, covering cancellation and variation journals, the final-invoice difference rule, a required fixed total, and a per-contract role-balance report. |
| ADR-0045 R2 presentation | Incomplete wording | MINOR (m5) | AASB 15 ¶108; AASB 101 ¶54–¶55, ¶32 | The 700.00 is not a receivable (the right to the 7,700.00 is conditional on performance) and not GST recoverable from the ATO. It should be presented as an other current asset ("GST attributed on unbilled supplies"), outside trade receivables and outside the ECL base. | Add one sentence to R2 (RC-5). |
| ADR-0045 R4 cash basis, R5 Div 99, R7 display, R8 refusal | Confirmed | CONFIRMED | s 29-5(2); Div 99 (extract) | Correct. With RC-2 the code's rows are accruals-only, which also protects a cash-basis company that switches basis mid-contract. | — |
| ADR-0045 Option C rejection (netting) | Confirmed | CONFIRMED | AASB 101 ¶32 | The counterparties differ (customer versus the contract liability presentation). Not offsetting is right. | — |
| ADR-0045 Option D rejection | Confirmed | CONFIRMED | — | A legitimate case should not be blocked. | — |
| E-001 reference chart v2 | Confirmed | CONFIRMED | — | All 23 bindings and codes match template v2. 1290 is asset, receivable, credit-normal, non-control. 1500 now defaults to CAP. 2350 PAYROLL_CLEARING is a control account. The golden world maps the `setting:` names to the template's suggested-setting keys (golden-world.ts lines 44–60). | — |
| E-002 | Confirmed | CONFIRMED | — | 2350 Payroll clearing (control) and 2330 Superannuation payable confirmed in the template. | — |
| E-003 dates | Confirmed | CONFIRMED | Payday Super (from 1 July 2026; extract); TAA 1953 Sch 1 (W1/W2 by payment) | 2027-07-14 is a Wed and 07-15 a Thu. Seven business days: 07-15 → **Mon 2027-07-26**; 07-14 → **Fri 2027-07-23**. No national holiday falls in the window. W1/W2 in the period paid is correct. | — |
| E-003 GP-020 payday | Wording | MINOR (m6) | Payday Super (QE day = day paid to the employee) | "payday 2027-07-14 (the provider debit)": payday is when the employees are paid. A provider often debits the employer one or two days earlier. | "payday = the date the provider pays the employees, assumed here to be the debit date 2027-07-14". |
| E-004 | Confirmed | CONFIRMED | AASB 15 ¶47 | Matches my 2026-11-08 MINOR. It is a report rule only. | — |
| Q13 implementation note | Note | MINOR (m7) | AASB 9 ¶5.5.17 (reasonable and supportable information); record keeping | A manual A1 leaves the provision-matrix inputs outside the ledger. | Attach the ECL working (ageing buckets, loss rates) to the manual journal. A later `ar.ecl_provision` must store the inputs per run. |

---

## Answers to the open questions

**Q12: Option B, a dedicated attribution tax code.**

The deciding facts come from the engine:
- The BAS map is code-driven.
- `flowOf` treats any asset line as a purchase, so Option A's GST-coded debit on an asset reports
  G11/1B unless a role exception is added.
- The base for G1 (7,000.00) is not on the line.

Option A therefore needs two special cases in the BAS query. If the role exception is missing or
the role is mis-bound, the failure is under-reporting.

Option B keeps the BAS purely data-driven, as T-0035 intends:
- The code's rows are accruals-only, so cash basis has no effect by construction.
- A reversal swaps the side and reverses 1A/G1 symmetrically.

The ADR's objection to Option B is mis-coding. A posting-engine guard answers it: the code is
allowed only on the GST_ATTRIBUTED_UNBILLED role. Keep the new role and the gross presentation from
Option A.

**Q13: `manual_journal` now.**

An ECL allowance is an accounting estimate (AASB 108). A1 touches no control account or subledger,
and the manual-journal workflow gives SoD approval and an audit trail. Requirements:
- Attach the provision-matrix working.
- Post A1 as a remeasurement to the target balance at each reporting date, not as a one-off charge.

Add `ar.ecl_provision` only when T-0048 automates a provision matrix. That source should store the
run inputs (ageing buckets, loss rates, forward-looking adjustment), and should be a superseding Draft
with the same lines. Optionally restrict postings to 1290 to `manual_journal`, `ar.write_off` and
the future `ar.ecl_provision`. That is a product control, not an accounting requirement.

**Q14: gross, GST-inclusive (1,375.00).** This withdraws my 2026-11-08 proposal.

- **Measurement.** AASB 9 measures ECL as the shortfall of the receivable's contractual cash flows,
  and the receivable includes GST (Int 1031). The Div 21 decreasing adjustment arises only when the
  debt is written off or has been overdue for 12 months. It is a separate statutory right against
  the ATO, not part of the receivable's cash flows.
- **Before write-off.** The relief is at most a contingent asset (AASB 137). Netting it into the
  allowance anticipates it and offsets a tax item against a receivable.
- **At write-off.** Charge the ex-GST amount (1,250.00) to the allowance, so the ADJ-BD convention
  is unchanged. The 125.00 GST portion is relieved through 1B. Release the 125.00 left in the
  allowance by remeasurement (A4). The life-of-debt loss is still 1,250.00.
- **Alternative.** A tenant may document a net-of-GST measurement policy where the difference is
  immaterial or the statements are special-purpose. A1 is a manual estimate, so the engine is
  unaffected; the policy should be disclosed. The golden should illustrate the gross basis.

---

## Required changes before approval or acceptance (RC-1 to RC-5)

### RC-1: GP-007-A (M1, m1)

1. **Scenario.** Replace "provides an ECL allowance of 1,250.00 for it — the expected loss net of the
   GST that the bad-debt adjustment will recover (A1)" with:

   > "provides an ECL allowance of 1,375.00 for it — the lifetime expected credit loss on the
   > GST-inclusive gross carrying amount (AASB 9 ¶5.5.15; receivables include GST, AASB Int 1031). The
   > Div 21 GST relief is not a cash flow of the receivable and is recognised only when the decreasing
   > adjustment arises (A2)."

   Replace "when the allowance held is only 1,000.00" with "when the allowance available is only
   1,000.00".

2. **A1 table:** 1,375.00 / 1,375.00 (Total 1,375.00).

3. **A2 and A3 tables:** unchanged.

4. **Add A4:**

   **A4 — remeasurement after the write-off (adjusting manual journal, 2027-12-31): release of the GST
   portion left in the allowance**

   | # | Account | Ref | Debit | Credit | Tax code | Party |
   |---|---|---|---:|---:|---|---|
   | 1 | setting:ar.ecl_allowance_account | 1290 | 125.00 | | — | — |
   | 2 | setting:ar.bad_debt_account | 6500 | | 125.00 | — | — |
   | | **Total** | | **125.00** | **125.00** | | |

   In practice A4 is part of the next period-end remeasurement of the whole allowance.

5. **Check row.** Replace "after A1 + A2 the allowance for INV-000140 is 0.00 and the P&L shows the
   1,250.00 loss once (in the period of A1), exactly as GP-007 shows it at write-off" with:

   > "after A1 + A2 + A4 the allowance for INV-000140 is 0.00; the P&L shows 1,375.00 in FY2027 (A1)
   > and −125.00 in FY2028 (A4), a life-of-debt loss of 1,250.00 = GP-007".

   Add "A4 125.00 = 125.00 ✓".

6. **Allowance rule.** Replace the first sentence with:

   > "The write-off charges to the allowance the written-off amount **excluding GST** (the GST portion
   > is relieved through ADJ-BD), up to the amount the user assigns from the allowance. The default is
   > the lesser of that ex-GST amount and the allowance account's credit balance, and it never takes
   > the allowance to a debit balance. Any excess debits `setting:ar.bad_debt_account` on its own line
   > with the same ADJ-BD tax split (A3). Any allowance left (A2: 125.00) is released at the next
   > remeasurement (A4)."

7. **Add a policy note:**

   > "A tenant may adopt, as a documented accounting policy, measurement net of the recoverable GST
   > (A1 = 1,250.00, no A4); A1 is a manual estimate, so the engine is unaffected."

8. **Q14 answer column:** "Gross (1,375.00), persona re-review 2026-11-09, `accounting-rereview-20261109.md`".

   **Q13 answer column:** "`manual_journal` confirmed; `ar.ecl_provision` with stored matrix inputs when
   T-0048 automates the matrix".

9. **Header wording (m3):** "Supersedes GP-007 (part)" → "Variant of GP-007 (complements; GP-007
   unchanged)".

### RC-2: GP-012-B, GP-015-B and ADR-0045 Option B (M2, M3)

1. **ADR-0045 Decision outcome:** "Proposed: **Option B** (dedicated attribution tax code) on the
   Option A role and journal shape, per persona re-review Q12". Keep Option A's text in *Considered
   options*, marked "rejected: the BAS map reads a GST debit on an asset as a purchase (G11/1B), and
   the line carries no base for G1".

2. **Replace R6 with:**

   > "**R6 — attribution code.** New AU tax code **`GST-UB`** ('GST attributed on unbilled
   > consideration — single supply, s 29-5(1)'), rate 10%, GST account GST_COLLECTED, effective-dated
   > template row. BAS map rows, **accruals only** (no cash rows): `1A` amount `tax`, flow `any`,
   > positive side debit; `G1` amount `tax_grossed` (= tax × (1 + rate) / rate, half-up to cents),
   > flow `any`, positive side debit. (The alternative is an additive nullable
   > `journal_line.tax_base_amount` with G1 amount `base + tax`; the ADR must pick one before T-0047.)
   > The posting engine refuses `GST-UB` on any account not bound to `GST_ATTRIBUTED_UNBILLED`, and
   > refuses any other tax code on that role. The clearing credit in the final invoice carries no tax
   > code. Test: GP-012-B gives G1 11,000.00 and 1A 1,000.00 for 2026-11; GP-015-B gives 0.00 and
   > 0.00 for 2026-12; reversing GP-012-B gives 0.00 and 0.00; a `GST-UB` line on any other account
   > is refused."

3. **GP-012-B line 2 tax-code cell:** `GST-UB (tax 700.00)`. Rewrite the *Line 2* note to name GST-UB
   and R6, and delete "by the F4 convention a GST-coded debit line normally reduces 1A, so the BAS
   query needs the ADR-0045 rule (a GST line on the GST_ATTRIBUTED_UNBILLED role counts …)".

4. **GP-015-B deposit-invoice note:** "Dr GST_ATTRIBUTED_UNBILLED 700.00 (GST-UB, tax 700.00)".

5. **Q12 answer column:** "Option B (`GST-UB`), persona re-review 2026-11-09".

6. **Runner `requires` reason:** add "tax code GST-UB".

### RC-3: ADR-0045 R1 (M4)

Replace "NOT NULL with a CHECK … Default **`progressive_div156`** for milestone or periodic service
contracts, with help text naming the three cases; the user confirms it, the software never infers it"
with:

> "NOT NULL with a CHECK and **no column default**; stored with `gst_supply_pattern_confirmed_by` and
> `_confirmed_at`. The UI pre-selects `progressive_div156` only when the document comes from a billing
> schedule with at least two milestone or period components; otherwise nothing is pre-selected. A
> document without an explicit, recorded choice is refused. Help text names the three cases and says
> that, when in doubt, `single_supply` is the conservative choice on the accruals basis."

### RC-4: ADR-0045, new R9 for the lifecycle (M5)

> "**R9 — lifecycle.**
> (a) `single_supply` requires the supply's total GST-exclusive consideration on the document. If it is
> not ascertainable (for example time and materials), `single_supply` is refused and the user chooses
> another pattern or issues a tax invoice for the ascertained amount.
> (b) Final invoice: the GST shown on the final invoice less the GST already attributed is posted as
> follows. An excess is posted with code GST on the revenue line, as an increasing Div 19 adjustment.
> A shortfall is posted as a decreasing adjustment, with an adjustment note (s 29-75) and 1B, or G1/1A
> in the same period, per `sales_adjustment_presentation`. The role is credited with its full balance.
> (c) Cancellation before the final invoice: a credit to `GST_ATTRIBUTED_UNBILLED` of its balance with
> `GST-UB`, and a debit to GST collected, posted as a Div 19 decreasing adjustment with an adjustment
> note. The 300.00 on the received part follows the refund or forfeiture path (GP-005/GP-006).
> (d) The BAS-preparation report lists every contract with a non-zero `GST_ATTRIBUTED_UNBILLED`
> balance older than 90 days.
> Golden Drafts for (b) and (c) are written by T-0047 before build."

### RC-5: wording (m5, m6; m3 for GP-012-B and GP-015-B)

- **ADR R2.** Add: "Presented as an other current asset ('GST attributed on unbilled supplies'),
  outside trade receivables and outside the ECL base (AASB 15 ¶108: the right to the unbilled
  consideration is conditional)."
- **E-003, GP-020 bullet:** "payday is the date the provider pays the employees, assumed here to be the
  debit date **2027-07-14**".
- **GP-012-B:** "Supersedes GP-012 (part)" → "Variant of GP-012; supersedes only GP-012's *Residual
  risk* note".
- **GP-015-B:** "Supersedes GP-015 (part)" → "Variant of GP-015 (GP-013/GP-015 unchanged)".

### What may be approved when

- **E-001, E-002 and E-004** may be approved now.
- **E-003** may be approved now; the m6 wording is recommended.
- **GP-007-A** may be approved after RC-1 and a green runner. A1 changes to 1,375.00 and A4 is new.
- **GP-012-B, GP-015-B and ADR-0045** may be approved or accepted after RC-2 to RC-5. The runner stays
  PENDING behind T-0047 in either case.

## Proposed superseding entries

The full corrected GP-007-A tables are in RC-1. The A2 and A3 tables are unchanged, and A4 is shown
in RC-1 item 4.

The corrected GP-012-B table (only the line 2 tax-code cell changes):

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | bank:OPERATING | 1010 | 3,300.00 | | — | — |
| 2 | system:GST_ATTRIBUTED_UNBILLED | new (ADR-0045) | 700.00 | | GST-UB (tax 700.00) | Acme |
| 3 | system:CUSTOMER_PREPAYMENTS | 2400 | | 3,000.00 | GST (tax 300.00) | Acme |
| 4 | tax:GST.collected | 2310 | | 1,000.00 | GST | — |
| | **Total** | | **4,000.00** | **4,000.00** | | |

The BAS for 2026-11 with RC-2 rows:
- G1 = 3,300.00 (line 3, gross) + 700.00 × 11 = 7,700.00 (line 2, `tax_grossed`), giving 11,000.00.
- 1A = 300.00 + 700.00 = 1,000.00.

GP-015-B is unchanged.

## Items to re-check when primary sources are reachable

Allow `www.ato.gov.au`, `law.ato.gov.au`, `www.legislation.gov.au`, `www.austlii.edu.au` and
`www.aasb.gov.au`, then check:

1. **GST Act:**
   - s 29-5(1) (whole GST of the supply at the first payment or invoice) and Div 156 (s 156-5, s 156-10).
   - Div 19 (adjustment events on cancellation and price variation) and s 29-75.
   - s 21-5: the attribution period when the 12-month-overdue date and the write-off fall in
     different months (m2).
2. **Particular attribution rules:** the GST (Particular Attribution Rules) Determination rule for
   consideration not ascertainable when first attributed (R9(a)).
3. **AASB 9:** ¶5.5.15, ¶5.5.17, B5.5.55 and ¶5.4.4.
4. **AASB Int 1031:** the operative window, and whether any AASB or Big-4 guidance addresses an
   ECL base that includes GST (Q14).
5. **Payday Super:** QE day and payday definitions in the enacted text (E-003, m6).

## Sources (search extracts, 2026-11-09)

- [ATO — Choosing an accounting method](https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/accounting-for-gst-in-your-business/choosing-an-accounting-method)
- [ATO — When to account for GST (second-hand goods page, accruals rule)](https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/in-detail/rules-for-specific-transactions/gst-and-second-hand-goods/when-to-account-for-gst)
- [ATO — Progressive or periodic sales and purchases](https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/in-detail/rules-for-specific-transactions/agent-consignment-and-progressive-transactions/gst-agent-consignment-and-progressive-transactions/progressive-or-periodic-sales-and-purchases)
- [ATO — Edited private ruling 1011792288728 (Div 99 deposits)](https://www.ato.gov.au/law/view/sgif/ev/1011792288728-2.jpg)
- [NT DTBAR — Receivables note (simplified ECL approach; GST receivable a separate line)](https://dtbar.nt.gov.au/publications/corporate/annual-reports/annual-report-2018-2019/financial-statements/notes-to-the-financial-statements/assets2/11.-receivables)
- [Crowe — Impairment of receivables, AASB 9](https://www.crowe.com/au/insights/impairment-of-receivables---aasb-9) (secondary; not opened)
