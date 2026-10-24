# Decision log

Every decision taken while building LedgerForce, big or small, newest at the bottom.
Big decisions (data model, accounting treatment, security model, public API, integration
contract, new runtime dependency) also get an ADR in [`Docs/adr/`](../adr/); this log links to it.
Entries are never edited or deleted after merge — a reversed decision gets a new entry that
says `Supersedes DL-NNNN`, and the old entry gets a trailing `Superseded by DL-MMMM` note only.

**Format**

```
### DL-NNNN — <short title>
- Date: YYYY-MM-DD · By: <human | claude | codex> · Task: <T-NNNN | sprint-0> · Category: <process|architecture|accounting|security|tooling|ui|scope>
- Decision: <one or two sentences>
- Why: <reason, with links to research RQ-NNNN or sources>
- Alternatives: <what was considered and rejected>
- ADR: <ADR-NNNN | none> · Status: <accepted | proposed (awaiting human) | superseded by DL-NNNN>
```

---

### DL-0001 — Solution design adopted as the build baseline
- Date: 2026-10-24 · By: claude · Task: sprint-0 · Category: scope
- Decision: `Docs/solution-design/solution-design.md` (design dated 2026-10-24) is the scope baseline. Anything outside it is a human gate.
- Why: Product-owner instruction — "follow this scope; consult me only outside it".
- Alternatives: none.
- ADR: none · Status: accepted

### DL-0002 — AGENTS.md is canonical; CLAUDE.md imports it
- Date: 2026-10-24 · By: claude · Task: sprint-0 · Category: process
- Decision: All rules live in `AGENTS.md`; `CLAUDE.md` is `@AGENTS.md` plus additive Claude-only notes.
- Why: Design §10.2 — guarantees Claude and Codex read identical rules so either can resume the other's work.
- Alternatives: separate per-provider files (rejected: drift).
- ADR: ADR-0001 family (process) · Status: accepted

### DL-0003 — Use the existing `Docs/` directory instead of `docs/`
- Date: 2026-10-24 · By: claude · Task: sprint-0 · Category: process
- Decision: All documentation paths in design §7.3/§10.2 that say `docs/` live under `Docs/`.
- Why: The repo already had `Docs/` and the product owner forbids deleting or moving existing content. Creating a second `docs/` would collide on case-insensitive filesystems (macOS, Windows), breaking checkouts for anyone on those platforms.
- Alternatives: rename `Docs/`→`docs/` (rejected: deletion/move forbidden); keep both (rejected: case collision).
- ADR: none · Status: accepted

### DL-0004 — No-delete rule; forward-only, additive migrations
- Date: 2026-10-24 · By: human (product owner) · Task: sprint-0 · Category: process
- Decision: Agents never delete tracked files, tasks, ADRs, research, logs, evidence or data. Superseding replaces deletion. Migrations never drop or rename in place.
- Why: Product-owner directive; also consistent with design principle 2 (nothing posted is ever edited or deleted).
- Alternatives: none.
- ADR: none · Status: accepted

### DL-0005 — Agent tooling is zero-dependency Node.js
- Date: 2026-10-24 · By: claude · Task: sprint-0 · Category: tooling
- Decision: `scripts/agent/*` (conductor, claim, checkpoint, lease) run on plain Node.js 22 with built-in type stripping and `node:test`, no npm install required.
- Why: Failover must work in a fresh checkout even when dependency installation is what broke; fewer moving parts for a second provider to understand.
- Alternatives: tsx/ts-node + npm deps (rejected: needs install before the conductor can even start).
- ADR: none · Status: accepted

### DL-0006 — No model identifiers pinned in repository config
- Date: 2026-10-24 · By: claude · Task: sprint-0 · Category: process
- Decision: `.agent/config.yaml` names providers (`claude`, `codex`) and CLIs, not model ids; task cards record `claimed_by: <provider>`.
- Why: Models change faster than the repo; each CLI's default/current model is used, and the run log records what actually ran.
- Alternatives: pin model ids (rejected: stale config, silent failures when a model is retired).
- ADR: none · Status: accepted

### DL-0007 — Local PostgreSQL harness when Docker is unavailable
- Date: 2026-10-24 · By: claude · Task: sprint-0 · Category: tooling
- Decision: Integration tests use Testcontainers (Postgres 17) when a Docker daemon is reachable, and otherwise start a throw-away local cluster with the installed `initdb`/`pg_ctl` binaries. Both paths run the same migrations and the same tests.
- Why: Agent sandboxes (including the one this was built in) often have Postgres binaries but no Docker daemon; "no Docker" must not become "no database tests". Local binaries here are PostgreSQL 16, so migrations must stay compatible with 16 and 17 until ADR says otherwise.
- Alternatives: skip DB tests without Docker (rejected: shortcut); pg-mem / PGlite (rejected: no full RLS/trigger/role fidelity — see research).
- ADR: none (tooling) · Status: accepted

### DL-0008 — ADR system adopted; seed ADR statuses assigned
- Date: 2026-10-24 · By: claude · Task: sprint-0 · Category: process
- Decision: ADRs live in `Docs/adr/` as MADR files with machine-checkable frontmatter. 0001, 0002 and 0008 are Accepted; 0003, 0004, 0005, 0007 and 0010 stay Proposed with human_gate yes ("design-committed; awaiting product-owner acceptance"); 0006 stays Proposed until the connector task.
- Why: Design §10.6 and §10.1 principle 6; AGENTS.md §6 human gates.
- Alternatives: accept all design-committed ADRs now (rejected: bypasses the accounting/security gate); a wiki (rejected: not repo-resident).
- ADR: ADR-0001 · Status: accepted

### DL-0009 — Licence left open; no LICENSE file until decided
- Date: 2026-10-24 · By: claude · Task: sprint-0 · Category: scope
- Decision: ADR-0009 is Proposed with the recommendation (AGPL-3.0 core, Apache-2.0 SDKs and Salesforce package) and the alternatives. Agents add no LICENSE file or SPDX headers until the product owner decides.
- Why: Design §11.2 open decision; §11.1 says decide before the first public commit.
- Alternatives: adopt the recommendation unilaterally (rejected: human gate).
- ADR: ADR-0009 · Status: proposed (awaiting human)

### DL-0010 — Sprint 0 process decisions recorded as ADRs 0011–0015
- Date: 2026-10-24 · By: claude · Task: sprint-0 · Category: process
- Decision: Failover/repo-state model, TDD with golden postings and invariants, the DB harness, the no-delete policy and Playwright evidence each get an Accepted ADR cross-linked to DL-0002 and DL-0004–DL-0007.
- Why: They constrain every future task and migration — meets the §10.6 ADR bar.
- Alternatives: decision-log entries only (rejected: lack options and verification).
- ADR: ADR-0011..0015 · Status: accepted

### DL-0011 — Seed ADRs double as dependency ADRs for decimal.js and pg-boss
- Date: 2026-10-24 · By: claude · Task: sprint-0 · Category: architecture
- Decision: ADR-0005 covers the `decimal.js` runtime dependency and ADR-0008 covers `pg-boss` (major version pinned; supports PG ≥13, so 16 and 17).
- Why: AGENTS.md §4 requires an ADR per runtime dependency; facts checked on the npm registry and pg-boss README.
- Alternatives: separate dependency ADRs (rejected: duplication).
- ADR: ADR-0005, ADR-0008 · Status: proposed (0005) / accepted (0008)

### DL-0012 — Changelog tool is release-please; Unreleased kept by hand until first release
- Date: 2026-10-24 · By: claude · Task: sprint-0 · Category: tooling
- Decision: Use release-please, not Changesets.
- Why: Works directly from the Conventional Commits AGENTS.md already mandates; no per-PR changeset files.
- Alternatives: Changesets (rejected: extra file per PR).
- ADR: none · Status: accepted

### DL-0013 — Human-gate labels applied only by the product owner
- Date: 2026-10-24 · By: claude · Task: sprint-0 · Category: process
- Decision: `adr:accounting`, `adr:security`, `golden_postings` and `human-gate` are applied only by the human; `cross-review` by the provider that did not build the work.
- Why: Design §10.6 acceptance is by PR label; an agent labelling its own approval defeats the gate.
- Alternatives: GitHub approvals only (rejected: can't tell gate types apart).
- ADR: ADR-0001 · Status: accepted

### DL-0014 — Golden-posting cards depend on the golden runner and approved goldens
- Date: 2026-10-24 · By: claude · Task: sprint-0 · Category: process
- Decision: Every card whose acceptance includes an MVP golden scenario depends on T-0031 (golden-posting test runner), which depends on T-0007 (human-approved golden postings).
- Why: AGENTS.md §0.2 (expected result before code); design §10.10 (golden postings come from the human in Sprint 0).
- Alternatives: build against Draft goldens and reconcile later (rejected: accounting logic would rest on unapproved expectations).
- ADR: none · Status: accepted

### DL-0015 — Account bindings missing from §3.2 drafted as settings, not system roles
- Date: 2026-10-24 · By: claude · Task: sprint-0 · Category: accounting
- Decision: Stripe clearing, merchant fees, bad debts and payroll expense accounts are drafted as connector/module settings (`setting:*`) pending accountant answers Q2/Q3 in `Docs/accounting/postings.md`.
- Why: §3.2's system-role list does not include them; RQ-0090.
- Alternatives: add new system roles (left to the human).
- ADR: none · Status: proposed (awaiting human)

### DL-0016 — Draft GST treatments in golden postings
- Date: 2026-10-24 · By: claude · Task: sprint-0 · Category: accounting
- Decision: Bad-debt GST adjustment = debit GST collected, reported at BAS 1B; Stripe receipt recognised at charge, fee + GST on fee at payout; prepayment per design (Option A); per-document rounding residue to ROUNDING. All flagged as Q1–Q11 for the accountant.
- Why: RQ-0090 (ATO adjustments and accounting-basis pages; Stripe GST-on-fees support page); design §3.4, §3.8.
- Alternatives: recorded per question in postings.md (e.g. Option B: GST on prepayment receipt).
- ADR: none · Status: proposed (awaiting human)

### DL-0017 — Task ids in stable dependency order; tests named by scenario id
- Date: 2026-10-24 · By: claude · Task: sprint-0 · Category: process
- Decision: Card ids follow dependency order (T-0001..T-0009 Sprint 0, T-0010+ MVP, epics for Phases 1–3). Each test title starts with its SS id so the register links tests to scenarios. SS ids are never renumbered — superseded instead.
- Why: AGENTS.md §2 claim rule and §0.6 no-delete.
- Alternatives: number by module (rejected: claim order would diverge from dependencies).
- ADR: none · Status: accepted

### DL-0018 — Cross-review and security-review reports stored as task evidence
- Date: 2026-10-24 · By: claude · Task: sprint-0 · Category: process
- Decision: Review reports are committed to `.agent/evidence/<T-ID>/review-<provider>-<YYYYMMDD-HHMMSS>.md` (security: `security-review-…`) and also posted to the PR.
- Why: The repository is the only memory; reuses the per-task evidence folder.
- Alternatives: PR comments only (lost on failover); new `.agent/reviews/` dir (extra path).
- ADR: none · Status: accepted

### DL-0019 — RED test-only commits are not checkpoints
- Date: 2026-10-24 · By: claude · Task: sprint-0 · Category: process
- Decision: Failing tests handed between roles are committed as `test(<scope>): RED … [T-NNNN]`, never via `conductor.ts checkpoint`.
- Why: `last_checkpoint` must always be a green commit (design §10.3/§10.4) so failover resumes from green.
- Alternatives: RED checkpoints with a marker (breaks resume-from-green).
- ADR: none · Status: accepted

### DL-0020 — Codex skill discovery via `.agents/skills` symlink
- Date: 2026-10-24 · By: claude · Task: sprint-0 · Category: tooling
- Decision: `.agents/skills` is a relative symlink to `../.claude/skills`; one canonical copy of each skill.
- Why: Codex scans `.agents/skills` from cwd up to repo root and follows symlinks (developers.openai.com/codex/skills, via search excerpts — page not directly reachable; to be confirmed by RQ-0001).
- Alternatives: duplicated copies (drift); path-only reading (no native discovery).
- ADR: none · Status: accepted

### DL-0021 — Human-gate PR labels equal config gate names
- Date: 2026-10-24 · By: claude · Task: sprint-0 · Category: process
- Decision: Gate labels are `adr:accounting`, `adr:security`, `golden_postings`, `release`, `phase_gate`, `out_of_scope`, alongside a HANDOVER "Open questions for human" entry and `release --status blocked`.
- Why: One vocabulary across `.agent/config.yaml`, PRs and HANDOVER (design §10.6).
- Alternatives: single `needs-human` label (loses gate type).
- ADR: none · Status: accepted

### DL-0022 — Sub-agent and skill frontmatter kept minimal and portable
- Date: 2026-10-24 · By: claude · Task: sprint-0 · Category: tooling
- Decision: Sub-agents declare only `name`, `description`, least-privilege `tools`; skills only `name`, `description`. No `model` field.
- Why: DL-0006 forbids model pins; files stay readable by Codex; unknown fields are ignored by Claude Code (code.claude.com/docs/en/sub-agents).
- Alternatives: `model`, `skills`, `permissionMode` fields (provider-specific or model pins).
- ADR: none · Status: accepted

### DL-0023 — Periodic health loop runs on its own chore branch
- Date: 2026-10-24 · By: claude · Task: sprint-0 · Category: process
- Decision: The nightly health loop (scribe role) works on `chore/health-<YYYY-MM-DD>`; larger fixes become task cards.
- Why: Not a task, so no `feat/T-NNNN` branch; must never push to `main`.
- Alternatives: synthetic task card per night (backlog noise).
- ADR: none · Status: accepted

### DL-0024 — Conductor invocation flags for Codex and Claude
- Date: 2026-10-24 · By: claude · Task: sprint-0 · Category: tooling
- Decision: Codex runs `codex exec --cd <repo> -s workspace-write -c sandbox_workspace_write.network_access=true --json -o <file>`; Claude runs `claude -p --output-format stream-json --verbose --permission-mode acceptEdits --max-turns N`. The conductor makes the checkpoint commits for Codex runs. Args are recorded in `.agent/config.yaml`.
- Why: RQ-0001 (`--full-auto` removed; `.git` read-only in workspace-write); RQ-0002 (`-p` starts in Manual mode since 2.1.302).
- Alternatives: bypass/dangerous permission flags (rejected outside an isolated container).
- ADR: none · Status: accepted

### DL-0025 — Extend provider failure patterns (case-insensitive, stdout + stderr)
- Date: 2026-10-24 · By: claude · Task: sprint-0 · Category: process
- Decision: Added `hit your .* limit`, `session limit`, `weekly limit`, `spend limit`, `credit balance is too low`, `at capacity`, `high demand`, `exceeded retry limit`, `temporarily limiting requests`, `529` to `.agent/config.yaml`.
- Why: RQ-0001/RQ-0002 list the real error strings, and four sub-agents of this very session stopped on "You've hit your session limit · resets 7:30am (UTC)", which the original patterns would have missed. Codex exits 1 on every failure, so exit codes alone can't classify.
- Alternatives: exit codes only (rejected). Lead edited the human-owned config because failover is an explicit product-owner requirement; the human may revise.
- ADR: ADR-0011 · Status: accepted

### DL-0026 — Share skills with Codex via `.agents/skills`; keep AGENTS.md under 32 KiB
- Date: 2026-10-24 · By: claude · Task: sprint-0 · Category: process
- Decision: Confirms DL-0020. Add a verify gate that AGENTS.md stays under 32 KiB.
- Why: RQ-0001 — Codex scans `.agents/skills`, follows symlinks, and truncates AGENTS.md beyond 32 KiB.
- Alternatives: duplicate skill files (rejected: drift).
- ADR: none · Status: accepted

### DL-0027 — CEL via @marcbachmann/cel-js with a decimal type
- Date: 2026-10-24 · By: claude · Task: sprint-0 · Category: architecture
- Decision: `packages/rules` wraps `@marcbachmann/cel-js` (exact pinned version); money is a decimal.js-backed `decimal` type and `double` is rejected in rules.
- Why: RQ-0003 (decimal behaviour tested; maintained; no deps).
- Alternatives: `@bufbuild/cel` with scaled integers (fallback); `cel-js` (less active).
- ADR: required (runtime dependency) — to be written by the Rules Studio task · Status: proposed

### DL-0028 — RLS policy and ledger-guard SQL patterns
- Date: 2026-10-24 · By: claude · Task: sprint-0 · Category: security
- Decision: Policies use `NULLIF(current_setting('app.tenant_id', true), '')::uuid` with per-transaction `set_config(..., true)`; `journal_line` gets a BEFORE INSERT guard against adding lines to posted entries; ledger writes go through a SECURITY DEFINER `post_entry()` with INSERT revoked from `lf_app`; minimum PostgreSQL 16.15 / 17.11.
- Why: RQ-0007 — run on 16.15; proved the app role could add lines to a posted entry and that account_balance/subledger lack DB invariants (RQ-0012 item 2 fail).
- Alternatives: rely on grants + lint (rejected: insert hole proven).
- ADR: addendum to ADR-0003/0004 · Status: proposed (awaiting human — security/accounting)

### DL-0029 — Local-cluster test DB fallback confirmed; pg-mem rejected
- Date: 2026-10-24 · By: claude · Task: sprint-0 · Category: tooling
- Decision: Confirms DL-0007. Harness runs the cluster as a non-root user and checks `server_version_num >= 160015`; PGlite only for SQL-function smoke tests; pg-mem not used.
- Why: RQ-0008 (all options executed).
- Alternatives: embedded-postgres (beta builds lag security releases).
- ADR: ADR-0013 · Status: accepted

### DL-0030 — Salesforce Pub/Sub client and default CDC set (≤ 5 objects)
- Date: 2026-10-24 · By: claude · Task: sprint-0 · Category: architecture
- Decision: `salesforce-pubsub-api-client` behind a port. Default CDC: Account, Contact, Opportunity, OpportunityLineItem, Product2; Order, OrderItem, AccountContactRelation are polled. Invalid replay id triggers immediate reconciliation.
- Why: RQ-0004 — 5-entity cap without add-on (design §5.3 lists 8), 72 h retention, Enterprise allocation 25,000/day (design quotes Unlimited's 50,000).
- Alternatives: hand-rolled gRPC client (fallback).
- ADR: required (dependency; changes design §5.3) · Status: proposed (awaiting human)

### DL-0031 — ABA generator defaults
- Date: 2026-10-24 · By: claude · Task: sprint-0 · Category: architecture
- Decision: 120-char records, CRLF after every record, code 50 suppliers / 53 pay, per-bank profile (trailing CRLF, self-balancing record, max records).
- Why: RQ-0006.
- Alternatives: one hard-coded format (rejected: banks differ).
- ADR: none · Status: accepted

### DL-0032 — AU GST rounding default (proposed change to design §3.4)
- Date: 2026-10-24 · By: claude · Task: sprint-0 · Category: accounting
- Decision: Proposed: line GST stored to 4 dp, invoice GST total rounded half-up to cents (ATO total-invoice rule), difference to ROUNDING — replacing design §3.4 "per line, half-up to cents". Golden postings GP-018a/b show both until decided.
- Why: RQ-0009 (ATO tax-invoice guidance, s9-90 explanatory memorandum).
- Alternatives: design's per-line rounding.
- ADR: accounting ADR required · Status: proposed (awaiting human)
