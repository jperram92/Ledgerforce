# Docs/accounting — golden postings (human-owned)

> Local rules for this directory. They **add to** the root [`AGENTS.md`](../../AGENTS.md) and
> never contradict it; if they seem to, the root file wins. `CLAUDE.md` here only imports this file.

## What lives here
[`postings.md`](postings.md): the golden journal expectations `GP-NNN` for every standard event
(design §3.8) and any additional treatment the product owner has approved. Golden tests in
`packages/ledger/src/golden/*.golden.test.ts` assert them exactly.

## Local rules
- **Human-owned.** The product owner (an accountant) decides every golden posting. Agents may
  **only propose** — on a task branch, in a PR labelled **`golden_postings`** (skill
  `golden-posting`, human gate `golden_postings`).
- **Never edit an Approved posting.** To correct one, add a new `GP-NNN` section with status
  `Draft (proposed by <claude|codex>, T-NNNN)` that says `Proposes to supersede GP-MMM`, with
  the worked example, the reason and research sources (RQ). Only the product owner changes a
  status to **Approved** or marks the old one superseded.
- Never delete a posting, an example or an open question; superseded items stay with a forward
  link.
- Doubts go under the file's *Open questions for accountant* section and into
  `.agent/HANDOVER.md` → *Open questions for human*.
- Code may implement a posting only when it is **Approved**; until then dependent criteria are
  `blocked`.
- Amounts in examples are exact decimals (cents), with GST computed as stated in the posting;
  every example balances.
