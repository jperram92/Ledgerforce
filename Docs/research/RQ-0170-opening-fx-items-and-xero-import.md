---
id: RQ-0170
title: Opening balances — how foreign-currency open items are carried at conversion, and what a Xero import must read
status: answered        # open | answered | answered-pending-human | superseded
opened: 2026-11-15
resolved: 2026-11-15
opened_by: claude
linked_tasks: [T-0126, T-0201]
linked_adrs: []
superseded_by:
---

# RQ-0170 — Opening balances: foreign-currency open items and Xero import

## Question

T-0080 (GP-037, RQ-0109) posts the old system's trial balance and its **base-currency** open AR/AP
documents as one journal. T-0126 adds:

- **Q1** At conversion, at which base amount and rate is a foreign-currency open invoice or bill
  carried, and must the opening journal recognise any exchange difference (AASB 121)?
- **Q2** What must the open item keep so that realised FX can be measured when it is settled after
  conversion (design §3.7)?
- **Q3** What does the engine's `fx_rate` mean, and how should a given rate be checked against the
  base amount?
- **Q4** Is a Xero reader MVP or Phase 1 (design §9), and which Xero data and export formats does it
  need (trial balance, aged receivables/payables detail, invoices/bills), with which access model,
  scopes and rate limits?

## Why it matters

Design §4.1 step 9 ("CSV or Xero import"), §3.7 (multi-currency, realised FX at allocation,
unrealised revaluation Phase 1), §9 (phase plan). Guessing the carrying rate either posts an exchange
difference the old system never booked (the trial balance would no longer match the old system: there
is no plug, RQ-0109 finding 3) or loses the original-currency amount, so the first receipt after
conversion could not be allocated (allocation needs the same currency, `subledger.ts`).

## Sources consulted

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S1 | AASB 121 *The Effects of Changes in Foreign Exchange Rates*, compiled Oct 2023 (in force 2025), <https://standards.aasb.gov.au/sites/default/files/2025-03/AASB121_08-15_COMPoct23_01-25.pdf> — as summarised in `Docs/research/research_notes/AASB alignment of LedgerForce postings/reporting_framework.md` Q3 and `Docs/research/reports/AASB alignment of LedgerForce postings.md` | 2026-11-15 (repo notes; the AASB host is not reachable from this session's proxy) | primary (via repo notes) | para 21: a foreign-currency transaction is initially recorded at the spot rate at the transaction date; para 23(a): at the end of each **reporting period** foreign-currency monetary items are translated at the closing rate; para 28: exchange differences on **settlement** or on translation at rates different from those at initial recognition **or in previous financial statements** go to profit or loss |
| S2 | Design `Docs/solution-design/solution-design.md` §3.7 and §9 | 2026-11-15 | primary (project) | "documents in any currency with a rate captured at document date. Realised FX gain/loss posts at allocation; unrealised revaluation is a period-end batch job (Phase 1)"; §9 Phase 1 lists "multi-currency with revaluation" and "**Xero/MYOB importer**" |
| S3 | `packages/ledger/src/posting-engine.ts`, `engine.pipeline.db.test.ts` (100.0000 USD × 1.52345678 = debit 152.3457), DL-0130/DL-0147 | 2026-11-15 | source code | the engine stores `txn_currency`, `txn_amount`, `fx_rate` as given; the stored rate is **base units per one transaction-currency unit** (base = txn × rate); it never recomputes base |
| S4 | `packages/ledger/src/subledger.ts` (allocate, `fx_difference`, DL-0187) | 2026-11-15 | source code | open items keep original/open amounts in transaction currency **and** base; allocation pairs items of the same currency and records `fx_difference` = base released from the credit item − base released from the debit item; the realised FX journal itself waits for its golden posting |
| S5 | `packages/modules/ar/src/aged.ts` | 2026-11-15 | source code | aged receivables sum `base_original_amount` less base released by allocations: ageing is in base currency |
| S6 | Xero Accounting API OpenAPI spec v20.1.0, `xero_accounting.yaml`, <https://raw.githubusercontent.com/XeroAPI/Xero-OpenAPI/master/xero_accounting.yaml> (downloaded with curl) | 2026-11-15 | primary (vendor spec) | `GET /Reports/TrialBalance?date=YYYY-MM-DD[&paymentsOnly]` (scope `accounting.reports.read`) returns a `ReportWithRows` with columns Account / Debit / Credit (+ YTD); `GET /Reports/AgedReceivablesByContact` and `AgedPayablesByContact` **require `contactId`** (one contact per call); `GET /Invoices` filters `Statuses`, `ContactIDs`, `where`, 100 per page; Invoice has `Type` (ACCREC/ACCPAY), `DueDate`, `CurrencyCode`, `CurrencyRate` ("The currency rate for a multicurrency invoice. If no rate is specified, the XE.com day rate is used", 18.6), `AmountDue` ("Amount remaining to be paid on invoice"), `AmountPaid`; scopes `accounting.transactions.read`, `accounting.reports.read`, `accounting.contacts.read`, `accounting.settings.read` |
| S7 | `developer.xero.com` documentation (rate limits, OAuth 2.0 granular scopes) | 2026-11-15 | primary — **not reachable** | the agent proxy refused `developer.xero.com` and `central.xero.com` (connect_rejected). Rate limits and scope changes are therefore **not verified** in this record; see Follow-ups |
| S8 | RQ-0109 findings 1–3 (Digit, Fastlane, Intuit, MYOB community) | 2026-11-15 | secondary (repo) | conversion balances are the old system's closing TB for the day before conversion; open items are entered one by one and must total the control balance; Xero/MYOB/QuickBooks plug differences, LedgerForce refuses them |

## Findings

1. **Carrying amount (Q1).** AASB 121 measures a foreign monetary item at the spot rate on initial
   recognition (para 21) and re-translates it at the closing rate only at the end of a *reporting
   period* (para 23). Between reporting dates the books carry it at its recorded base amount. The
   conversion balance date is not necessarily a reporting date. (S1)
2. *Inference from 1 and RQ-0109:* the opening entry must reproduce the old system's trial balance
   exactly (no plug). The old system's AR/AP control balance in base currency already contains each
   foreign item at whatever rate it carries it: the original rate, or the closing rate if it ran a
   revaluation at that date (as AASB 121 requires when the balance date is a reporting date). So
   LedgerForce carries each item at **the old system's base amount** and adds **no exchange-difference
   line** to the opening journal. Recomputing at another rate would create a difference that is not
   in the old trial balance and that the entry could only balance with a plug.
3. **What the item keeps (Q2).** Settlement after conversion measures the realised difference against
   the item's carrying amount ("rates different from those at which they were translated on initial
   recognition during the period or in previous financial statements", para 28, S1). The open item
   therefore needs its **transaction currency, transaction amount and the base amount carried at
   conversion**. The ledger already keeps all three on the control line and the subledger item (S3, S4).
   A same-currency receipt can then be allocated, and its `fx_difference` is the realised FX since
   conversion. Any difference accrued before conversion was either booked in the old system (if it
   revalued) or is still unrecognised, and it is correctly realised now.
4. **Rate convention (Q3).** The engine's rate is base per one foreign unit (S3). A given rate is
   consistent with the base amount when `round_half_up(txnAmount × rate, 2) = base amount`, using
   the same cents rounding as design §3.4. When no rate is given, the rate is implied as
   `base ÷ txn`, rounded half-up to 8 decimals (`NUMERIC(18,8)`). That keeps the stored base exact and
   the rate informational. *Xero's* `CurrencyRate` uses the opposite convention (foreign per one base
   unit, as shown "1 AUD = 0.65 USD" in Xero). This comes from product knowledge and could not be
   checked here (S7). The Xero reader must convert it and verify the convention against a recorded
   fixture.
5. **Ageing (AC-1).** Aged AR/AP is in base currency (S5). An FX opening item therefore ages by due
   date at its carried base amount, and the buckets still sum to the control balance.
6. **Xero phase (Q4).** Design §9 places the "Xero/MYOB importer" in **Phase 1** (S2). An MVP module
   must not depend on a Phase 1 capability (packages/modules/AGENTS.md). The Xero reader is split
   into its own Phase 1 card (T-0201). The MVP path is the CSV import, which any Xero user can feed
   from Xero's own report exports.
7. **What a Xero reader must read (Q4, for T-0201).** Trial balance: `GET /Reports/TrialBalance?date=<balance date>`
   (S6). Open items: the aged-by-contact reports need one call per contact (S6), so the efficient
   source is `GET /Invoices?Statuses=AUTHORISED` (ACCREC and ACCPAY), plus credit notes and
   overpayments/prepayments. `AmountDue` is **today's** amount, not the amount at the balance date
   (S6). The reader must add back payments, credit-note allocations and overpayment allocations dated
   after the balance date, or refuse when it cannot. It must also leave out documents dated after
   the balance date. Each `CurrencyCode` ≠ base becomes a foreign item (finding 4).

## Conclusion / decision

- Add optional `currency`, `currency_amount` and `fx_rate` to an opening item (CSV columns and
  command fields). `amount` remains the **base** amount and is what must sum to the control row.
- A foreign item posts its control line with `txnCurrency`, `txnAmount = |currency_amount|` and the
  rate (given or implied, finding 4). No FX line is posted, and the debits and credits are those of
  GP-037. The new golden **GP-040** records the expectation (variant, not a supersession of GP-037).
- Refuse: an unknown currency code shape, a currency amount of a different sign or zero, a rate with
  more than 8 decimals or ≤ 0, a rate inconsistent with the base amount, and a base-currency item
  whose `currency_amount` differs from `amount` or whose rate is not 1. Nothing is written.
- GST content of a foreign item is recorded in base currency (BAS is reported in AUD).
- Realised FX is not posted here. Allocation records `fx_difference` (DL-0187); the realised-FX
  journal and revaluation are their own goldens and tasks (§3.7, Phase 1).
- Split the Xero reader into **T-0201** (Phase 1, depends on T-0126), with findings 4 and 7 and the
  follow-ups below as its research input.

## Confidence

`high` for Q1–Q3 and ageing: AASB 121 paras 21/23/28 via the repo's AASB notes, plus the engine
and subledger source. `medium` for Q4: the endpoint shapes come from Xero's published OpenAPI spec,
but Xero's rate convention, rate limits and current scope model could not be opened from this
session (S7). T-0201 must verify them before any code.

## Follow-ups

- T-0201: verify on developer.xero.com the rate limits (believed 60 calls/minute and 5,000/day per
  organisation, 5 concurrent) and whether new apps must use granular scopes instead of
  `accounting.transactions.read`. Verify the `CurrencyRate` direction with a recorded multicurrency
  fixture. Decide the OAuth 2.0 connection model (a security ADR, since tokens are stored).
- Design §3.7 realised-FX journal golden (still not written; DL-0187) and the Phase 1 revaluation job.

**Affects:** packages/modules/setup (opening balances), apps/api setup controller, Docs/accounting
GP-040, T-0201.
