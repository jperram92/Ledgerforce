---
name: write-adr
description: Use when a LedgerForce decision changes the data model, accounting treatment, security model, public API, integration contract, or adds a runtime dependency (design §10.6), or when superseding an existing ADR. Creates Docs/adr/NNNN-<slug>.md from the MADR template, sets the right status and human gate, and links it from the decision log.
---
# Skill: write-adr

## When an ADR is required (design §10.6)

Data model change · accounting treatment · security model · public API · integration contract ·
new **runtime** dependency. (Dev-only tooling → decision-log entry only, skill `log-decision`.)

## Steps

1. Research first if any fact is unclear (skill `research`); the ADR cites RQ ids.
2. Next number: `ls Docs/adr | grep -E '^[0-9]{4}-' | sort | tail -1` → +1, 4 digits. Never reuse
   a number.
3. Copy the template (never edit `0000-template.md` itself):
   ```bash
   cp Docs/adr/0000-template.md Docs/adr/NNNN-<kebab-slug>.md
   ```
4. Fill **every** section (write `n/a — <reason>` where something truly does not apply):
   frontmatter `adr`, `title`, `status: Proposed`, `date`, `author: <claude|codex>`,
   `category` (`architecture | accounting | security | integration | data | process | tooling`),
   `human_gate`, `supersedes`; context with design § and RQ links; drivers; ≥2 considered
   options with pros/cons; decision outcome stated as checkable rules; consequences;
   *Compliance and verification* table naming the test/lint/verify gate that enforces it.
5. Status rules:
   - `category: accounting` or `security`, or the subject is in design §11.2 → `human_gate: yes`,
     status stays **Proposed** until the product owner accepts. Record the gate per
     `Docs/process/human-gates.md` (HANDOVER *Open questions for human*, PR label
     `adr:accounting` or `adr:security`). Code that depends on it may be written test-first on
     the branch, but the task cannot reach `done` until the ADR is Accepted.
   - Other categories → `human_gate: no`; becomes **Accepted** when CI is green and the
     cross-provider reviewer agrees (record "Accepted on green CI + cross-review by <provider>").
6. Superseding: the new ADR sets `supersedes: ADR-NNNN`; in the old ADR change **only** the
   `superseded_by:` line and the status line to `Superseded by ADR-MMMM`. Never delete or rewrite
   the old ADR's content.
7. Add a row to the index `Docs/adr/README.md`.
8. Log it with skill `log-decision` (`ADR: ADR-NNNN`).
9. Set the card's `adr_required` work as done in *Steps* and checkpoint:
   ```bash
   node scripts/agent/conductor.ts checkpoint T-NNNN --step "k/n — ADR-NNNN proposed"
   ```
