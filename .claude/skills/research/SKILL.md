---
name: research
description: Use whenever a requirement, external API (Salesforce, Stripe, ABA, bank formats, Peppol), regulation (ATO, GST, BAS, privacy), standard or library behaviour is unclear, or a task card has open questions or an open RQ. Produces a sourced record Docs/research/RQ-NNNN-<slug>.md that must be resolved before any code for that question is written.
---
# Skill: research

Research before build (`AGENTS.md` §0.4). A task may not be `in_progress` while a linked RQ is
`open`.

## Steps

1. **Avoid duplicates:** `grep -ril "<keyword>" Docs/research/`. If an existing RQ answers it,
   link it in the card's `research:` and stop.
2. **Allocate the id:** `ls Docs/research/ | grep -E '^RQ-[0-9]{4}' | sort | tail -1` → next
   number, zero-padded to 4 digits.
3. **Create the record** by copying the template (never edit the template itself):
   ```bash
   cp Docs/research/RQ-0000-template.md Docs/research/RQ-NNNN-<slug>.md
   ```
   Fill in the frontmatter (`id`, `title`, `status: open`, `opened`, `opened_by: <claude|codex>`,
   `task`) and the question with its context (card id, design section). Use exactly the fields
   and status values defined in `Docs/research/RQ-0000-template.md`
   (`open | answered | answered-pending-human | superseded`); if this skill and the template
   ever differ, the template wins.
4. **Link it:** add `RQ-NNNN` to the card's `research:` list; set card `status: researching`.
5. **Gather sources**, primary first: vendor docs (developer.salesforce.com, docs.stripe.com),
   regulators (ato.gov.au, legislation.gov.au, oaic.gov.au), standards, library source code,
   release notes. For each: URL, title, retrieval date (YYYY-MM-DD) and the exact fact it
   supports, quoted or paraphrased tightly. Note version numbers.
6. **Spike when docs are ambiguous:** smallest reproducible experiment outside product code
   (scratch dir or throw-away test). Record the exact command and the output in the RQ.
7. **Conclude:** answer, confidence (high/medium/low), consequences for design and tests, and
   follow-ups:
   - a decision → skill `log-decision` (and `write-adr` if design §10.6 applies);
   - a human gate (accounting/security treatment, out of scope, design §11.2 open item) →
     `Docs/process/human-gates.md`;
   - new expected results → update the card's acceptance criteria.
8. Set `status: answered` (needs ≥1 primary source or a reproducible spike). If the answer
   needs the product owner (accounting/security treatment, scope), set
   `status: answered-pending-human` and record it per `Docs/process/human-gates.md`; criteria that
   depend on it stay blocked. A wrong RQ is never deleted: set `status: superseded` and add a
   forward link `Superseded by RQ-MMMM`.
9. When no linked RQ is `open` (all `answered`, or `answered-pending-human` with the dependent
   criteria marked blocked in the card), set card `status: in_progress` and checkpoint:
   ```bash
   node scripts/agent/conductor.ts checkpoint T-NNNN --step "k/n — RQ-NNNN answered"
   ```
