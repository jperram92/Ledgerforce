# Codex pickup — Claude lead session 2026-11-08 → 2026-11-09

Written by the Claude lead session at the product owner's request ("commit everything as is — have
an MD document explaining what you did so Codex can pick it up"). The repository is the memory;
read this, then `AGENTS.md`, then `git log --format=full -15` on this branch.

## Codex continuation prompt

> Resume from the repository, not the chat. Branch `claude/incomplete-features-build-wivsco` (tip:
> the commit that adds this file). Read `AGENTS.md`, run `bash scripts/agent/resume.sh`, then read
> this file in full. **First decide the two-lineage question in §1 with the owner** — do not merge
> either line into the other blind. Then: cross-review the cards in `review` that Claude built (§3),
> and finish the four interrupted tasks from the patches in §4 (re-verify each; nothing in §4 is
> verified). Keep the research, TDD, evidence, golden and human gates intact.

---

## 1. STOP — there are two parallel lines of work (owner decision needed)

While this session built on `claude/incomplete-features-build-wivsco`, **another line of work
already existed on the remote**, built 2026-11-01…11-08 by another Claude session and by commits
under the owner's account (`jperram92`):

| | This branch (`claude/incomplete-features-build-wivsco`) | Other line (`origin/feat/T-*`) |
|---|---|---|
| Diverges from `main` at | `c1dfbca` (T-0114) | `c1dfbca` (T-0114) |
| Tip | this commit | `origin/feat/T-0070-sf-nightly-reconciliation` (contains 30 of the feat branches, 117 commits past `main`) |
| Tasks built | T-0007 approval, 31, 32, 33, 34, 35, 38, 39, 40, 45, 46, 49, 50, 52, 54, 65, 121, 124 (+ partial 41, 47, 48, 69) | ~T-0031…T-0080 incl. 41–44, 47, 48, 51, 55–57, 60, 61, 66, 69, 70, 73, 74, 77, 80, 96 |
| Golden approval | GP-001…020 + GP-007-A/012-B/015-B/E-001…004, Approved "owner-delegated to claude" (DL-0253, DL-0282) | "golden postings approved by owner instruction" on `feat/T-0115-aasb-alignment` |
| Task ids T-0115…T-0126 | mean *different* cards on the two lines (e.g. here T-0115 = nightly gap-check job; there T-0115 = AASB alignment) |
| Decision-log / migration numbers | DL-0242…0387, migrations 0031…0042 | overlapping numbers with different content (e.g. migration 0051 on T-0061) |

Neither line has been merged into `main`. They cannot be merged mechanically: same task ids,
decision ids, migration numbers and golden-file approvals collide with different content.

**Ask the owner which line is canonical.** Options: (a) keep the other line (it covers more tasks)
and port across only what it lacks from this branch (e.g. ADR-0044/0045 tax determination, the
accountant-reviewer persona, T-0121 templates v2, the T-0124 golden variants, T-0033's 10,000-doc
suite); (b) keep this line and port the missing tasks; (c) reconcile task by task. Record the choice
as a DL entry and supersede (never delete) the other line's cards/ids.

This session only discovered the other line at the very end, when a push of task branches was
refused (§4). That is a process gap: `resume.sh` reads the local checkout only. Suggested
follow-up: have `resume.sh` list `git ls-remote --heads origin 'feat/*'` and warn about unmerged
task branches.

---

## 2. What this session did (this branch), in order

All merges into this branch were re-checked in the lead checkout after merging: typecheck, lint,
format, `lint-backlog`, `pnpm test`, `pnpm test:db`. Last full results: **unit 1144/1144, db
1375/1375 (after the T-0124 merge, 624cb61)**. Full `verify.sh` on the merged tree last ran after
T-0038 (14 PASS / 0 FAIL / 2 PENDING: golden + cross-review); since then per-merge gate subsets only.

### Owner decisions recorded (human gates)
- **DL-0242** build ahead of the golden gate (owner choice).
- **DL-0248** `accountant-reviewer` AI persona (`.claude/agents/accountant-reviewer.md`) replaces paid
  external accounting review — owner: "I won't be paying for external support". It is *not* a
  registered practitioner; every report says so.
- **DL-0253** golden postings GP-001…GP-020 approved by Claude under owner delegation ("go and find
  the answer and unblock it all on codex behalf"), after research RQ-0095.
- **DL-0282** delegation extended: Claude may approve superseding goldens and accept **accounting**
  ADRs after a persona re-review with no BLOCKER ("Yes, approve as you go").
- Gate 4 (golden diff guard) **FAILs by design on this branch** — it flags Approved lines added vs
  `main`. It clears only when the owner merges to `main`. The guard was not edited.

### Tasks merged (all in `review`, awaiting Codex cross-review)
| Task | What | Key ids |
|---|---|---|
| T-0007 | Goldens approved (delegated); runner phase gate + `requires` marker | RQ-0095, DL-0253..0257 |
| T-0031 | Golden-posting runner (approved-only in CI) | DL-0246 |
| T-0034 | Tax codes + GST engine, per-line/per-document rounding | mig 0031, RQ-0094, DL-0243..0245 |
| T-0038 | Products, party/product posting profiles | mig 0032, RQ-0096, DL-0249..0251 |
| T-0039 | Profile resolution + gap check | RQ-0097, DL-0260/0261 |
| T-0065 | Salesforce inbound mapping | mig 0034, RQ-0098, DL-0265..0269 |
| T-0032 | Reversal / void (GP-019) | DL-0270..0272 |
| T-0035 | BAS label map + report (accruals/cash) | mig 0036, RQ-0102, DL-0275..0279, 0288 |
| T-0040 | Sales invoice lifecycle (GP-001, GP-018) | mig 0037, RQ-0104, DL-0294..0297 |
| T-0050 | Supplier bills (GP-008) | mig 0038, RQ-0106, DL-0290..0293 |
| T-0121 | AU templates v2 (CAP fixed assets, ECL 1290, EXS…) | DL-0340..0342 |
| T-0046 | Customer receipts (GP-002) | mig 0039, RQ-0112, DL-0310..0313 |
| T-0033 | Invariant suite, 10,000 docs; CI job `invariants` | DL-0300/0301 |
| T-0045 | Credit notes (GP-005), invoice-line link (ADR-0044 W6) | mig 0040, RQ-0114, DL-0320..0324 |
| T-0052 | Bill approval with SoD | mig 0041, RQ-0116, DL-0330..0333 |
| T-0054 | Payment batches, maker-checker, step-up release | mig 0042, DL-0350..0354 |
| T-0049 | Customer statements + aged AR | RQ-0122, DL-0360..0363 |
| T-0124 | Golden variants GP-007-A, GP-012-B, GP-015-B, errata E-001..004 (Approved, DL-0282) | ADR-0045, DL-0380..0387 |

Migrations 0033 and 0035 are documented no-op slot fillers (DL-0284, DL-0287).
Accounting ADRs accepted under delegation: **ADR-0044** (GST tax determination, DL-0286),
**ADR-0045** (single-supply GST, `GST-UB`, DL-0387). Accountant persona reviews:
`.agent/evidence/T-0007/accounting-review-*.md`, `.agent/evidence/T-0121/`, `.agent/evidence/T-0124/`.

### Backlog cards added
T-0115, T-0116, T-0117, T-0121…T-0126, T-0130, T-0135, T-0136, T-0140, T-0145, T-0150, T-0165
(ids are this branch's; see §1 for collisions with the other line).

---

## 3. Open questions for the owner (human gates)
1. **Which line is canonical** (§1).
2. **T-0117** — may the creator of a sales invoice approve it? Recommendation: no above the
   auto-approve threshold, small-team exception as in design §6.5. Security ADR needed.
3. **Security ADRs 0016, 0018, 0023, 0025, 0026, 0030 are still Proposed.** T-0013, T-0015, T-0053
   and T-0054 rely on them. The DL-0282 delegation covers accounting only, not security.
4. Network access to ato.gov.au / legislation.gov.au / austlii / aasb.gov.au / Stripe docs could not be
   granted from the owner's mobile app; all tax research rests on search extracts (confidence noted
   per RQ). Re-check list: DL-0285, DL-0386.

---

## 4. Interrupted work — committed as-is, NOT verified

The four builders below stopped on a usage limit. Their work was committed as-is on local task
branches. **Pushing task branches is refused for this session (HTTP 403)**, except
`feat/T-0048-bad-debt`, which was pushed before the refusals (new branch name; the other line has
`feat/T-0048-write-off`). So every interrupted task is also saved here as patches:

`.agent/handover/wip-patches-2026-11-09/<task>/*.patch` — apply with
`git checkout -b <branch> <base> && git am .agent/handover/wip-patches-2026-11-09/<task>/*.patch`.

| Task | Base commit | State | Next |
|---|---|---|---|
| T-0069 Closed Won → draft invoice | `4d6a650` | 3 commits: idempotent draft creation, GP-001 golden from Closed Won, evidence; builder reported tests green; full verify not re-run | Merge this branch's tip first (it lacks mig 0042), re-run `verify.sh --task T-0069`, release to review. Local placeholders for 0042/0043 were *not* committed. |
| T-0047 Prepayments / single supply | `624cb61` | Claimed; RQ-0128 draft only | Build per ADR-0045 (R1–R9, `GST-UB`, G1 11,000.00 test); mig 0045 |
| T-0048 Bad-debt write-off | `624cb61` | Claimed; RQ-0130; journal builder + unit test (RED/GREEN not recorded) | Run tests; GP-007 / GP-007-A goldens; BAS 1B 125.00 accruals only; mig 0046 |
| T-0041 Invoice PDF | `624cb61` | Claimed; RQ-0132; ADR-0046 draft (playwright-core runtime dep); `packages/modules/billing` scaffold; lockfile changed | Decide ADR-0046; tests first; mig 0047 only if needed |

Card leases for these four are still held by `claude` in their cards on the task branches; release or
reclaim with `node scripts/agent/conductor.ts`. On this branch their cards still say `todo`.

## 5. Known verify artefacts (not code failures)
- `scripts/agent/test/run.test.ts` "routes a card in review…" fails when the checkout path contains
  `.claude/` (agent worktrees). Passes in a normal checkout.
- Under heavy parallel load, `no-float-money.config.test.ts` and `manifest.test.ts` can hit their 5 s
  timeouts and Playwright can fail a screenshot; all pass when run alone. No timeouts were changed.
- Running `pnpm test:e2e` outside `verify.sh` writes screenshots into other tasks' evidence folders
  (DL-0098); discard those.
