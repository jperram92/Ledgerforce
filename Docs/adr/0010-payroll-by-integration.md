---
adr: 0010
title: "Payroll by integration (payroll bridge) until Phase 3; no native payroll calculation or STP lodgement"
status: Proposed
date: 2026-10-24
author: claude
category: accounting
human_gate: yes
supersedes: none
superseded_by: none
---

# ADR-0010: Payroll by integration (payroll bridge) until Phase 3

## Status

Proposed — design-committed (D5, §1 scope boundaries, §9.1, §11.1). It sets product scope and
the accounting treatment of payroll (journals, liabilities), so the `adr:accounting` gate
applies. Awaiting product-owner acceptance. Revisit at Gate 3 (Phase 3).

## Context and problem statement

SMB customers pay staff, so the ledger must reflect wages, PAYG withholding, superannuation and
net pay (§3.8). Calculating Australian payroll natively means award interpretation, leave,
super guarantee and Single Touch Payroll (STP) reporting. The ATO requires payroll software
developers (commercial or in-house) to complete **STP product registration** and meet the
**DSP Operational Security Framework (OSF)**; the OSF applies to software that reads, stores,
modifies or routes payroll or tax data into ATO digital services, with an assessment category
depending on product type, API risk rating and client volume (ATO Software Developers site,
checked 2026-10-24). This is a large compliance and security programme that would delay the
MVP's core goal (§9: invoice, collect, pay suppliers and close a month).

Mature payroll providers (e.g. Employment Hero, §5.7) already calculate pay and lodge STP.

## Decision drivers

- Ship the MVP accounting core without an ATO registration/OSF programme on the critical path.
- Correct accounting of payroll in the GL (liabilities, clearing, net pay batches).
- Segregation of duties for net-pay batches (payment-fraud risk, §6.1, §6.5).
- Avoid scope creep (top-3 risk, §11).

## Considered options

1. **Payroll bridge: import finalised pay-run journals and net-pay amounts from a payroll
   provider; LedgerForce posts journals and creates net-pay ABA batches (Phase 1).**
2. **Native payroll calculation and STP Phase 2 lodgement in LedgerForce.**
3. **Manual journals only** (bookkeeper keys payroll journals; no import, no batches).

### Option 1 — Bridge

- Good, because no ATO product registration/OSF for LedgerForce itself (the provider lodges).
- Good, because payroll is still fully reflected in the GL with control over net-pay release
  (maker-checker, step-up MFA).
- Bad, because customers need a second subscription (payroll provider).
- Bad, because import adapters per provider must be maintained.

### Option 2 — Native payroll

- Good, because one product for everything.
- Bad, because ATO product registration + OSF, award/legislation maintenance, high security
  bar; would dominate the roadmap and delay MVP.

### Option 3 — Manual journals only

- Good, because zero build.
- Bad, because error-prone, no net-pay batch control, PAYROLL_CLEARING would be posted by hand
  (control-account rule §3.2 forbids manual journals to control accounts).

## Decision outcome

Chosen option (design-committed): **Option 1 — payroll by integration until at least Phase 3.**

Rules:

1. Phase 1 Payroll Bridge module: import a finalised pay run (UC-07) → post
   Dr Wages expense, Dr Super expense / Cr PAYG withholding, Cr Super payable, Cr Wages payable
   (§3.8); create a net-pay ABA batch Dr Wages payable / Cr Bank released by a second user.
2. LedgerForce never calculates pay, never lodges STP, never stores TFNs unless a future ADR
   says otherwise (§6.6 envelope encryption if ever stored).
3. Posting amounts come from the provider; the golden postings for payroll are owned by the
   human (`Docs/accounting/postings.md`).
4. Revisit only at Gate 3 with a cost/benefit of ATO registration and OSF (§9.1 Phase 3).

## Consequences

### Good

- MVP and Phase 1 stay focused; payroll accounting is still correct and controlled.

### Bad / accepted trade-offs

- Dependency on third-party payroll providers and their APIs/file formats (an RQ per provider).
- No payroll in MVP (UC-07 is Phase 1).

## Compliance and verification

| Check | Where | Gate |
|---|---|---|
| Golden postings for payroll journal and net-pay batch | `Docs/accounting/postings.md` + golden tests | §10.8 gate 4 |
| Net-pay batch cannot be released by its creator | SoD test (Payroll Officer rule §6.4) | gate 2 |
| PAYROLL_CLEARING / WAGES_PAYABLE reject manual journals (control accounts) | ledger test | gate 2 |
| No backlog task in MVP/Phase 1 implements pay calculation or STP lodgement | backlog review in cross-review checklist | gate 8 |

## Links

- Design: D5, §1 scope boundaries, §3.2, §3.8, §5.7, §6.4–§6.6, §8.2 UC-07, §9.1, §11.1
- External (retrieved 2026-10-24): ATO, Single Touch Payroll product registration —
  https://softwaredevelopers.ato.gov.au/STP_ProductRegistration ; ATO, Scope of the DSP
  Operational Security Framework — https://softwaredevelopers.ato.gov.au/scope-dsp-operational-security-framework
