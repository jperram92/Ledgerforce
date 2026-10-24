# LedgerForce UI research report

Status: research complete, awaiting product-owner review · Date: 2026-10-24 · Task: T-0009 ·
Author: claude (UI/UX research role) · Research records: RQ-0081 to RQ-0089 in `Docs/research/`

This report comes before any design. Every design decision in [`02-directions.md`](02-directions.md)
cites an insight (INS-nn) from section E, and every insight cites sources (S-nn) from section F.

## How the research was done, and its limits

- **Method.** Desk research on 2026-10-24: about 40 web searches, a primary-source read of two
  open-source design-critique catalogues and the Anthropic `frontend-design` skill (fetched from
  GitHub), a Reddit-mined data table (3.2M posts, fetched from GitHub), and one experiment run
  here: a Playwright test of 19 open-licence typefaces for tabular figures and digit
  disambiguation (`tools/fonttest.mjs`, result in RQ-0085 and `evidence/typeface-specimen.png`).
- **What I could not reach.** The session's egress proxy blocks direct page fetches to almost
  every site, including reddit.com, g2.com, capterra.com, productideas.xero.com,
  quickbooks.intuit.com, nngroup.com, w3.org, linear.app, stripe.com, mercury.com, ramp.com,
  digits.com, learn.microsoft.com and web.archive.org (HTTP 403 at CONNECT). For those sources
  I used the search engine's extracted summaries and quotes. They are marked **[summary]** in the
  source table. They are weaker than a full read, so I only use them where several agree.
  GitHub (raw files) and the npm registry were reachable. Those sources are marked **[read]**.
- **No live product screenshots.** I could not log in to Xero, QuickBooks, MYOB, NetSuite,
  Business Central or the newer tools, or reach their marketing sites. The competitive audit
  (section B) describes their patterns from documentation, reviews and my own knowledge of
  those products. That part needs a hands-on pass with trial accounts before build (see the
  test plan in [`03-recommendation.md`](03-recommendation.md)).
- **No user interviews.** Everything here is secondary research. Section 03 lists what has to be
  checked with real users (5 per role).

---

## A. Users and jobs to be done

LedgerForce has four kinds of users (design §1, §6.4). They want different things from the
same data.

| User | Main jobs | What they say about current tools |
|---|---|---|
| **Sam, owner** (non-accountant) | Is cash OK? Who owes me? What must I approve? Will I have enough when the BAS and payroll go out? | Tax time is stressful (71%) or overwhelming (83%) for Australian SMB leaders [S20]. Profit isn't cash: a month can show $20,000 profit with only $8,000 in the bank [S22]. Making mistakes is the biggest fear of people who do their own books [S21]. |
| **Jordan / Lena, AR and AP clerks** (high-volume entry) | Enter, code, match and send dozens to hundreds of documents a day | Redesigns that add whitespace and clicks slow them down. QuickBooks users: "less than 5% of the page" shows the bank transactions they came to review [S3]. Xero's new invoicing: more clicks and steps, slower routine work [S1][S2]. Asking for arrow-key entry and Alt shortcuts [S4]. Per-line "OK" in Xero reconciliation causes repetitive strain [S9]. |
| **Priya, finance admin / Mei, outside accountant** (approve and close) | Check that postings are right, approve, lock periods, find the source of a number | Praise for drill-down to the transaction, and complaints when drill-down lands on a group instead of the original document [S7]. MYOB: wants deeper drill-downs [S6]. NetSuite: "so many menus, sub-tabs and fields crammed onto one page", slow navigation between records [S5]. Business Central built Preview Posting because "accountants want to make sure that the posting will be correct beforehand" [S8]. |
| **Sales reps** (only inside Salesforce) | Know if a customer has paid before they call or sell again | Without write-back, reps "keep asking finance whether invoices are paid" and can close deals on accounts with unpaid invoices [S23]. |

Concrete pain points, grouped:

1. **Density lost in redesigns.** Both market leaders reduced density in their 2024–25 redesigns.
   QuickBooks says the extra whitespace is deliberate and offers only a "Compact" toggle on one
   screen [S3]. Xero's new invoicing was forced on users when classic invoicing retired in 2025,
   and users said routine work got slower [S1][S2][S4]. Professional users read this as the
   product being made for someone else.
2. **Forced change breaks trust.** QuickBooks moved all US users to the new interface by
   September 2025 with no way back [S2]. Bloomberg's terminal team says even "a font change or the
   relocation of a button can be disruptive" and that they "balance innovation with familiarity"
   [S15].
3. **Keyboard entry is a must for clerks.** Users ask for cursor keys rather than mouse or Tab,
   and for shortcuts on Save and Approve [S4].
4. **The "why" behind a number.** Accountants trust a system when they can drill from a report
   figure to the original transaction [S7]. Digits, the most polished newer ledger, is praised for
   speed and polish but hits "the professional's need for trust, transparency and control" [S12].
5. **Reconciliation is exceptions work.** Xero's two-column screen (statement line left,
   suggested match right, OK button) is clear but needs one click per line [S9]. Digits and Puzzle
   frame the job as an inbox of exceptions, not a list of everything [S12][S13].
6. **Approvals turn into rubber stamps.** Under volume, checkers confirm that something was
   entered, not that it is right [S16]. A good approval record shows maker, checker, date and
   evidence [S16]. Before/after comparison is a standard checker-screen element [S16].
7. **Mobile approval works when it is one decision with context.** ApprovalMax (4.8/5 from 603
   Xero users) approves on a phone with one tap, with a comment thread and document attached [S17].
8. **Sync errors disappear.** Integration errors "can be easily dismissed and lost", so users ask
   for a dedicated error page and an event log [S18].
9. **Anxiety about money and tax.** Over half of Australians fear making a mistake on their tax
   return, and pressure is higher for business owners [S20]. The UI has to make the safe action
   obvious and explain irreversible ones before they happen.

## B. Competitive and analogous UI audit

Descriptions come from documentation, reviews and product knowledge (screens could not be
captured, see limits). "Converged" marks patterns that most products now share.

### B1. Established accounting products

| Product | Does well | Does badly | Pattern notes |
|---|---|---|---|
| **Xero** (AU market leader) | Bank reconciliation as a two-column match with a visible statement-vs-Xero balance gap [S9]. Lock dates that SMBs understand (design §2). | New invoicing: more clicks, lost classic features, forced migration [S1][S4]. One click per reconciled line [S9]. | Top bar navigation, white cards on grey, blue accent, KPI "business snapshot" tiles. **Converged.** |
| **QuickBooks Online** | Familiar to US bookkeepers. One-screen invoice form. | 2025 "modern view": more whitespace, hidden "New" menu, no dark mode, report layout against accountant convention, forced rollout [S2][S3]. | Left sidebar, card dashboard, green accent. **Converged.** |
| **MYOB Business** (AU) | 2024 refresh: plainer terminology, shortcuts in Help [S24]. | Reviewers want deeper drill-down and better reporting [S6]. | Sidebar plus cards. **Converged.** |
| **NetSuite** | Staged period close, deep configuration (design §2). | "Super old and cluttered", "so many menus, sub-tabs and fields crammed onto one page"; G2 tags "interface outdated" in 335 reviews [S5]. | Tabs inside tabs, dense forms. Density without hierarchy. |
| **Business Central** | **Preview Posting** on every postable document, with a grouped (hierarchical) view of G/L and VAT entries [S8]. | Configuration burden; posting-group jargon (design §2). | Ribbon and FastTabs. The preview is the pattern worth taking. |
| **Sage Intacct** | Audit trail and drill-down to the transaction praised by auditors [S7]. | Drill-down sometimes lands on a group, not the transaction [S7]. | Dense, report-centric. |
| **FreshBooks** | "Non-accountant friendly" design that people without accounting knowledge can use [S10]. | Accountants find it shallow; older reviews say it hides accounting concepts [S10]. | Proof that plain language wins owners, and that hiding the ledger loses accountants. |

### B2. Newer finance products and analogues

| Product | Does well | Does badly / risk | What to take or avoid |
|---|---|---|---|
| **Digits** | AI ledger; review workflow is an **inbox of exceptions**, not every transaction [S12]. | Polish without transparency: professionals need to see why the machine decided [S12]. | Take the exceptions inbox. Avoid opaque automation. |
| **Puzzle** | Cash and accrual from the same data with one toggle [S13]. | Few independent reviews [S13]. | The cash/accrual question is real for owners (INS-02). |
| **Rillet / Campfire** | Prepare, review, post approval chain; AI assistant (Campfire "Ember") [S14][S25]. | Reviewers ask for cleaner reports [S25]. | Approval chains are now normal in ERPs. Chat assistants are converging too. |
| **Ramp / Brex / Mercury** | Calm, premium banking look. Mercury commissioned its own typeface (Arcadia) and a cinematic dark style [S26]. | A community file of Mercury's UI describes a violet-tinted near-black and an indigo CTA [S26]. Ramp's reverse-engineered kit uses Inter and a yellow accent [S27]. | This is the "premium fintech" look, and it is converging: dark, violet, Inter. Avoid. |
| **Stripe Dashboard** | Payment detail as a **timeline of events** (initiated, succeeded, available in balance); neutral palette with status colour that means something [S28]. | — | The event timeline is a strong pattern for document history (used in direction C). |
| **Linear** (density analogue) | Keyboard-first from the first release; Cmd-K plus mnemonic single-key shortcuts; "more data with less chrome" [S29]. | Its look has been copied so widely that "the Linear glow" is now an AI tell [S31]. | Take the interaction model (keys, speed), not the look. |
| **Bloomberg Terminal** (density analogue) | Extreme density that pros accept because the hierarchy is learned and stable; "conceal complexity" [S15]. | Steep learning curve. | Stability matters more than freshness for daily professional users. |
| **Salesforce Lightning** (neighbour) | SLDS 2 and the Cosmos theme (GA Winter '26 per a third-party source) moved to **global styling hooks**; components should follow the org's theme and branding [S30]. | Component-level hooks are not supported in SLDS 2 [S30]. | The UC-12 component in Salesforce must inherit SLDS 2 hooks and carry no LedgerForce styling. The LedgerForce app must look clearly separate, so users always know which system they are changing. |

### B3. Where the market has converged (the "generic baseline")

Across established tools and new fintech, a finance app in 2026 is, by default:

1. A left icon sidebar plus a top bar with search, bell and avatar.
2. A greeting ("Good morning, Sam") over a row of 3–4 KPI tiles: big number, small label, delta chip.
3. White rounded cards with a 1px grey border or soft shadow on a light grey page.
4. One blue, green, indigo or violet accent; a premium variant on violet-tinted near-black.
5. Inter, Geist or the system font everywhere.
6. Coloured pill chips for status.
7. Ledger detail hidden behind "More" or a report, not on the document.

**Rejected v0.1 was exactly this baseline** (sidebar, greeting, 4 KPI tiles, rounded cards, indigo,
pills). **Rejected v2 "Columnar"** escaped the first-order baseline but landed on the
*second-order* defaults that critique catalogues now name: broadsheet hairlines and zero radius,
tracked all-caps labels, monospace for data labels, middle-dot meta strings, and a nostalgic
costume (red margin line, rubber stamps) [S32][S33]. That explains the product owner's "not any
other generic type" exactly. A third aesthetic picked by taste would very likely fall into another
cluster (cream and terracotta, near-black and acid green).

### B4. White space (what nobody does well)

- **The journal on the document, in words an owner understands.** BC shows G/L entries to
  accountants. FreshBooks hides them from owners. Nobody shows the same posting in both forms.
- **Whose turn it is.** Tools show *status* (Awaiting approval). None make *responsibility*
  (waiting on you, on Mei, on Salesforce) the main organising idea, though SoD makes it central.
- **Time as the primary axis.** Owners plan around dates (BAS 28 Oct, payroll, supplier runs),
  but dashboards show static balances. Cash forecasts are a separate add-on report.
- **Sync honesty.** Integrations hide sync state in logs. Few show per-record sync state on the
  record.
- **Stability as a promise.** Incumbents redesign and force migrations. A stable, learnable layout
  is a differentiator for professional users [S2][S15].

## C. Pattern research for the hard parts

| Topic | Finding | Source |
|---|---|---|
| Data-dense tables | Right-align numbers; tabular figures; same decimals per column. Compact density is the one setting QuickBooks gave users after complaints. | RQ-0080 §2, [S3] |
| Number typography | `font-variant-numeric: tabular-nums` works only if the font has `tnum`; many fonts silently ignore it. Our test: Lexend and Libre Franklin have **no** working tnum; B612 sets parentheses as square brackets, so `(914.50)` reads as `[914.50]`; Atkinson Hyperlegible Next has a slashed zero and distinct I/l/1 **by default** and working tnum. | [S34], experiment E1 (RQ-0085) |
| Double entry for non-accountants | "Single-entry tells you what happened; double-entry tells you where the money went"; drop the word "credit", which scares people off; frame each entry as what the business got and what it gave up; T-accounts help explain impact to non-finance colleagues. | [S35][S36] |
| Preview before posting | BC's Preview Posting shows the entries a posting would create, grouped by account in a hierarchical view, and exists to prevent corrections. | [S8] |
| Approval and SoD | Record maker, checker, date and evidence; one user cannot approve twice; the checker inbox needs view details and before/after compare; too many steps cause bottlenecks; volume causes rubber-stamping. | [S16] |
| Mobile approvals | One decision per screen, one tap, comments and the document; approve/reject targets at least 48px and within thumb reach. | [S17][S27b] |
| Sync and error states | Error messages that can be dismissed get lost; users want a dedicated error page and event log; common causes (locked records, missing mappings) are fixable by a person if named. | [S18] |
| Reconciliation | Statement line and suggested match side by side, with the balance gap shown; bulk-confirm exact matches to avoid per-line clicking. | [S9] |
| Accessibility (WCAG 2.2) | New AA criteria: 2.5.8 targets ≥ 24×24 CSS px; 2.4.11 focus not obscured by sticky headers; 3.3.7 redundant entry (A); 3.3.8 accessible authentication. | [S37] |
| Colour-blind-safe status | Red/green comes from ledger ink and stock tickers. Blue/orange is a safe pair for protanopia and deuteranopia; Okabe-Ito palette; finance apps (ZipBooks, Copilot Money) added blue/orange modes and +/− signs. Always pair colour with words and icons. | [S38] |
| Dark mode | No fatigue difference overall, but light mode gives better proofreading accuracy, and the gap grows as text gets smaller. Dark backgrounds differ: #121212 reduced reading errors in one 2025 study. | [S39] |

## D. What makes a UI read as "AI" or "vibe-coded" in 2025–2026

### D1. Evidence

- **What people actually say.** A Reddit-mined study (3.2M posts across 47 subreddits, 3,033
  comments from 125 canonical threads) ranks the most-named tells by share of comments: "screams
  AI / soulless" 6.4%, "all looks the same / template" 6.1%, shadcn/Tailwind default kit 2.5%,
  AI purple 2.3%, gradients and gradient text 2.0%, too many animations 1.1%, rounded corners and
  pill buttons 0.8%, dark mode plus neon glow 0.7%, emoji 0.5%, Inter/Geist 0.4%, three feature
  cards 0.4%. Bento grids (0.1%) and glassmorphism (0.2%) are over-blamed [S31]. **[read]**
- **Why it happens.** Models and template users return the median. The Tailwind `indigo-500`
  default and shadcn defaults are the median since 2019 [S32][S40].
- **The second wave.** Once people avoid the purple, output converges again on "tasteful"
  defaults: cream ground with terracotta accent; near-black with one acid-green or vermilion
  accent; broadsheet hairlines with zero radius; template chrome (tracked all-caps eyebrows,
  `A · B · C` meta strings, `WORD — fragment` labels, mono for small data labels, `→` on links)
  [S32][S33]. **[read]**
- **Dashboard sameness.** "KPI row at the top, a large chart, secondary widgets" is the standard
  dashboard [S41]; a big number with a small label and a delta is called out as "the default
  treatment" [S33].
- **The tasteful-font cluster.** Space Grotesk, Geist, Syne, Sora, Instrument Serif, Fraunces and
  Cal Sans: about 15.8% of analysed sites [S32].

### D2. The genericness checklist (used to score every direction)

Score each item 0 (absent), 1 (present but justified by a finding), 2 (present as a default).
Lower is better. A direction must score **≤ 4 overall with no item at 2** to pass.

| # | Tell | Test |
|---|---|---|
| G1 | Inter, Roboto, Geist, system stack or the tasteful-font cluster as the main face | Computed `font-family` of body and headings |
| G2 | Purple, indigo or violet accent, or a purple-to-blue gradient | Hue of accent tokens outside 240–300° |
| G3 | Rounded cards with soft shadow; one radius on everything | `box-shadow` used for elevation; radius > 8px on containers |
| G4 | KPI tile row (big number, small label, delta chip) as the home page | Structural review |
| G5 | Left icon sidebar plus top bar with search, bell and avatar | Structural review |
| G6 | Pill-shaped status chips on every row ("chip soup") | Radius ≥ height/2 on status; count per row |
| G7 | Greeting header ("Good morning, Sam") | Copy review |
| G8 | Second-order: cream and terracotta, near-black and acid green | Ground and accent hex |
| G9 | Second-order: broadsheet hairlines, zero radius, newspaper columns | Structural review |
| G10 | Template chrome: tracked all-caps eyebrows, mono data labels, `A · B · C` meta strings, `→` on links | Computed `text-transform`, `letter-spacing`; copy grep |
| G11 | Decoration without meaning: gradients, glow, glass, fade-up motion, icon in tinted square | CSS grep |
| G12 | Costume: borrowing a past medium's look (paper, stamps, terminal green) without its function | Review: does each device do a job? |
| G13 | Silhouette test: shrink to block outline at 200px wide; could it be any SaaS? | Visual review of 390px screenshot |

## E. Synthesis: insights

**INS-01 · Density is a feature that professionals lose in redesigns.**
QuickBooks' and Xero's 2024–25 redesigns cut density and added clicks, and professional users
complained loudly [S1][S2][S3][S4]. NetSuite shows the opposite failure: density without
hierarchy [S5]. *Implication:* the clerk's and accountant's screens must show many rows with a
clear hierarchy. Whitespace is not the same as clarity.

**INS-02 · Owners and operators need different first screens over the same data.**
Owners ask cash, owed, owing, approve, tax [S20][S22]; clerks process queues [S3][S9]. The v0.1
home tried to do both and became a KPI dashboard. *Implication:* the home is role-shaped. The
owner sees questions answered in sentences; the operator sees work.

**INS-03 · Trust comes from following a number to its source in place.**
Drill-down is praised when it reaches the original transaction and criticised when it lands on a
group [S7][S6]; Digits' polish is undercut by lack of transparency [S12]. *Implication:* any amount
can open its provenance (documents, journal lines, people, sync) without leaving the page.

**INS-04 · Owners understand "where the money went", not debits and credits.**
Plain-language double entry is "what did the business get and what did it give up" [S35][S36].
Accountants still need Dr/Cr and account codes, and BC's Preview Posting is the professional
standard [S8]. *Implication:* show the same journal twice: as movement between named places for
owners, and as the Dr/Cr table for accountants, from the same preview data.

**INS-05 · Stability is a trust signal for daily users.**
Forced redesigns triggered churn talk [S1][S2]; Bloomberg treats moving a button as a risk [S15].
*Implication:* a spatially stable layout (things stay where they are, panes don't reflow by role)
and no "refresh" of the look between releases. Pick a structure that can carry all twelve use
cases without rearranging.

**INS-06 · The real work is exceptions, and per-item clicking hurts.**
Xero's per-line OK causes strain [S9]; Digits and Puzzle are built around exception inboxes
[S12][S13]. *Implication:* lists default to "needs a person"; exact matches and routine items
batch-confirm; keyboard first [S4][S29].

**INS-07 · Responsibility, not status, is the missing organising idea.**
Approval records need maker, checker, time and evidence [S16]; checkers rubber-stamp under volume
[S16]; mobile approval works as one contextual decision [S17]. *Implication:* every item says whose
turn it is (you, a named person, the system) and shows what changed and what it will post before
the decision.

**INS-08 · Sync must be a record, not a toast.**
Dismissible integration errors get lost [S18]; reps need paid status inside Salesforce [S23].
*Implication:* sync state lives on each record and in a persistent issues list. Inside Salesforce,
the component inherits SLDS 2 hooks [S30]; the LedgerForce app looks clearly different so users
know which system they are in.

**INS-09 · Time drives owner anxiety: due dates, BAS, payroll.**
Tax time is stressful for 71% of AU SMB leaders [S20]; profit is not cash [S22]. Static balances
don't answer "will I have enough on the 28th?". *Implication:* show obligations and expected money
on a time axis, labelled as projection, next to the actual balance.

**INS-10 · Generic is recognised on sight, and the escape routes are now generic too.**
"All looks the same" is the top complaint [S31]. v2 fell into second-order defaults [S32][S33].
*Implication:* the identity must come from LedgerForce's own structures (responsibility, money
movement, time), not from a borrowed aesthetic. Score every screen against checklist D2.

**INS-11 · Accessible money UI means words first, CVD-safe hues, light default.**
WCAG 1.4.1 and 2.2 AA (24px targets, focus not obscured) [S37]; blue/orange is safe where
red/green fails [S38]; light mode reads small text more accurately [S39]; digit disambiguation
matters in data entry (experiment E1). *Implication:* status = word + shape + colour; colour
carries one meaning per direction; light theme by default, dark designed separately where long
sessions justify it.

## Positioning statement for the UI personality

> For small Australian businesses that sell through Salesforce, LedgerForce's interface is **a
> calm, exact colleague**: it tells the owner in plain sentences what is theirs to decide and what
> the money will do, and gives the bookkeeper and accountant the full ledger, at full density, one
> keystroke away. It looks like what it is (responsibility, movement and time in a set of books),
> not like a template or a costume, and it stays where you left it.

### Where this challenges `Docs/ui/principles.md`

- **P11 (comfortable by default)** is half right. Evidence (INS-01) says clerks and accountants
  should *default* to compact; only owners default to comfortable. Proposed change: density
  default by role, not one default.
- **P12 (plain words first)** holds for owners, but accountants need the accounting term at
  equal weight on the journal (INS-04). Proposed change: "plain words first *for owners*; on the
  journal, both forms side by side."
- **P2 (word + colour)** holds, and evidence adds: avoid red/green as the only pair; use a
  CVD-safe pair (INS-11).
- **P3 (parentheses for negatives)** holds for accountants. For owners, the research suggests
  showing direction in words ("money out", "you owe") rather than signs (INS-04).
- **P9 (sync in the top bar)** is right, and INS-08 extends it: sync state is a record with its
  own history, not only an indicator.
- New principle proposed: **P13 Whose turn is it?** Every open item names who acts next (INS-07).
- New principle proposed: **P14 Stability**. Layout positions are a contract; don't move things
  between releases without a migration note (INS-05).

## F. Sources

All accessed 2026-10-24. **[read]** = full text read; **[summary]** = direct fetch blocked by the
egress proxy, search-engine extract used; **[exp]** = experiment run in this repo.

| # | Source | Kind |
|---|---|---|
| S1 | AccountingWeb, "Xero 'New' Invoicing – fit for purpose?" https://www.accountingweb.co.uk/node/222644 and "The Xero 'End of Classic Invoicing' Saga" https://www.accountingweb.co.uk/node/220264 ; Xero Product Ideas, "New Invoicing – Reduce number of steps and clicks" https://productideas.xero.com/forums/939198-for-small-businesses/suggestions/47714132 | forum [summary] |
| S2 | QuickBooks Community, "new interface is terrible and not an improvement" https://quickbooks.intuit.com/community/account-management-35/new-interface-is-terrible-and-not-an-improvement-stop-messing-with-it-101366 ; "how to go back to old layout" https://quickbooks.intuit.com/community/other-questions-9/how-to-go-back-to-old-layout-91995 | forum [summary] |
| S3 | QuickBooks Community, "Wasted space in the ui" https://quickbooks.intuit.com/learn-support/en-us/other-questions/wasted-space-in-the-ui/00/1359195 ; "How can I reduce white space…" https://quickbooks.intuit.com/community/other-questions-9/how-can-i-reduce-white-space-and-see-more-on-screen-in-quickbooks-online-84053 ; Porte Brown, QBO new interface https://www.portebrown.com/newsblog-archive/quickbooks-onlines-new-look-what-you-need-to-know | forum, secondary [summary] |
| S4 | Xero Blog, "We're retiring the classic version of Xero invoicing" https://blog.xero.com/product-updates/retiring-classic-invoicing/ ; "Answering your questions about new invoicing" https://blog.xero.com/us/product-updates/answering-your-questions-about-new-invoicing/ ; Xero Product Ideas, "Use cursor keys instead of mouse or tab" https://productideas.xero.com/forums/967139-purchase-orders-bills-inventory/suggestions/47184851 ; "Ability to remove tracking using keyboard" https://productideas.xero.com/forums/939198-for-small-businesses/suggestions/49400207 | vendor, forum [summary] |
| S5 | G2, NetSuite reviews https://www.g2.com/products/netsuite/reviews_and_filters | reviews [summary] |
| S6 | TechRadar, MYOB review https://www.techradar.com/reviews/myob-essentials ; GetApp MYOB Business https://www.getapp.com/finance-accounting-software/a/myob-business/ | review [summary] |
| S7 | GetApp, Sage Intacct reviews https://www.getapp.com/finance-accounting-software/a/intacct-accounting-and-financial-management/reviews/ | reviews [summary] |
| S8 | Microsoft Learn, "Preview Posting Results" https://learn.microsoft.com/en-us/dynamics365/business-central/ui-how-preview-post-results ; release plan "Group G/L and VAT entries in posting preview" https://learn.microsoft.com/en-us/dynamics365-release-plan/2021wave2/smb/dynamics365-business-central/group-gl-vat-entries-posting-preview-easily-extend-posting-preview | primary [summary] |
| S9 | Marc Andrews, "Xero Bank Reconciliation 2026: What the Screen Actually Does" https://marcandrews.com/xero-bank-reconciliation-tutorial-uk-step-by-step-guide/ ; Xero Product Ideas, "Bulk 'OK' for reconciling" https://productideas.xero.com/forums/967136-banking-chart-of-accounts/suggestions/44988634 | secondary, forum [summary] |
| S10 | G2 FreshBooks reviews https://g2.com/products/freshbooks/reviews ; AccountingWeb https://www.accountingweb.co.uk/node/120619 | reviews [summary] |
| S12 | Beancount.io, "Digits AI accountant: balancing brilliant dashboards with the need for human trust" https://beancount.io/blog/2025/08/05/digits-ai-accountant-balancing-brilliant-dashboards-with-the-need-for-human-trust ; Digits help https://help.digits.com/firms-agentic-general-ledger/digits-ai | secondary, vendor [summary] |
| S13 | Puzzle, accrual automation https://www.puzzle.io/accrual-automation ; https://puzzle.io/llms.txt | vendor [summary] |
| S14 | Rillet docs, Journal Entries https://docs.rillet.com/EjmEP4KZ9BVp9j2ho4Mh/general-accounting ; Rillet for accountants https://info.rillet.com/rillet-for-accountants | vendor [summary] |
| S15 | Tech at Bloomberg, "How Bloomberg Terminal UX designers conceal complexity" (6 Dec 2022) https://www.bloomberg.com/company/stories/how-bloomberg-terminal-ux-designers-conceal-complexity | primary [summary] |
| S16 | xtrm, "Maker-checker workflows: mistakes" https://blog.xtrm.com/posts/maker-checker-workflows-mistakes ; Mifos maker-checker https://rootstack.com/en/learning/maker-checker-module-approval-system-mifos ; Sumsub 4-eyes review https://docs.sumsub.com/docs/4-eyes-review ; Ripple custody governance https://docs.ripple.com/products/custody/governance/users | vendor docs [summary] |
| S17 | ApprovalMax, mobile approvals https://approvalmax.com/mobile-approvals ; Xero App Store listing https://apps.xero.com/uk/search/app/approvalmax ; support article https://support.approvalmax.com/en/articles/414665-mobile-apps-for-approvers-and-requesters | vendor [summary] |
| S18 | Formitize feature request, "Dedicated page for integration/Xero errors" https://features.formitize.com/p/dedicated-page-for-integrationxero-errors ; Workshop Software, "Why is my invoice not syncing to Xero?" https://workshopsoftware.com/knowledge-base/accounting-integrations/why-is-my-invoice-not-syncing-to-xero/ | forum, vendor [summary] |
| S20 | Xero media release (29 May 2025), "Over half of Australians fear making a mistake on their tax return" https://www.xero.com/au/media-releases/new-xero-research-reveals-over-half-australians-fear-making-mistake-on-tax-return/ ; SmartCompany https://www.smartcompany.com.au/tax/two-thirds-of-australian-small-businesses-find-themselves-stressed-at-tax-time/ | survey [summary] |
| S21 | Hieing, small business accounting software statistics https://www.hieing.com/small-business-accounting-software-statistics/ | secondary compilation, low [summary] |
| S22 | Wave, "Cash flow for small businesses" https://www.waveapps.com/blog/cash-flow-for-small-businesses ; SCORE https://www.score.org/resource/blog-post/how-much-cash-should-a-small-business-keep-reserve | secondary [summary] |
| S23 | Tray.ai, Sage Intacct + Salesforce https://tray.ai/connectors/sage-intacct-salesforce-integrations.md ; ScaleXP https://www.scalexp.com/?p=140843 | vendor [summary] |
| S24 | CFOtech Australia, "MYOB updates platform for easier SMB user experience" https://cfotech.com.au/story/myob-updates-platform-for-easier-smb-user-experience | news [summary] |
| S25 | G2, Campfire reviews https://www.g2.com/products/campfire-2024-01-05/reviews | reviews [summary] |
| S26 | Blake Crosley, Mercury design guide https://blakecrosley.com/guides/design/mercury ; Instrument, Mercury https://www.instrument.com/work/mercury ; shadcn.io Mercury design file https://www.shadcn.io/design/mercury | secondary [summary] |
| S27 | Tessl registry, "ramp-ui-skills" https://tessl.io/registry/skills/github/ihlamury/design-skills/ramp-ui-skills ; S27b ONES, approval UI guidance https://ones.com/blog/?p=1123684 | secondary [summary] |
| S28 | Blake Crosley, Stripe design guide https://blakecrosley.com/zh-Hans/guides/design/stripe ; Stripe blog, Dashboard updates https://stripe.com/th/blog/dashboard-updates-oct-2020 | secondary [summary] |
| S29 | Robin Rendle, "Keyboard first apps" https://robinrendle.com/notes/keyboard-first-apps/ ; 925studios, "Linear design breakdown" https://www.925studios.co/blog/linear-design-breakdown-saas-ui-2026 ; Brainy, "Keyboard first" https://brainy.ink/paper/glossary/keyboard-first | secondary [summary] |
| S30 | Salesforce Developers, "Style Components Using SLDS Styling Hooks" https://developer.salesforce.com/docs/platform/lwc/guide/create-components-css-custom-properties ; "Use SLDS Design Tokens (Deprecated)" https://developer.salesforce.com/docs/platform/lwc/guide/create-components-css-design-tokens ; Salesforce Ben, SLDS 2 beta https://www.salesforceben.com/slds-2-beta-how-you-can-future-proof-your-salesforce-ui/ | primary, secondary [summary] |
| S31 | J. Carter Johnson, "vibecoded-design-tells" (README and `comment_tell_counts.csv`) https://github.com/JCarterJohnson/vibecoded-design-tells | data [read] |
| S32 | funboy322, "avoid-ai-design" (README and `references/ai-tells-catalog.md`, 67 tells, 23 sources) https://github.com/funboy322/avoid-ai-design | catalogue [read] |
| S33 | Anthropic, `frontend-design` skill https://github.com/anthropics/skills/tree/main/skills/frontend-design | primary [read] |
| S34 | MDN, `font-variant-numeric` https://developer.mozilla.org/docs/Web/CSS/font-variant-numeric ; Tailwind docs https://tailwindcss.com/docs/font-variant-numeric ; fontalternatives.com, legible numerals https://fontalternatives.com/blog/best-fonts-legible-numerals-ui/ | primary, secondary [summary] |
| S35 | System Design Sandbox, "Double-entry bookkeeping" https://www.systemdesignsandbox.com/learn/double-entry ; finkpr, "What double-entry actually means" https://finkpr.com/blog/double-entry-in-five-minutes ; nonari https://nonari.io/blog/double-entry-bookkeeping-explained-for-non-accountants | secondary [summary] |
| S36 | Brex, "T-accounts" https://www.brex.com/spend-trends/accounting/t-accounts ; HN, "Double-entry bookkeeping as a directed graph" https://news.ycombinator.com/item?id=39988993 | secondary [summary] |
| S37 | Deque University, WCAG 2.2 updates https://dequeuniversity.com/resources/wcag-2.2 ; PowerMapper, WCAG 2.2 published https://www.powermapper.com/blog/wcag-2.2-released/ | secondary [summary] |
| S38 | ZipBooks, "Color accessibility mode" https://zipbooks.com/blog/color-accessibility-mode/ ; Copilot Money roadmap https://roadmap.copilot.money/feature-requests/p/accessibility-for-color-blind ; AudioEye, colour-blind-friendly palettes https://www.audioeye.com/post/colorblind-friendly-palettes/ | vendor [summary] |
| S39 | Nielsen Norman Group, "Dark mode vs. light mode" https://www.nngroup.com/articles/dark-mode/ ; Hrčak 2025 study https://hrcak.srce.hr/en/341630 | research [summary] |
| S40 | Adrian Krebs, "Scoring Show HN pages for AI design patterns" https://adriankrebs.ch/blog/design-slop/ ; DEV, "The purple gradient problem" https://dev.to/james_anderson_h/the-purple-gradient-problem-why-ai-ui-all-looks-alike-and-how-to-fix-it-3j65 | secondary [summary] |
| S41 | SaaSFrame, "Designing bento grids that actually work" https://www.saasframe.io/blog/designing-bento-grids-that-actually-work-a-2026-practical-guide | secondary [summary] |
| S42 | Braille Institute / Adobe Fonts, Atkinson Hyperlegible Next https://fonts.adobe.com/fonts/atkinson-hyperlegible-next ; Ophthalmology Management (2025) https://ophthalmologymanagement.com/news/2025/applied-design-and-braille-institute-partner-to-launch-typeface-for-making-reading-easier/ | primary [summary] |
| S43 | Fontsource, B612 https://fontsource.org/fonts/b612/about ; FlightGear mirror of B612 description https://de3mirror.flightgear.org/fgdata/fgdata_2020_3/Fonts/B612/docs/DESCRIPTION.en_us.html | primary [summary] |
| E1 | Experiment: `node Docs/ui/research/tools/fonttest.mjs <fontsource dir> <out>` over 19 fontsource packages, 2026-10-24 | [exp] |
