# Three directions for the LedgerForce UI

Status: proposal for product-owner review · Date: 2026-10-24 · Task: T-0009 · Builds on
[`01-research-report.md`](01-research-report.md) (insights INS-01 to INS-11, checklist G1 to G13).

The research found three things missing from the market's generic baseline (report §B4):
**whose turn it is**, **where the money went**, and **time**. Each direction takes one of them as
its organising idea. They differ in structure and interaction model, not only in colour:

| | A. Turns | B. Flows | C. Timeline |
|---|---|---|---|
| Organising idea | Responsibility: who acts next | Movement: where money came from and went | Time: what happened, what is due |
| Home answers | "What needs me, and who is everyone else waiting on?" | "Where did the money go, and what is still to move?" | "Will I have enough on the 28th, and what must I decide by when?" |
| Primary user | Clerks and accountants (operator) | Owner (reader) | Owner and accountant (planner) |
| Structure | Three fixed panes: rail of turns, queue, item | No sidebar; places across the top; essay plus diagram | One date axis shared by stacked lanes; documents as a vertical life story |
| Interaction | Keyboard triage: J/K, Enter, one decision bar | Reading, then selecting a band or a sentence | Scrubbing time; each item sits on the date it matters |
| Colour means | Whose turn (orange = you, blue = others) | Direction (blue = in, orange-brown = out) | Time state (solid = happened, dashed = expected, teal = today) |
| Type | Atkinson Hyperlegible Next | Source Serif 4 + Source Sans 3 | Overpass |
| Dark mode | Designed (#121212 ground) | None, by decision | Designed |

All six prototypes use the same realistic data (Harbour & Co Pty Ltd, Australian GST at 10%, every
journal balances) and pass the same automated checks: one `h1`, a `title`, a `main`, `lang="en-AU"`,
no console errors, no external requests, no horizontal scroll at 390px, text contrast at least
4.5:1, and axe-core 4.14 WCAG 2.2 A/AA with zero violations (`tools/shot.mjs`,
`evidence/check-report.json`).

Side by side with the rejected versions: `evidence/side-by-side.png`; blurred outline test (G13):
`evidence/silhouette.png`.

---

## A. Turns

**Core idea.** The books are a set of hand-offs. Every open item belongs to someone: you, a named
colleague, the customer, or the system. The interface is organised by *whose turn it is*, which is
the one thing segregation of duties makes central and no competitor makes primary (report §B4).

**Insights served.** INS-01 (density), INS-05 (stable panes), INS-06 (exceptions queue, keyboard),
INS-07 (responsibility chain), INS-08 (sync as a turn), INS-11.

**Layout and navigation.** An identity bar (organisation, open period, Find with `/`, Salesforce
state in words, signed-in person). Below it, three panes that never move (INS-05):

1. **Rail of turns**: "Your turn 4", then each colleague with a count and a one-line reason
   ("Priya Shah 5: September hard lock, 3 sync issues, 1 bank rec"), then *Position at 23 Oct*
   (cash, owed to you, you owe, GST due) and the books as plain words.
2. **Queue**: the selected turn's items, ordered by who is blocked and when. Each row: what, amount,
   why it is here, and a mini chain (`Lena made it / Mei released / You release`).
3. **Item**: a sentence title ("Pay 11 suppliers $22,415.00 on Tue 28 Oct"), the decision bar
   directly under it (primary action, send back, a line on what the action does and does not do),
   then who has done what, what it will post, and the detail.

On a phone the rail becomes a strip of turns and a two-by-two position block; queue and item stack.

**Type.** Atkinson Hyperlegible Next (Braille Institute, 2025), for every word and figure. Why:
clerks key and check thousands of figures, and this face disambiguates 0/O and 1/l/I by design;
our test (E1) confirmed a slashed zero by default and working tabular figures [S42]. It is not in
any "AI default" or "tasteful free font" cluster [S32]. Weights 400/600/700.

**Colour and tokens** (`a-turns/tokens.css`). Neutral grey-green ground `#e6eae8`, white panes,
ink `#1a2320`. Colour carries one meaning, *whose turn*: **orange** (`#9c4a00` text, `#e07800`
mark, `#ffe8d1` fill) = you must act; **blue** (`#0c5391`, dashed outline) = someone else or the
system has it; plain ink with a tick = done. Blue and orange are the colour-vision-safe pair
(INS-11). The turn token also differs in **shape** (solid outline for you, dashed for others, bare
tick for done) and always carries a word. Dark mode is designed: ground `#121212` (fewest reading
errors in the 2025 Hrčak study [S39]), lifted orange `#ffb46b` and blue `#94c6f5`.

**Numbers and tables.** Tabular figures everywhere; compact 32px table rows (operators default to
compact, which challenges P11); owner queue rows at 40px. Account codes in muted ink before names;
a muted plain-language gloss after each account ("Trade creditors *what you owe suppliers*").

**Journal / double entry.** Every postable item shows *What it will post* (posting-engine preview)
as a Dr/Cr table, preceded by one plain sentence ("What you owe suppliers goes down by $22,415.00,
and so does the Operating account") and followed by **Balanced** with the resulting bank balance.

**Controls and SoD.** The chain *is* the control: three cells (Lena, AP Clerk, made the run, Thu
4:12 pm, done / Mei, Approver, first release, done / You, Owner, second release, **Your turn**) plus
the rule in a sentence ("Runs over $10,000 need two people… Lena can't release a run she made").
The held-back bill (24-hour bank-detail cooling-off) is stated with the exact time it clears.

**Sync.** Salesforce is a turn holder like anyone else: "Salesforce: 3 need a person" in the
identity bar; "Salesforce retrying" as a blue token; on the invoice, the fields written with
times, and the failure and retry in the history.

**Risks.** (1) The three-pane outline is a familiar app shell; the silhouette test shows it is
closest of the three to the rejected v0.1 shell (sidebar plus content). (2) Owners who just want
"am I OK?" get a work queue first. (3) Turn tokens on every row risk chip soup (G6) if they are
used for anything other than real responsibility.

**Prototypes.** `directions/a-turns/home.html` (owner's turn, payment run PB-0087 open) and
`invoice.html` (AR clerk's view of INV-001061). Screenshots: `home-1440.png`, `home-390.png`,
`home-1440-dark.png`, `invoice-1440.png`, `invoice-390.png`, `invoice-1440-dark.png`.

---

## B. Flows

**Core idea.** Double entry is "where the money came from and where it went" [S35]. Show that
literally. Every page reads like a short explanation, with a diagram of money moving between named
places (customers, your bank, suppliers, staff, the ATO) at its centre, then the accountant's
table underneath, drawn from the same journal data.

**Insights served.** INS-02 (owner first), INS-03 (the "why" behind a number), INS-04 (plain
double entry), INS-10 (an identity that comes from the domain's own mechanism), INS-11.

**Layout and navigation.** No sidebar. A places bar across the top (Overview, Customers, Suppliers,
Bank, Tax, Staff, The books): navigation by *where money sits*. The home is an essay headline ("
$112,640.35 came in this month and $87,224.00 went out"), a one-sentence answer, a full-width flow
diagram (band thickness = amount), then *Still to move* (bank plus owed-in, minus owed-out, as two
hatched bars and four figures), *Waiting for you* (each decision as a sentence with a direction
glyph), and *Are the books in order?* (close, sync and small-team exceptions as plain sentences).
On a phone the diagram becomes ranked rows with proportional bars (`flow.js`), because a diagram
with five labelled destinations can't be read at 358px.

**Type.** Source Serif 4 for sentences, headings and the plain-language glosses (a text serif
with optical sizes, made for reading, which is what an owner does here); Source Sans 3 for controls
and **every number** (full `tnum`/lining support, confirmed by E1). One superfamily, two clearly
distinct roles. Neither face is on the AI-default or tasteful-font lists [S32].

**Colour and tokens** (`b-flows/tokens.css`). White paper, ink `#17202a`, section shade `#f2f4f6`.
Colour means **direction**: blue `#11589a` (bands `#7fb0dc`) = into the business; orange-brown
`#9a4700` (bands `#e9a560`) = out. Money that hasn't moved yet is the same hue, hatched or dashed.
The primary button is the same blue as money in: no separate brand hue. **Light only**, by
decision: owners read this at reading sizes in daylight, and light mode proofreads more accurately
[S39].

**Numbers and tables.** Money is set in Source Sans 3 with tabular figures, right-aligned in
tables. In sentences, the direction is said in words ("Pay $22,415.00 *out*", "Give $660.00
*back*") instead of signs or parentheses (challenges P3 for owners).

**Journal / double entry.** The invoice page shows *What it did to your books*: four sources
("Earned: Health Cloud work 6,840.00" … "GST, held for the ATO 917.00") flowing into "Saltbush owes
you 10,087.00", with the GST band in the *out* colour because it isn't yours. Directly below:
*For your accountant: journal JNL-004231* as a Dr/Cr table with codes and italic glosses, and a
note that diagram and table come from the same posted journal (INS-04).

**Controls and SoD.** Sentences that name the people and the rule ("Lena made the run and Mei
released it first. Runs over $10,000 need a second person: you."). Weaker than A's chain for an
auditor, stronger for an owner.

**Sync.** A sentence on the home ("Salesforce has the latest status for 1,284 records today. Three
updates failed and wait for Priya"), a LedgerForce-to-Opportunity mini flow on the invoice with the
fields written, and the failure in the history.

**Risks.** (1) Weak for high-volume operators: no queue, no keyboard model; list screens (bank
rec, batch billing) would need a second pattern (INS-01, INS-06). (2) Diagrams cost effort for
every new document type, and very small flows (fees) become hairlines. (3) An essay layout can
drift towards "editorial" (G9) if overused. (4) No dark mode.

**Prototypes.** `directions/b-flows/home.html`, `invoice.html`; screenshots `home-1440.png`,
`home-390.png`, `invoice-1440.png`, `invoice-390.png`.

---

## C. Timeline

**Core idea.** Owners plan around dates (BAS on the 28th, payroll on the 30th, the supplier run on
Tuesday), and accountants close by period. Put **time** on the main axis: one horizontal date axis
shared by every lane of the business, so cash, receivables, payables, tax, decisions, the close
and Salesforce can be read against the same day. Documents are read as their own life story on a
vertical spine: what happened, today, and what will happen if nothing changes.

**Insights served.** INS-09 (time and tax anxiety), INS-02 (owner and accountant both plan in
time), INS-03 (history as provenance), INS-05 (one stable axis), INS-07 (decisions placed on the
day they block), INS-08 (sync as a lane and as events), INS-10, INS-11.

**Layout and navigation.** A top bar with four views (Timeline, Documents, Ledger, Settings) and a
time-span switch (Week, 5 weeks, Quarter, Year). The home: headline with the period, a sentence on
how to read solid vs dashed, and the **lowest point ahead** (123,266.85 on Thu 30 Oct, after the pay
run), then the timeline: a step line of cash in bank (actual to the last statement, expected after
today) and six lanes (Customers pay you, You pay, Tax, Decisions, Books, Salesforce). Overdue
receivables sit as a hatched span over the past ("Overdue 33,482.50, not counted in the expected
balance"). Below: *Decisions, by the day they block something* and *Day by day*, the same timeline
read downwards. On a phone, the chart shows cash only (last week to next fortnight) and the agenda
carries the lanes: time runs down the screen.

**Type.** Overpass, the libre face derived from Highway Gothic, the US road-sign letters drawn to
be read at a glance and at speed. A timeline is wayfinding through time; labels in lanes must be
read at a glance at 13px. Tabular figures confirmed by E1. Weight 800 for headings gives the
signage voice without all-caps (G10).

**Colour and tokens** (`c-timeline/tokens.css`). White paper, lane shade `#f3f5f6`, ink
`#1b272d`. Colour means **time state**: solid ink = happened, dashed or hollow ink = expected, one
teal `#006d77` = today and the decisions due now. Direction of money is shown by *which lane* it is
in, not by hue, so the palette needs no red/green or blue/orange pair. Overdue is ink plus hatching
plus the word. Dark mode is designed (`#121619` ground, teal lifted to `#5cc8d1`).

**Numbers and tables.** Tabular figures; amounts in lanes are labels on markers; tables (lines,
journal, Salesforce fields) are standard right-aligned, ruled under the header and above totals.
Balance is a **step line**, because a bank balance changes on a date and does not glide.

**Journal / double entry.** On the invoice, the journal sits *inside the event that created it*
("6 Oct 10:14 am, Approved and posted by Jordan Lee", Dr/Cr table, Balanced). Owners see the
plain gloss under each account; accountants see codes. A term bar across the top shows day 18 of
30, the due date, reminder 1 and the credit-hold date.

**Controls and SoD.** Decisions sit on the date they block ("Mon 27, by 5 pm: Release supplier run
PB-0087, second of two. Lena made it, Mei released it first. If it waits past Monday, 11 suppliers
are paid a day late."). The cost of waiting is the control's explanation (P6). Corrections appear
as **forks from today** on the document spine: *They pay* (likely, solid teal outline), *Part was
wrong* (credit note), *Shouldn't exist* (void with reversal), and "There is no delete".

**Sync.** A Salesforce lane with daily volume ticks and today's "3 need a person"; on the
document, the failed write and the automatic retry are events on the spine.

**Risks.** (1) Busy days crowd a lane (we already needed a second label row); the real build needs
collision handling and a "+3 more" pattern. (2) The expected balance is a projection; it must
always be labelled as one and say what it leaves out, or owners will over-trust it. (3) List-heavy
screens (bank reconciliation, batch billing preview, sync inbox) are not naturally timelines.
(4) Time-scale switching (Week to Year) needs aggregation rules.

**Prototypes.** `directions/c-timeline/home.html`, `invoice.html`; screenshots `home-1440.png`,
`home-390.png`, `home-1440-dark.png`, `invoice-1440.png`, `invoice-390.png`, `invoice-1440-dark.png`.

---

## Genericness self-check (checklist G1–G13 from the report)

Scored 0 = absent, 1 = present but justified by a finding, 2 = present as a default. Automated
probes from `tools/shot.mjs` on all 16 captures: 0 elevation shadows, 0 containers with radius >
8px, 0 tracked all-caps labels, 0 middle-dot meta strings in visible text, 0 arrow glyphs, 0
purple/indigo colours.

| # | Tell | A Turns | B Flows | C Timeline |
|---|---|---|---|---|
| G1 | Default fonts | 0 | 0 | 0 |
| G2 | Purple/indigo | 0 | 0 | 0 |
| G3 | Rounded card + shadow | 0 | 0 | 0 |
| G4 | KPI tile row as home | 0 | 1 (four figures under *Still to move*, tied to the bar above) | 1 (one "lowest point ahead" figure) |
| G5 | Sidebar + search/bell/avatar top bar | 1 (text rail of turns + Find; no icons, bell or avatar) | 0 | 0 |
| G6 | Chip soup | 1 (turn tokens on rows, all real state) | 0 | 0 |
| G7 | Greeting header | 0 | 0 | 0 |
| G8 | Cream/terracotta, black/acid green | 0 | 0 | 0 |
| G9 | Broadsheet cosplay | 0 | 1 (serif essay headings; kept to sentences) | 0 |
| G10 | Template chrome | 0 | 0 | 0 |
| G11 | Decoration without meaning | 0 | 0 | 0 |
| G12 | Costume | 0 | 0 | 0 |
| G13 | Silhouette could be any SaaS | 1 (three-pane app shell) | 0 | 0 |
| | **Total (pass ≤ 4, no 2s)** | **3, pass** | **2, pass** | **1, pass** |

Distinct from the rejected versions: none of the three uses v0.1's sidebar-plus-KPI-cards shell,
indigo, pills or shadows; none uses v2's paper, margin line, stamps, binder tabs, Plex, all-caps
condensed labels or mono figures.
