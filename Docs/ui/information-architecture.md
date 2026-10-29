# LedgerForce information architecture

Status: v0.1 (Sprint 0) · Basis: design §1, §4.1, §5.6, §6.4–6.5, §8 · Mockups: [`mockups/`](mockups/index.html)

## 1. App shell

Every authenticated screen uses one shell (see any mockup):

- **Left navigation** (232px; hidden below 900px, replaced by a back/title bar) — the nine areas
  below, with counts for things waiting on *you*.
- **Top bar**, left to right: company switcher (tenant → company; one company until Phase 2
  multi-entity) · global search `⌘K` · **period indicator** (current posting period and its state:
  Open / AR locked / Soft closed / Locked) · **Salesforce sync indicator** (word + dot, links to the
  Sync issues inbox) · notifications · theme toggle · user with **role** shown under the name.
- **Content**: breadcrumb, one `<h1>`, page actions on the right (one primary), then cards.

## 2. Navigation map

```
Home                         dashboard: cash, AR/AP due, overdue, GST/BAS, approvals, close, sync, controls
Sales (AR)
  ├─ Invoices                list → invoice detail (lines, journal, sync, audit, correct)
  ├─ Batch billing           runs → preview → approve & post → email
  ├─ Credit notes            (from invoice "Issue credit note")
  ├─ Receipts                record / allocate / refunds
  ├─ Customers               party (customer role), statements, credit hold, reminders
  └─ Reminders               schedules, dunning log (Phase 1 full)
Purchases (AP)
  ├─ Bills                   inbox (emailed PDFs) → code → approve
  ├─ Payment batches         create → release (2 people, step-up MFA) → ABA → confirm
  ├─ Suppliers               party (supplier role), bank-detail verification workflow
  └─ Pay runs                payroll journal import + net-pay batches (Phase 1)
Bank
  ├─ Reconcile               per account: statement vs book, matches, rules
  ├─ Statements              imports (CSV/OFX/CAMT.053), bank feeds (Phase 1)
  └─ Transfers
Accounting (GL)
  ├─ Journals                manual / recurring, approvals
  ├─ Chart of accounts       with system roles, dimensions
  ├─ Posting profiles        party × product matrix (also wizard step 7)
  ├─ Rule studio             custom journal rules, tests, activation (Phase 1)
  └─ Tax codes               GST codes, BAS mapping
Reports                      TB, P&L, balance sheet, GL detail, aged AR/AP, BAS (Phase 1), control exceptions, audit log
Close                        period list → staged close checklist → lock / reopen (2 approvers)
Salesforce sync              issues inbox, connection, object mapping, field ownership, reconciliation runs, API usage
Settings                     setup wizard (10 steps), company, users & roles, approval thresholds, SoD & small-team mode,
                             numbering & branding, billing formats/templates, payment methods (Stripe), integrations, API tokens
```

## 3. Role-based visibility (design §6.4)

`●` full · `◐` read-only or limited · `—` hidden. Hidden areas are removed from the nav, not shown
disabled; blocked *actions* inside a visible area are shown disabled with an explanation (P6).

| Area | Owner | Finance Admin | Accountant | AR Clerk | AP Clerk | Approver | Payroll Officer | Auditor |
|---|---|---|---|---|---|---|---|---|
| Home | ● | ● | ● | ● (AR cards) | ● (AP cards) | ● (approvals) | ● (payroll cards) | ◐ |
| Sales / AR | ● | ● | ● | ● | — | ◐ approve credit notes | — | ◐ |
| Purchases / AP | ● | ● | ● | — | ● create, no release | ◐ approve bills, release batches | ◐ net-pay batches | ◐ |
| Bank | ● | ● | ● | ◐ receipts only | ◐ payments only | — | — | ◐ |
| Accounting / GL | ● | ● | ● journals; ◐ chart | — | — | ◐ approve journals | ◐ payroll journals | ◐ |
| Rule studio | ◐ activate only | ● author, not activate own | ◐ | — | — | ◐ activate | — | ◐ |
| Reports | ● | ● | ● | ◐ AR reports | ◐ AP reports | ◐ | ◐ payroll | ● |
| Close | ● | ● lock, override soft lock | ◐ view checklist, tick prep steps | — | — | ◐ second approver for reopen | — | ◐ |
| Salesforce sync | ● | ● | ◐ view + retry | ◐ own records | ◐ own records | — | — | ◐ |
| Settings → users & roles | ● | ◐ (no Owner changes) | — | — | — | — | — | ◐ |
| Settings → company, tax, numbering | ● | ● | ◐ | — | — | — | — | ◐ |
| Supplier bank details | ● verify (not own request) | ● verify | ◐ masked | — | ◐ request change, masked | — | ◐ employees | ◐ masked |
| Audit log | ● | ● | ◐ | — | — | — | — | ● |

Sales users (Salesforce) have **no LedgerForce UI**; they see the UC-12 Lightning component and
the read-only mirror objects. The integration user has no interactive login.

**Always visible to every role:** period indicator, sync indicator, the "Needs your approval" list
filtered to items they may act on, and the explanation of any control that blocks them.

**Small-team mode** (fewer than 3 users): SoD conflicts do not hide anything; the action becomes
available with a visible "exception" label and goes to the weekly control-exceptions report (P8).

**Step-up MFA** is required at the moment of: releasing a payment batch, verifying/changing bank
details, reopening a locked period, activating a posting rule or tax code (design §6.2).

## 4. Key screen inventory

| # | Screen | Route (proposed) | Use cases / design | Primary roles | Mockup |
|---|---|---|---|---|---|
| S01 | Home dashboard | `/` | all; §6.5 exceptions | Owner, all | [01](mockups/01-home-dashboard.html) |
| S02 | Invoice list | `/sales/invoices` | UC-01, UC-03, UC-04, UC-11 | AR Clerk, Accountant | [02](mockups/02-invoice-list.html) |
| S03 | Invoice detail (journal panel, sync, audit, void/credit) | `/sales/invoices/:id` | UC-01, UC-03, UC-11; §3.9 | AR Clerk, Accountant | [03](mockups/03-invoice-detail.html) |
| S04 | Batch billing run (preview → approve & post) | `/sales/batches/:id` | UC-02 | AR Clerk, Approver | [04](mockups/04-batch-billing-run.html) |
| S05 | Credit note + refund | `/sales/credit-notes/new?invoice=` | UC-11 | AR Clerk, Approver | — (from S03) |
| S06 | Customer (party) with statement, credit hold | `/sales/customers/:id` | UC-04, §4.2 | AR Clerk | — |
| S07 | Bills inbox + bill coding | `/purchases/bills` | UC-05 | AP Clerk | — |
| S08 | Bill approval (mobile-first) | `/approvals/:id` | UC-05 | Approver, Owner | [12](mockups/12-mobile-approvals.html) |
| S09 | Payment batch release | `/purchases/payment-batches/:id` | UC-06; §6.5 rules 1–2 | AP Clerk, Approver, Owner | [05](mockups/05-payment-batch-release.html) |
| S10 | Supplier bank-detail verification | `/purchases/suppliers/:id/bank` | §6.1, §6.5 rule 2 | AP Clerk (request), Finance Admin (verify) | — |
| S11 | Bank reconciliation | `/bank/:account/reconcile` | UC-08 | Accountant | [06](mockups/06-bank-reconciliation.html) |
| S12 | Manual journal (with preview) | `/accounting/journals/new` | §3.9, §6.5 rule 4 | Accountant | — |
| S13 | Posting profile matrix | `/accounting/posting-profiles` (and wizard step 7) | §4.4 | Finance Admin | [08](mockups/08-setup-wizard.html) |
| S14 | Rule studio | `/accounting/rules/:id` | UC-09; §4.5 | Finance Admin, Approver | [11](mockups/11-journal-rule-studio.html) |
| S15 | Period close checklist | `/close/:period` | UC-10; §3.5 | Finance Admin, Accountant | [07](mockups/07-period-close-checklist.html) |
| S16 | Reports (TB, P&L, BS, GL detail, aged AR/AP) | `/reports/:report` | MVP reporting; P1 drill-down | Accountant, Owner, Auditor | — |
| S17 | Sync issues inbox | `/salesforce/issues` | §5.6; UC-01, UC-03 | Accountant, Finance Admin | [09](mockups/09-sync-issues-inbox.html) |
| S18 | Setup wizard (10 steps) | `/setup/:step` | §4.1 | Owner, Finance Admin | [08](mockups/08-setup-wizard.html) |
| S19 | Users, roles, approval thresholds, small-team mode | `/settings/users` | §6.3–6.5 | Owner | — |
| S20 | Pay run import + net-pay batch | `/purchases/pay-runs/:id` | UC-07 (Phase 1) | Payroll Officer | — (reuses S09 pattern) |
| S21 | Salesforce Account component (LWC) | Lightning record page | UC-12 | Sales user | [10](mockups/10-salesforce-account-lwc.html) |

## 5. Cross-cutting patterns (where each principle lives)

| Pattern | Component (apps/web) | Principle |
|---|---|---|
| Status chip | `StatusChip` | P2 |
| Money cell / input | `Money`, `MoneyInput` | P3 |
| Journal preview panel | `JournalPreview` (calls posting-engine preview API) | P1, P4 |
| Correction card (credit note / void / no delete) | `CorrectDocument` | P5 |
| Control explanation | `ControlNote` (maps API `reason_code`) | P6 |
| People chain | `ApprovalChain` | P7 |
| Exception label | `ExceptionBadge` + weekly report | P8 |
| Sync marker / inbox | `SyncBadge`, `SyncIssueList` | P9 |
| Shortcut hints | `KeyHints`, `useHotkeys` | P10 |
| Density | user setting → `data-density` | P11 |
