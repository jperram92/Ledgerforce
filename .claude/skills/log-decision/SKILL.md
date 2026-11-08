---
name: log-decision
description: Use for every decision taken while building LedgerForce, however small - choosing a library or dev tool, interpreting an ambiguous spec, picking a naming or file convention, resolving a research question, changing a task card's scope, accepting or superseding an ADR. Appends a DL-NNNN entry to Docs/decisions/decision-log.md in the exact format at the top of that file.
---
# Skill: log-decision

## Steps

1. Read the **Format** block at the top of `Docs/decisions/decision-log.md`; it is authoritative.
2. Next id: `grep -oE '^### DL-[0-9]{4}' Docs/decisions/decision-log.md | tail -1` → +1.
   If two branches race for the same id, the later merge renumbers its own entry (never the
   other's) before merge.
3. Append at the **bottom** (newest last):
   ```markdown
   ### DL-NNNN — <short title>
   - Date: YYYY-MM-DD · By: <claude|codex> · Task: <T-NNNN> · Category: <process|architecture|accounting|security|tooling|ui|scope>
   - Decision: <one or two sentences>
   - Why: <reason, with links to RQ-NNNN or sources>
   - Alternatives: <considered and rejected, with why>
   - ADR: <ADR-NNNN | none> · Status: <accepted | proposed (awaiting human) | superseded by DL-NNNN>
   ```
4. Status: `proposed (awaiting human)` if the decision falls under a human gate
   (`Docs/process/human-gates.md`); otherwise `accepted`.
5. Never edit or delete a merged entry. To reverse a decision, add a new entry with
   `Supersedes DL-NNNN` in *Decision*, and append ` · Superseded by DL-MMMM` to the old entry's
   last line — the only edit allowed.
6. Mention the DL id in the HANDOVER field *Decisions taken* and in the run log. It is committed
   with your next checkpoint.
