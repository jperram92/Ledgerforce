# Recommendation

Status: proposed, awaiting product owner · Date: 2026-10-24 · Task: T-0009

## 1. Scored comparison

### Against the insights

0 = not served, 1 = partly, 2 = well served, judged from the two prototypes per direction.

| Insight | A Turns | B Flows | C Timeline | Note |
|---|---|---|---|---|
| INS-01 Density for professionals | 2 | 0 | 1 | A's compact queue and tables; B is an owner's essay |
| INS-02 Owner and operator first screens | 1 | 2 | 1 | B answers the owner best; A answers the clerk best; C serves owner and accountant |
| INS-03 Number to source in place | 2 | 2 | 2 | All three put the journal on the document |
| INS-04 Plain double entry plus Dr/Cr | 1 | 2 | 1 | B's flow plus table is the clearest teaching device |
| INS-05 Stability | 2 | 1 | 2 | A's fixed panes; C's single axis |
| INS-06 Exceptions, keyboard | 2 | 1 | 1 | Only A has a full keyboard triage model |
| INS-07 Responsibility | 2 | 1 | 1 | A's chain is the strongest SoD evidence on screen |
| INS-08 Sync as a record | 2 | 1 | 2 | A and C show sync state and events per record |
| INS-09 Time and obligations | 1 | 0 | 2 | Only C answers "will I have enough on the 28th?" |
| INS-10 Not generic | 1 | 2 | 2 | From the checklist and the silhouette test |
| INS-11 Accessible money UI | 2 | 2 | 2 | All pass axe WCAG 2.2 AA; C needs no hue pair for direction |
| **Total (of 22)** | **18** | **14** | **17** | |

### Against the genericness checklist (lower is better; from `02-directions.md`)

| | A Turns | B Flows | C Timeline |
|---|---|---|---|
| Checklist score | 3 | 2 | 1 |
| Silhouette (G13) | Reads as an app shell, closest to v0.1 | Distinct (flow band) | Distinct (axis and lanes) |
| Market white space it occupies (report §B4) | Whose turn | Journal in owner's words | Time as the primary axis |

## 2. Recommendation: C, Timeline, with A's queue for list screens

**Recommend direction C (Timeline) as the product's structure and visual identity**, and adopt
**A's turn queue as the pattern for list-heavy screens** inside it (bank reconciliation, batch
billing preview, sync issues, bill approval). B's flow diagram is kept as a *component* for one
job: the "What it did to your books" explanation on documents for owners.

Reasons:

1. **It occupies the clearest white space.** No incumbent or new finance product puts the
   business's obligations and its cash on one time axis (report §B4). The owner's top anxiety is
   time-bound: tax time stresses 71% of AU SMB leaders [S20], and profit is not cash [S22]. C is
   the only direction that answers "will I have enough on Tuesday?" directly (INS-09).
2. **It is the least generic, by our own test.** Checklist score 1, distinct silhouette, and its
   identity comes from the product's own structure (dates, periods, due dates, lock dates), not
   from a borrowed look (INS-10). This is what the product owner has rejected twice.
3. **It is close to A on the insights** (17 vs 18), and the gap is exactly where A's queue pattern
   slots in. A on its own is the strongest operator tool but reads as an app shell (G13), and it
   puts a work queue in front of an owner who first wants to know if things are OK.
4. **It carries the accounting model naturally.** Periods, lock dates, BAS deadlines, ageing,
   reminders, cooling-off periods and credit holds are all *time rules*. The document spine shows
   immutability honestly: corrections add events after today; nothing is removed (P5).
5. **It is stable** (INS-05): one axis, fixed lane order; new modules add lanes, they don't move
   existing ones.

What C must borrow or fix before build:

- From A: the turn token (you / named person / system) on every open item, the decision bar
  position, keyboard triage on list screens, and the Dr/Cr table with plain glosses.
- From B: the flow component on document pages (owner view), and direction words in sentences.
- Fix: lane collision handling and "+n more"; projection labelling rules; aggregation for Quarter
  and Year scales; a non-timeline layout for list screens (from A).

## 3. Proposed changes to `Docs/ui/principles.md` (human gate, not applied)

| Principle | Change | Evidence |
|---|---|---|
| P3 | Keep parentheses in accountant views; in owner sentences, say the direction in words ("out", "you owe"). | INS-04 |
| P11 | Density default by role: compact for clerks and accountants, comfortable for owners. | INS-01 [S3] |
| P12 | Plain words first for owners; on journals, plain gloss and accounting term side by side. | INS-04 |
| New P13 | Whose turn is it? Every open item names who acts next: you, a named person, a customer or the system. | INS-07 |
| New P14 | Stability: positions are a contract; no rearranging between releases without a migration note. | INS-05 [S15] |
| New P15 | Expected is never shown as actual: projections are dashed, labelled, and say what they leave out. | INS-09 |

## 4. What still needs validating with real users

Everything above is desk research plus prototypes. Before porting screens into `apps/web`, run a
lightweight moderated test of **all three directions** (so the recommendation can be overturned
by data), 45 minutes per session, remote, think-aloud, counterbalanced order.

### Participants: 5 per role, 20 in total

| Role | Recruit | Screen out |
|---|---|---|
| Owner (Sam) | AU business owners, 1–50 staff, use Xero/MYOB/QBO, not accountants | Anyone with an accounting qualification |
| Clerk (Jordan/Lena) | AR or AP clerks or bookkeepers doing ≥ 50 documents a week | Under 6 months in the role |
| Accountant (Priya/Mei) | Outside accountants or finance admins who approve and close for SMB clients | |
| Sales rep | Salesforce users at an SMB who chase payment status | Finance staff |

### Tasks and success metrics

| # | Role | Task | Success metric (target) |
|---|---|---|---|
| T1 | Owner | "Will you have enough in the bank to cover everything due next week? What is the tightest day?" | Correct day and amount in ≤ 60 s (≥ 4/5) |
| T2 | Owner | "What needs you today, and what happens if you wait?" | Names all 4 decisions and the Monday deadline (≥ 4/5) |
| T3 | Owner | "On this invoice, how much of the money is actually yours?" | Says 9,170.00 and that 917.00 is GST for the ATO (≥ 4/5) |
| T4 | Clerk | Triage 10 queued items with the keyboard only | ≤ 3 min; no mouse; zero wrong approvals |
| T5 | Clerk | Find why INV-001061's Salesforce status was late on 6 Oct | Finds the failed write and retry in ≤ 45 s |
| T6 | Accountant | Check that the invoice's journal balances and which accounts were hit | Correct in ≤ 30 s; rates confidence ≥ 6/7 |
| T7 | Accountant | Explain who can release PB-0087 and why Lena cannot | Correct rule and people (5/5) |
| T8 | Accountant | Correct a wrong invoice | Chooses credit note or void correctly; never looks for delete for > 20 s |
| T9 | Sales rep | (UC-12 component, separate mock in SLDS 2) "Has Saltbush paid?" | Correct answer in ≤ 15 s without leaving Salesforce |

Also measure, per direction: Single Ease Question after each task; a 5-second test ("what is this
product for?"); a desirability card sort (pick 5 of 30 adjectives); and a direct question to the
product owner's real users, "Does this look like any other software you use? Which?" (the
genericness test, asked of users, not designers).

### Decision rule

Pick the direction with the highest task success for owners **and** accountants, provided no role
falls below 3/5 on any task. If C fails T4 badly but A passes, keep A's queue as the default for
clerk roles (role-shaped home, INS-02). Record the result as an RQ and a decision-log entry.

### Still to research hands-on

- Capture real screenshots of Xero, MYOB, QBO and Business Central from trial accounts (blocked
  in this session) and check the audit against them.
- Read the primary sources that were only available as search summaries (G2/Capterra reviews,
  NN/g, Xero product ideas) and confirm the quotes.
- Prototype the hard screens in C plus A's queue: bank reconciliation, batch billing preview and
  the sync issues inbox, and check that they stay distinct.
