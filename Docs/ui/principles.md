# LedgerForce UI principles

Status: v0.1 (Sprint 0) · Owner: agents + human · Mockups: [`mockups/`](mockups/index.html) ·
Tokens: [`tokens.css`](tokens.css) · Research: [RQ-0080](../research/RQ-0080-ui-patterns-accessibility.md)

LedgerForce has two audiences on the same screens:

- **Owners** of 1–50 person businesses who are not accountants. They need to know *is cash OK,
  who owes me, what must I approve* — in plain words, without fear of breaking the books.
- **Bookkeepers and outside accountants** who live in the product. They need density,
  keyboard speed, and the journal behind every number.

The twelve principles below serve both. Each has a statement, why, do/don't, and **how it is
tested** — every principle maps to an automated check in the Playwright suite for `apps/web`
(skill `ui-screen`), plus axe-core (`@axe-core/playwright`, WCAG 2.2 A/AA tags) on every screen.
Where a check exists already in the mockup harness (`tools/screenshot-mockups.mjs`) it is noted.

| # | Principle | Seen in |
|---|---|---|
| P1 | Every number is traceable to its journal in one click | 01, 03, 04 |
| P2 | Status is a word plus a colour, never colour alone | all |
| P3 | Money is set for reading | all tables |
| P4 | Show the journal before you post | 03, 04, 06, 08, 11, 12 |
| P5 | Nothing posted is deleted — Void creates a reversal and says so | 02, 03 |
| P6 | Controls explain themselves | 04, 05, 07, 11, 12 |
| P7 | Two-person actions show both people | 04, 05, 11, 12 |
| P8 | Weakened controls are visible, never silent | 01, 07 |
| P9 | Sync is never hidden | shell, 02, 03, 09, 10 |
| P10 | Keyboard-first data entry | 02, 06 |
| P11 | Calm density: comfortable by default, compact on demand | 02 |
| P12 | Plain words first, accounting words second; one primary action per view | 01, 08, 12 |

---

## P1 — Every number is traceable to its journal in one click

**Statement.** Any monetary figure the UI shows (a KPI, a report cell, an invoice total, a balance)
is a link or has a "Show journal" affordance that reaches the source documents and the journal
lines that produced it, in one click.

**Why.** Trust. The owner asks "where does $96,412.80 come from?"; the accountant asks "which
journal hit 4110?". The ledger is the source of truth (design D2), so the UI must expose it.

- **Do:** KPI cards on Home link to the filtered list; invoice detail shows the posted journal
  (JNL-004188) with account codes; batch preview shows the summed batch journal and "See all 38".
- **Don't:** show a total with no drill-down; show a report figure computed in the browser that
  cannot be tied to `journal_line` rows.

**Tested by.** Playwright: for every element with `data-amount`, assert it is inside an `<a>` or has
an adjacent control with accessible name matching `/journal|details|view/i`; clicking it lands on a
page whose journal table's totals equal the figure (decimal compare, never float).

## P2 — Status is a word plus a colour, never colour alone

**Statement.** Document state (Draft, Awaiting approval, Approved, Posted, Part paid, Paid, Overdue,
Void, Reversed, Locked) is always a chip with **text + icon + colour** from the status palette.
Sync state and match state follow the same rule.

**Why.** WCAG 1.4.1 Use of Color (Level A); ~1 in 12 men have a colour-vision deficiency; printed
and greyscale exports must still be readable.

- **Do:** `<Chip status="overdue">Overdue · 12 days</Chip>` — red tint, warning icon, words.
  Void uses a dashed outline as an extra non-colour cue.
- **Don't:** a red dot alone; red numbers to mean "overdue"; a coloured row with no label.

**Tested by.** Unit test: the `StatusChip` component refuses to render without a label. Playwright:
every `[data-status]` element has non-empty `textContent`; axe `color-contrast` passes for every
chip (token pairs pre-verified by `tools/contrast.mjs`, all ≥ 5.4:1).

## P3 — Money is set for reading

**Statement.** Amounts are right-aligned, use tabular lining figures (`font-variant-numeric:
tabular-nums`), always show two decimals, use thousands separators, and show the currency once
(column header or prefix on hero numbers) rather than on every cell. Negatives in accounting views
are shown in parentheses `(1,250.00)` and announced as "minus" to screen readers; editable inputs
accept and display a leading minus. Never use red as the only signal of a negative.

**Why.** Columns of numbers must be scannable and comparable digit by digit (RQ-0080 §2);
accountants expect parentheses; non-accountants must not misread `(389.00)` — so the sign is also
in the accessible name and in the column heading ("Money out").

- **Do:** `<Money value="-389.00" />` → `(389.00)` with `aria-label="minus 389 dollars"`.
  Dr/Cr journal columns are always positive in separate columns.
- **Don't:** centre-aligned amounts, proportional digits, mixed decimals in a column, `$` on every
  cell, floating-point formatting (money is `decimal.js` end to end).

**Tested by.** Playwright: every `td.num`/`[data-amount]` has computed `text-align: right` and
`font-variant-numeric` containing `tabular-nums`; regex `^\(?[\d,]+\.\d{2}\)?$` on rendered text;
negatives have an accessible name containing "minus". Lint: no `Number()`/`parseFloat` on money.

## P4 — Show the journal before you post

**Statement.** Every action that will post (approve invoice, approve batch, confirm a bank match,
release a payment batch, activate a rule, void) offers **Show journal** — powered by the posting
engine's preview mode (design §3.9) — and in review screens the preview is open by default with a
**Balanced** indicator.

**Why.** It turns "magic" into something a non-accountant can learn from and an accountant can
verify, and it catches mapping gaps *before* they become reversals. Business Central's Preview
Posting is the precedent (RQ-0080 §3).

- **Do:** batch billing shows the summed journal for 38 invoices; the setup wizard shows what a
  $100 freight line would post once you choose an account; mobile approval shows the 3 lines.
- **Don't:** compute the preview in the browser; show a preview that can differ from what posts
  (the same engine code path is used, minus the write).

**Tested by.** Playwright: on each postable screen, `getByRole('button', { name: /show journal/i })`
or a region named "Journal" exists; its debit total equals its credit total; contract test asserts
preview response === journal actually written for the same idempotency key.

## P5 — Nothing posted is deleted; Void creates a reversal and says so

**Statement.** Posted documents have no Delete. The correction actions are named for what they do:
**"Void — creates reversal journal"**, **"Issue credit note"**. The confirm step shows the reversal
preview and states that the original stays visible. Where a user might look for Delete, the UI
says why it isn't there.

**Why.** Design principle 2 and D2 (immutable ledger); prevents the "where did that invoice go?"
audit problem; Xero allows delete only for drafts (RQ-0080 §3) — we are stricter and explain it.

- **Do:** invoice detail "Need to correct this invoice?" card; voided rows stay in lists with a
  struck-through number and "Reversed by JNL-004102".
- **Don't:** a trash-can icon on posted records; "Delete" in bulk actions; hiding voided documents
  by default without a count.

**Tested by.** Playwright: on any posted document no element has accessible name `/delete/i`
except a disabled explanation; the Void dialog contains text "reversal" and a balanced journal
table. API test: `DELETE` on posted resources returns 405.

## P6 — Controls explain themselves

**Statement.** Segregation-of-duties rules, approval thresholds, lock dates, cooling-off periods
and credit holds appear as a **plain-language sentence near the action, before the user tries it**
("Bills over $1,000 need someone other than the person who entered them"), not as an error after
submit. When an action is blocked, the message names the rule, who *can* do it, and when it
unblocks.

**Why.** Controls that surprise users get worked around. Explained controls get respected — and an
SMB owner learns the control model by using the product.

- **Do:** payment batch: "1 bill held back … can join the next batch after Sat 25 Oct, 7:55 am";
  close page: "September right now" matrix; batch billing exceptions column "What happens".
- **Don't:** a disabled button with no reason; "403 Forbidden"; "Period closed" without saying
  which policy (reject or redirect) applies.

**Tested by.** Playwright: every disabled primary action has `aria-describedby` pointing to visible
text of ≥ 20 characters; API error responses for SoD/lock rejections carry a `reason_code` that
maps to a user message (unit test over the full enum — no code may be unmapped).

## P7 — Two-person actions show both people

**Statement.** Wherever a control needs two people (maker-checker, author ≠ activator, two
releasers above $10,000, reopen hard lock), the UI shows the chain of **named people, roles,
times and state**, and highlights "you".

**Why.** Makes SoD tangible, prevents "who am I waiting for?", and gives auditors evidence on
screen.

- **Do:** PB-0087: Lena Ortiz (created) → Mei Tan (1st release ✓) → Sam Nguyen (you, 2nd release);
  rule studio: Priya Shah (author, you) → Sam or Mei (activator).
- **Don't:** "Approval pending" with no name; letting the creator see an enabled Release button.

**Tested by.** Playwright: on SoD screens a list named like "People involved" contains ≥ 2 items
with a role; logged in as the creator, the release/activate control is disabled and described by
an explanation (P6).

## P8 — Weakened controls are visible, never silent

**Statement.** Small-team mode, overrides of soft locks, released credit holds and documented SoD
exceptions are labelled where they happen, collected on a weekly exceptions report, and require
acknowledgement by the Owner (design §6.5).

**Why.** "The control is weakened visibly, never silently." Small teams legitimately need it;
auditors and outside accountants must still see it.

- **Do:** Home "Controls · Small-team mode · Review 2 exceptions"; close page "Override: MJ-0405 …
  reason recorded".
- **Don't:** silently allow the same person to create and release; bury overrides in a log only.

**Tested by.** Integration test: any action passing via exception emits an audit event with
`exception=true` and appears on `GET /reports/control-exceptions`; Playwright: Home shows the
Controls card when exceptions > 0.

## P9 — Sync is never hidden

**Statement.** The top bar always shows Salesforce sync health (word + dot). Every record that
syncs shows its sync state (Synced · Queued · Failed — fix · Not linked) with a link to the
Salesforce record. Failures land in the Sync issues inbox with the error in plain words, the
payload and a retry. Accounting never waits for Salesforce.

**Why.** Salesforce users act on what they see there; stale status erodes trust in both systems.
Design §5.6 rules 2 and 4.

- **Do:** invoice list "Salesforce" column; invoice detail sync card naming the fields written;
  inbox translating `ENTITY_IS_LOCKED` into an action.
- **Don't:** a spinner without a state; hiding sync errors from non-admins who caused them.

**Tested by.** Playwright: the global sync indicator exists on every authenticated route (layout
test); every list of synced entities has a sync column; a seeded failed outbox item appears in
the inbox with a Retry button that re-enqueues with the same idempotency key.

## P10 — Keyboard-first data entry

**Statement.** Everything is operable by keyboard with a visible focus ring (2px accent,
≥ 3:1). Lists support `J/K` move, `X` select, `Enter` open, `/` filter, `?` help; forms support
`Tab` order that follows reading order, `Enter` adds a line, `⌘/Ctrl+Enter` saves; global `⌘K`
search; `N` new document. Shortcuts are shown where they apply.

**Why.** Bookkeepers enter hundreds of lines; WCAG 2.1.1 Keyboard and 2.4.7 Focus Visible.

- **Do:** hint bar under lists; `kbd` hints on primary buttons.
- **Don't:** hover-only actions; custom widgets without roles; focus traps outside modals.

**Tested by.** Playwright: keyboard-only journeys for UC-01, 02, 05, 06, 08 (no `page.click`);
assert `:focus-visible` outline width ≥ 2px; axe rules `focus-order-semantics`,
`scrollable-region-focusable` (the mockup harness already runs axe; all screens 0 violations).

## P11 — Calm density: comfortable by default, compact on demand

**Statement.** Two density modes, a per-user setting: **Comfortable** (44px rows, 14px table text;
default) and **Compact** (32px rows, 13px; suggested to Accountant and AP/AR roles). Only vertical
padding and type size change — columns, alignment and order stay fixed. Whitespace, one accent
colour and neutral surfaces keep screens calm.

**Why.** Owners need clarity, bookkeepers need throughput (RQ-0080 §4).

- **Do:** `[data-density="compact"]` swaps tokens only; mockup 02 has the toggle.
- **Don't:** a third density; hiding columns in compact; per-screen density.

**Tested by.** Playwright: render list in both modes, assert row height 44±1 / 32±1 px and the
same column headers; visual snapshot per mode.

## P12 — Plain words first; one primary action per view

**Statement.** Headings and labels lead with plain language and keep the accounting term as
secondary text ("Customers owe you" · Receivables; "Which accounts does each sale go to?" · Posting
profiles). Each view or card has at most one primary (filled accent) button: the next safe step.

**Why.** Target user is a non-accountant owner who must finish setup in an afternoon (design §1);
the accountant still finds their term.

- **Do:** dashboard KPI labels; wizard step titles as questions; mobile "Approve $3,190.00".
- **Don't:** "Gen. bus. posting group" as a heading; two competing primary buttons.

**Tested by.** Content lint over the i18n catalogue (banned-term list for headings, e.g. "posting
group", "subledger"); Playwright: count of `.btn-primary` per `main`/dialog region ≤ 1 (list rows
excepted — bank reconciliation's per-row Confirm is a documented exception).

---

## Baseline checks on every screen

From the mockup harness, mandatory for `apps/web` too:

1. Exactly one `<h1>`, a non-empty `<title>`, `<main>` landmark, `html[lang="en-AU"]`.
2. No console errors; no third-party network requests (fonts and icons are bundled).
3. Every visible text node ≥ 4.5:1 against its rendered background (≥ 3:1 for large text).
4. axe-core WCAG 2.0/2.1/2.2 A and AA: zero violations.
5. No horizontal overflow at 1440×900 and at 390×844.
6. Light and dark themes both pass 1–5.
