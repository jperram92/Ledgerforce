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

### DL-0033 — Dev tooling versions for the monorepo
- Date: 2026-10-24 · By: claude · Task: T-0008 · Category: tooling
- Decision: typescript 6.0.3, vitest 4.1.12, eslint 10.13 + typescript-eslint 8.72, prettier 3.9.10, fast-check 4.10.2, testcontainers 12.2.1, @playwright/test 1.63.0 (pinned to match preinstalled Chromium build).
- Why: typescript-eslint supports TS < 6.1 (rules out TS 7); vitest 4.x is the stable line with the `projects` API; Playwright must match the installed browser.
- Alternatives: TS 7 (no lint support); vitest 5 (new major).
- ADR: none · Status: accepted

### DL-0034 — Run TypeScript source directly (no build step)
- Date: 2026-10-24 · By: claude · Task: T-0008 · Category: tooling
- Decision: Packages export `src/*.ts` with `.ts` import extensions and `erasableSyntaxOnly`; Node ≥ 22.18 required.
- Why: Consistent with DL-0005; one code path for Node, Vitest and Playwright.
- Alternatives: tsc build or tsx (extra step that can drift).
- ADR: none · Status: accepted

### DL-0035 — Superuser role bootstrap separate from migrations
- Date: 2026-10-24 · By: claude · Task: T-0008 · Category: security
- Decision: `lf_migrator` and `lf_app` are created by idempotent `packages/db/bootstrap/*.sql` run once by a DBA/superuser (passwords from env). Migrations run as `lf_migrator`, which has no CREATEROLE.
- Why: Least privilege (design §6.7).
- Alternatives: create roles in migration 0001 (needs CREATEROLE).
- ADR: security ADR if the human wants one · Status: proposed (awaiting human)

### DL-0036 — lf_app privileges: no DELETE/TRUNCATE; audit log INSERT-only
- Date: 2026-10-24 · By: claude · Task: T-0008 · Category: security
- Decision: `lf_app` gets SELECT/INSERT/UPDATE on tenant tables and INSERT only on `audit.audit_log`; statement-level triggers block UPDATE/DELETE/TRUNCATE on the audit log even for its owner.
- Why: Directive 6 (no delete); TRUNCATE bypasses RLS; design §6.8.
- Alternatives: soft-delete with DELETE grant (rejected).
- ADR: none · Status: proposed (awaiting human)

### DL-0037 — Single global migration sequence with stricter policy
- Date: 2026-10-24 · By: claude · Task: T-0008 · Category: architecture
- Decision: All migrations live in `packages/db/migrations` (NNNN, gapless, checksummed); module manifests declare tables but SQL lives in the global sequence (packages/modules/AGENTS.md updated). Runner rejects DROP (except DROP DEFAULT/NOT NULL), RENAME, TRUNCATE, DELETE, ALTER COLUMN TYPE, DISABLE TRIGGER/RLS, NO FORCE RLS, BYPASSRLS.
- Why: Cross-package FKs need one deterministic order; enforces DL-0004 mechanically.
- Alternatives: per-package migration dirs (ordering conflicts).
- ADR: ADR-0014 · Status: accepted

### DL-0038 — Test DB harness modes (implements DL-0007)
- Date: 2026-10-24 · By: claude · Task: T-0008 · Category: tooling
- Decision: Harness order: `LF_TEST_DATABASE_URL` (CI service) → Testcontainers → local initdb cluster as a non-root OS user; one database per test file.
- Why: RQ-0008; initdb refuses root.
- Alternatives: PGlite/pg-mem (rejected in RQ-0008).
- ADR: ADR-0013 · Status: accepted

### DL-0039 — One indigo accent, fixed status palette, designed light and dark themes
- Date: 2026-10-24 · By: claude · Task: T-0009 · Category: ui
- Decision: Brand accent indigo (#4f46e5 light / #8b93f8 dark); four semantic colours; fixed palette for ten document statuses (Draft…Locked), always icon + word + colour; dark theme designed separately, not inverted.
- Why: Distinct from Salesforce blue and status colours; WCAG 1.4.1/1.4.3/1.4.11 — 90 contrast pairs verified by `Docs/ui/tools/contrast.mjs` (RQ-0080 §1).
- Alternatives: Salesforce-blue accent (looks like a Salesforce page; ambiguous with status blue); colour-only status dots (fails WCAG 1.4.1).
- ADR: none · Status: proposed (awaiting human) · Superseded by DL-0051

### DL-0040 — Money display convention
- Date: 2026-10-24 · By: claude · Task: T-0009 · Category: ui
- Decision: Right-aligned tabular figures, two decimals, currency once per column, negatives in parentheses (read as "minus" to screen readers), debit/credit as separate positive columns.
- Why: Scannable, matches accountant expectations (RQ-0080 §2).
- Alternatives: red negatives (colour alone); leading minus everywhere (kept for editable inputs only).
- ADR: none · Status: accepted

### DL-0041 — "Show journal" preview on every postable action
- Date: 2026-10-24 · By: claude · Task: T-0009 · Category: ui
- Decision: Every posting action offers "Show journal" via posting-engine preview mode (§3.9), open by default on review screens with a Balanced indicator. Void is labelled "Void — creates reversal journal"; Delete is shown unavailable with the reason.
- Why: Business Central's Preview Posting pattern (RQ-0080 §3); makes D2 (posted = immutable) understandable.
- Alternatives: preview only in a separate report (too far from the decision).
- ADR: none · Status: accepted

### DL-0042 — Two density modes
- Date: 2026-10-24 · By: claude · Task: T-0009 · Category: ui
- Decision: Comfortable (44px rows, 14px) default; Compact (32px, 13px) per-user. Only spacing tokens change.
- Why: Owners need readability, bookkeepers throughput (RQ-0080 §4).
- Alternatives: three modes (more test surface, little gain).
- ADR: none · Status: accepted

### DL-0043 — Controls and sync always visible in the shell
- Date: 2026-10-24 · By: claude · Task: T-0009 · Category: ui
- Decision: Top bar always shows posting period + state and Salesforce sync health; synced records show sync state; SoD, thresholds, lock dates and cooling-off appear as sentences before the action; two-person actions show the named chain.
- Why: §5.6, §6.5 ("weakened visibly, never silently").
- Alternatives: errors after submit (rejected).
- ADR: none · Status: proposed (awaiting human)

### DL-0044 — Salesforce LWC uses SLDS styling, not LedgerForce tokens
- Date: 2026-10-24 · By: claude · Task: T-0009 · Category: ui
- Decision: The UC-12 component uses only Salesforce base Lightning components / SLDS and inherits the org theme.
- Why: Must feel native inside Lightning (RQ-0080 §5).
- Alternatives: LedgerForce tokens inside Salesforce (looks foreign).
- ADR: none · Status: accepted

### DL-0045 — Mockups are dependency-free static HTML with scripted checks
- Date: 2026-10-24 · By: claude · Task: T-0009 · Category: tooling
- Decision: Shared `shell.css`/`shell.js`; `Docs/ui/tools/screenshot-mockups.mjs` serves over loopback with the global Playwright, checks one h1/title/main/lang, no console errors, no external requests, no horizontal scroll at 390px, rendered contrast, and axe-core when `AXE_PATH` is set. `@axe-core/playwright` will be added as an apps/web dev dependency with the web shell task.
- Why: Deterministic screenshots with no install; HTTP avoids axe errors on file://.
- Alternatives: generated static site; axe-core as a repo dependency now (deferred to apps/web).
- ADR: none · Status: accepted

### DL-0046 — Failover keeps work in the tree and snapshots it to a wip/ ref
- Date: 2026-10-24 · By: claude · Task: T-0003 · Category: process
- Decision: On provider failure the conductor snapshots uncommitted work to `refs/heads/wip/<T-ID>-<ts>` via a temporary index (commit-tree + update-ref) and leaves working tree, index and HEAD untouched for the next provider. No reset, no stash.
- Why: Directive 6 (never lose or delete); design §10.4 "same branch from last_checkpoint".
- Alternatives: `git stash` (drops untracked files, easy to lose); reset to last_checkpoint (destructive).
- ADR: ADR-0011 · Status: accepted

### DL-0047 — Conductor commits on behalf of Codex
- Date: 2026-10-24 · By: claude · Task: T-0003 · Category: process
- Decision: Providers with `workspace-write` default to `commits: conductor`: they run with `LF_DEFER_COMMIT=1`, `checkpoint` queues steps in `state.pending_checkpoints`, and the conductor commits them on each poll, at exit and at session end.
- Why: RQ-0001 — `.git` is protected in Codex workspace-write.
- Alternatives: `--dangerously-bypass-approvals-and-sandbox` (only in an external sandbox).
- ADR: ADR-0011 · Status: accepted

### DL-0048 — Quota failures switch provider without counting as attempts
- Date: 2026-10-24 · By: claude · Task: T-0003 · Category: process
- Decision: Quota/credit/limit/budget failures mark the provider exhausted for `quota_cooldown_minutes` (default 60) and fail over; other failures increment `state.failures` and rotate; at `max_attempts_per_task` the task is blocked with a notification in `.agent/notifications/`.
- Why: AGENTS.md §3; running out of credit is not a failure of the task.
- Alternatives: count every switch (blocks tasks for billing reasons).
- ADR: none · Status: accepted

### DL-0049 — verify.sh treats unavailable gates as PENDING, never pass
- Date: 2026-10-24 · By: claude · Task: T-0003 · Category: process
- Decision: Missing tooling prints "NOT YET AVAILABLE" and counts PENDING (loud, non-failing). Secrets scan and backlog lint also run in `--quick`; the no-skip check scans whole test files.
- Why: Directive 3 and `Docs/process/definition-of-done.md`.
- Alternatives: silent skip (hides gaps); fail on PENDING (blocks Sprint 0).
- ADR: none · Status: accepted

### DL-0050 — Minimal in-repo YAML subset reader
- Date: 2026-10-24 · By: claude · Task: T-0003 · Category: tooling
- Decision: `scripts/agent/lib/yaml.ts` parses the subset used; frontmatter edits replace lines in place to keep comments.
- Why: DL-0005 zero dependencies.
- Alternatives: `yaml`/`js-yaml` (need install).
- ADR: none · Status: accepted

### DL-0051 — UI v2 "Columnar": visual identity from accounting's own conventions
- Date: 2026-10-24 · By: claude · Task: T-0009 · Category: ui
- Decision: Supersede the v0.1 look (DL-0039 accent/palette; mockups kept in `Docs/ui/mockups` for history). New identity in `Docs/ui/v2/`: ruled sheet with red margin line, binder index tabs (no sidebar), ink palette (green-black, red, green, blue-black, amber), rubber-stamp statuses, single/double total rules, T-rule journal previews, signature lines for two-person controls, printed-form boxes, statement strip, tally progress, hatched overdue. IBM Plex Sans / Condensed / Mono bundled locally (OFL). Rounded cards, shadows, pills, icon sidebars and indigo are banned (`Docs/ui/v2/visual-identity.md`).
- Why: Product owner: v0.1 "looks vibe coded … make it look actually unique". Every device is an accounting convention, so it carries meaning (principles P2, P3, P4, P7 unchanged).
- Alternatives: restyle v0.1 with a new accent (rejected: same template skeleton); serif "old ledger" pastiche (rejected: costume, poor density).
- ADR: none · Status: proposed (awaiting human) · Supersedes DL-0039 · Superseded by DL-0052

### DL-0052 — UI v2 "Columnar" rejected; visual design handed to a research-led UI/UX agent
- Date: 2026-10-24 · By: human (product owner) · Task: T-0009 · Category: ui
- Decision: The v2 direction (DL-0051) is rejected as "another generic type". Its files stay in `Docs/ui/v2/` as history (no-delete). The visual design is reassigned to a dedicated UI/UX research agent that must ground the direction in user, competitor and pattern research, show several distinct directions, and recommend one, before any screens are ported.
- Why: The product owner wants a design that comes out of real UI/UX research, not the lead's taste.
- Alternatives: iterate v2 (rejected by the product owner).
- ADR: none · Status: accepted · Supersedes DL-0051

### DL-0053 — Provisional dependency satisfaction by `review` while no cross-review provider runs here
- Date: 2026-10-24 · By: claude · Task: T-0003 · Category: process
- Decision: This cloud container has no `codex` CLI and no OpenAI key, so cross-provider review cannot run. A task whose full `verify.sh` is green moves to `review` (awaiting codex). `.agent/config.yaml → dependency_satisfied_by: [done, review]` lets dependants start on it; `review` cards are never offered to builders (`next` excludes them). Set back to `[done]` when codex is available; a review FAIL reopens the card and its dependants are re-verified.
- Why: Blocking 93 cards on an unavailable reviewer stalls the build; building on verify-green work with an explicit review queue keeps every gate honest and the debt visible (status counts in `.agent/backlog/README.md`).
- Alternatives: self-review by claude (rejected: AGENTS.md forbids, conductor refuses); mark done without review (rejected: shortcut); wait (rejected: stall).
- ADR: ADR-0011 addendum · Status: proposed (awaiting human)

### DL-0054 — Coverage gate enabled with @vitest/coverage-v8 and a committed baseline
- Date: 2026-10-24 · By: claude · Task: T-0001 · Category: tooling
- Decision: Dev dependency `@vitest/coverage-v8@4.1.12` (matches vitest); baseline `.agent/coverage-baseline.json` = lines 72.22%, branches 69.37%. Gate 2c compares against the baseline on main.
- Why: Definition of done §10.8 item 2 "coverage does not drop".
- Alternatives: istanbul provider (slower, no benefit).
- ADR: none · Status: accepted

### DL-0055 — In this cloud session, task work lands on the session branch
- Date: 2026-10-24 · By: claude · Task: sprint-0 · Category: process
- Decision: The cloud harness permits pushing only to `claude/app-framework-agents-dzmkya`, so tasks are built sequentially on that branch with Conventional Commits tagged `[T-NNNN]` and `wip(T-NNNN)` checkpoints, instead of one `feat/T-NNNN-*` branch per task (AGENTS.md §2). The conductor's per-task branches apply when it runs headless elsewhere.
- Why: Environment constraint; commit tags keep per-task history separable.
- Alternatives: local-only task branches (rejected: unpushed work is lost when the container is reclaimed).
- ADR: none · Status: accepted

### DL-0056 — Durable continuation prompts and explanatory commits
- Date: 2026-10-24 · By: codex · Task: T-0010 · Category: process
- Decision: Add the owner's requested primary continuation prompt to AGENTS.md section 2. Each commit explains What changed, Why, Validation and Next action; HANDOVER starts with a current Codex continuation prompt.
- Why: Checkout 2fe5073 has a stale Sprint 0 handover and lacks the later recorder/gate changes described in the interrupted chat. Repository memory must distinguish committed code from narrative claims.
- Alternatives: rely on conversation history (rejected by directive 1).
- ADR: none · Status: accepted

### DL-0057 — Explicit workflow phase markers remove the verification cycle
- Date: 2026-10-24 · By: codex · Task: T-0010 · Category: process
- Decision: A step ending in [phase: verify], [phase: review] or [phase: finish] can remain open while that phase or a prior phase is running. In review, verify must be complete. At done all steps must be complete. Unmarked implementation steps and unknown markers always remain mandatory.
- Why: Gate 12 previously required verification and subsequent cross-review to be complete before verification could pass. Five regression tests cover the cycle and rejection cases; two failed for the expected reason before implementation, all five passed after.
- Alternatives: infer phase from prose or ignore every step following verify (rejected: can conceal unfinished implementation).
- ADR: none · Status: accepted

### DL-0058 — Windows checkout and evidence path portability
- Date: 2026-10-24 · By: codex · Task: T-0010 · Category: tooling
- Decision: Keep text source LF via .gitattributes; render evidence file paths with forward slashes on all platforms, as the existing tests require. Use Git Bash and workspace-local Corepack shims for the existing verifier. Run the DB suite against isolated PostgreSQL 17 on localhost:55432 using the existing external-server harness.
- Why: CRLF checkout broke Bash and format checks; two unmodified evidence assertions failed on backslashes. Windows Docker pipe access requires escalation and the harness auto-probe assumes a Unix socket.
- Alternatives: weaken assertions, skip DB tests or change dependency versions (rejected). No runtime dependency added.
- ADR: none · Status: accepted

### DL-0059 — Windows provider tree cleanup and portable run-log links
- Date: 2026-10-24 · By: codex · Task: T-0010, T-0003 · Category: tooling
- Decision: Use taskkill.exe with the exact spawned provider PID, /T and /F on Windows when a heartbeat expires; retain POSIX group signalling elsewhere. Suppress late termination after close. Normalize run-log reference paths to forward slashes.
- Why: The unchanged failover suite passed 78/80 tests; missed-heartbeat timed out because shell children held pipes, and notification link matching failed on backslashes. RQ-0014 documents Microsoft's process-tree termination semantics.
- Alternatives: increase timeout or weaken link assertions (rejected); kill by image name (rejected: unrelated processes).
- ADR: none · Status: accepted

### DL-0060 — Start provider heartbeat allowance at launch
- Date: 2026-10-24 · By: codex · Task: T-0010, T-0003 · Category: process
- Decision: Refresh the same owner's lease immediately before provider launch, after resume-prompt construction; refuse launch if task/provider/lease ownership changed. Keep the configured duration and heartbeat test deadline unchanged. Use Git's usr/bin/bash.exe directly on Windows, avoiding its bin launcher.
- Why: The 3-second heartbeat fixture showed the next provider losing its lease during prompt construction, before it could checkpoint. Windows launcher process IDs can disappear while descendant pipes remain open.
- Alternatives: lengthen test timeout or heartbeat fixture lease (rejected: conceals behavior); self-approve verification (rejected).
- ADR: none · Status: accepted

### DL-0061 — apps/api is compiled with SWC; tested with Vitest + unplugin-swc
- Date: 2026-10-24 · By: claude · Task: T-0104 · Category: tooling
- Decision: NestJS needs decorators and emitDecoratorMetadata, which Node type stripping cannot run (proved locally). apps/api alone is built with SWC and tested through Vitest with `unplugin-swc`; every other package keeps running TypeScript directly (DL-0034). Pin @nestjs/* 12.0.4 and other new deps to releases at least 14 days old.
- Why: RQ-0015 (finding 3, NestJS SWC recipe). The alternative of dropping NestJS would contradict design §7.1 / ADR-0002.
- Alternatives: tsc build + tests on compiled JS (kept as fallback); Fastify without Nest (rejected: changes the design); NestJS without decorators (impractical).
- ADR: ADR-0002 (stack) · Status: accepted

### DL-0062 — Keycloak bundled; oidc-provider as in-process test IdP; T-0104 split from T-0011
- Date: 2026-10-24 · By: claude · Task: T-0011 · Category: security
- Decision: Self-host bundles Keycloak (Apache-2.0); tokens are validated through generic OIDC discovery so hosted tenants can use any compliant IdP. Tests use panva `oidc-provider` in-process (no Docker or JVM). The API skeleton becomes T-0104, a dependency of T-0011.
- Why: RQ-0015: Zitadel is AGPL-3.0, and the LedgerForce licence is still open (ADR-0009). Card size limit (one session).
- Alternatives: Zitadel (licence coupling); mock JWTs without a real provider (rejected: misses discovery, PKCE and signature validation).
- ADR: ADR-0016 (to be written in T-0011, security, human gate) · Status: proposed (awaiting human)

### DL-0063 — Security patches override the 14-day version-age rule (multer 2.5.0)
- Date: 2026-10-24 · By: claude · Task: T-0104 · Category: security
- Decision: Root `pnpm.overrides` pins `multer` to 2.5.0 (released 2026-10-22), which patches GHSA-q7qp-rjg7-q26m (high, DoS via a pending async fileFilter). `@nestjs/platform-express` 12.1.2–12.2.0 all depend on vulnerable `multer` 2.4.0. Remove the override once a NestJS release depends on ≥ 2.5.0. Also records: NestJS pinned to 12.1.2, not 12.0.4 as DL-0061 said, so that `@nestjs/testing` matches.
- Why: verify gate 7 (pnpm audit --prod) failed on T-0104. A same-maintainer security patch carries less risk than a known high-severity vulnerability. The 14-day rule (DL-0061) exists to reduce supply-chain risk, not to keep known vulnerabilities.
- Alternatives: accept the risk because no upload route exists yet (rejected: the gate must stay green, and file uploads arrive with bill capture UC-05); wait for NestJS (rejected: open-ended).
- ADR: none · Status: accepted

### DL-0064 — UI research: direction C "Timeline" proposed, with A's queue for list screens
- Date: 2026-10-24 · By: claude · Task: T-0009 · Category: ui
- Decision: Propose C as the UI direction: one shared date axis, each document as a life story, colour showing time state (solid happened, dashed expected, teal today). Reuse A's turn tokens, decision bar and keyboard queue for list screens, and B's flow diagram on documents for owners.
- Why: Best genericness score (1, lower is better), a distinct page outline, and the only direction serving INS-09 ("will I have enough on Tuesday?"); 17/22 on the insights (`Docs/ui/research/03-recommendation.md`).
- Alternatives: A Turns (18/22, but an app-shell outline close to v0.1 and queue-first for owners); B Flows (14/22, weak for operators).
- ADR: none · Status: accepted by the product owner 2026-10-24 ("Go with C Timeline") — see DL-0070

### DL-0065 — Genericness checklist G1–G13 and probes required for UI work
- Date: 2026-10-24 · By: claude · Task: T-0009 · Category: ui
- Decision: Score every new screen against G1–G13 (pass ≤ 4, no item at 2). Keep the automated probes (shadows, radius, all-caps tracking, middle dots, arrows, purple) and axe `wcag22aa`.
- Why: RQ-0084; the checklist explains both rejections (v0.1 = the market's common shell; v2 = second-wave defaults: hairlines, all caps, mono figures, paper costume).
- Alternatives: taste review only (rejected twice by the product owner).
- ADR: none · Status: proposed (awaiting human)

### DL-0066 — Proposed principle changes P3, P11, P12 and new P13–P15
- Date: 2026-10-24 · By: claude · Task: T-0009 · Category: ui
- Decision: Density default by role; money direction in words for owners; a plain gloss beside accounting terms; new P13 "Whose turn is it?", P14 "Stability", P15 "Expected is never shown as actual".
- Why: INS-01, 04, 05, 07, 09 (`Docs/ui/research/01-research-report.md`).
- Alternatives: keep principles v0.1.
- ADR: none · Status: proposed (awaiting human)

### DL-0067 — Typefaces chosen by measured tabular figures; OFL fonts bundled
- Date: 2026-10-24 · By: claude · Task: T-0009 · Category: tooling
- Decision: Run `Docs/ui/research/tools/fonttest.mjs` before adopting any face for money. Exclude Lexend, Libre Franklin and B612 for amounts (no working tabular figures, or brackets set wrongly). Bundle woff2 files plus the OFL licence. Use axe-core from a scratch `npm pack`, not as a dependency.
- Why: RQ-0085, experiment E1 (19 faces measured).
- Alternatives: choose by appearance.
- ADR: none · Status: proposed (awaiting human)

### DL-0068 — Sessions designed per ADR-0016; T-0105 split from T-0011
- Date: 2026-10-24 · By: claude · Task: T-0105 · Category: security
- Decision: Server-side, tenant-scoped sessions (`app.session`, RLS) with cookie `<tenant_id>.<session_id>.<secret>` verified under that tenant's RLS; 30-min idle and 12-h absolute for every session until roles exist; revoke-all via `app_user.session_epoch`; tenant-specific login URL resolved by a SECURITY DEFINER slug function. New card T-0105 (sessions) sits before T-0011 (OIDC login).
- Why: Design §6.2/§6.7. Avoids any cross-tenant table on the request path, and revocation is immediate. Card-size rule.
- Alternatives: stateless JWT cookie; global session table; hostname tenancy (all in ADR-0016).
- ADR: ADR-0016 · Status: proposed (awaiting human — security)

### DL-0069 — Conductor writes shared files atomically (temp + rename)
- Date: 2026-10-24 · By: claude · Task: T-0003 (found in T-0105 verify) · Category: tooling
- Decision: Task cards, state.json and HANDOVER.md are written through `writeFileAtomic` (sibling temp file, then rename). New writers of files that another process may read must use it.
- Why: Root cause of the intermittent conductor failure: the running conductor rewrote a card while the agent's `conductor release` read it, saw an empty file ("missing frontmatter"), exited 8, and the provider was relaunched. Probe: 75,969 of 79,072 concurrent reads were partial with the old write; 0 after. Failover repro: race at iteration 16 before, 0 in 240 runs after (half under load).
- Alternatives: file locks (heavier, platform-specific); retry-on-parse-error in readers (hides the bug).
- ADR: none · Status: accepted

### DL-0070 — Product owner chose UI direction C "Timeline"; principles v1 and design system adopted
- Date: 2026-10-24 · By: human (product owner) · Task: T-0009 · Category: ui
- Decision: Build the UI in direction C "Timeline" (DL-0064), reusing Direction A's turn queue for list-heavy screens and B's flow component for the owner view of documents. As part of the same recommendation: principles v1 (P3, P11, P12 revised; new P13 whose turn, P14 stability, P15 expected ≠ actual; DL-0066) are applied to `Docs/ui/principles.md`; the genericness checklist G1–G13 (DL-0065) and the font test (DL-0067) are mandatory for UI work. The prototype is promoted (copied) to `Docs/ui/system/` as the canonical design system. New card T-0106 (Timeline component package + the fixes owed before build) now precedes the web shell T-0081, and every UI card carries the direction note. The design's shadcn/ui is used only as accessible primitives restyled with Timeline tokens.
- Why: Product owner's answer to the human gate, after the research-led comparison (`Docs/ui/research/03-recommendation.md`).
- Alternatives: A Turns, B Flows (`Docs/ui/research/02-directions.md`).
- ADR: none · Status: accepted

### DL-0071 — Chart of accounts data model: role rules enforced in the database
- Date: 2026-10-24 · By: claude · Task: T-0018 · Category: data-model
- Decision: Migration `0005_gl_chart_of_accounts.sql` adds `app.account` (design §3.2 fields; codes are 3–10 digits; never deleted, `status` archives) and `app.account_system_role` (one row per company and role; re-bind by UPDATE, never unbound). The role→account-type rule is the IMMUTABLE function `app.system_role_allows(role, type)`, not a global lookup table, so no table without tenant_id is added (a global table would need a security ADR). Triggers on both tables refuse a bound account that is archived, non-postable (except CURRENT_YEAR_EARNINGS, which must be non-postable), of a disallowed type, or whose `is_control` differs from "role is AR_CONTROL / AP_CONTROL / PAYROLL_CLEARING"; the binding trigger takes FOR SHARE on the account so concurrent changes serialise. `packages/modules/gl/src/system-roles.ts` mirrors the function, and SS-PLAT-31 proves they agree for every role × type. The template validator and loader live in the new package `@ledgerforce/gl`. The cross-tenant generator got column overrides for the two tables.
- Why: Design §3.2 ("system roles … cannot be removed while bound"; control accounts). Putting the rule in the database means no code path, including future modules, can break a role binding.
- Alternatives: application-only checks (bypassable by any other writer); a global `system_role_type` table (cross-tenant table, security ADR).
- ADR: none · Status: accepted

### DL-0072 — AU services SMB template contents and role→type map are drafts for accountant review
- Date: 2026-10-24 · By: claude · Task: T-0018 · Category: accounting
- Decision: Ship `packages/modules/gl/templates/au-services-smb.json` (43 accounts) with the role→type map: AR_CONTROL, UNDEPOSITED_FUNDS, GST_PAID → asset; AP_CONTROL, GST_COLLECTED, PAYROLL_CLEARING, WAGES_PAYABLE, PAYG_WITHHOLDING, SUPER_PAYABLE, DEFERRED_REVENUE, CUSTOMER_PREPAYMENTS → liability; RETAINED_EARNINGS, CURRENT_YEAR_EARNINGS → equity; ROUNDING, FX_REALISED, FX_UNREALISED → expense or revenue; SUSPENSE → asset or liability. Stripe clearing (1210), merchant fees (6120) and bad debts (6500) are `suggestedSettings`, not roles (DL-0015). Default tax codes (GST, INP, N-T) are keys for the future tax module, not yet enforced.
- Why: Design §3.2 lists the roles but not their types or the template's accounts. Nothing posts yet, so the template can be corrected by a new version without touching posted history.
- Alternatives: wait for the accountant before building the chart (blocks every downstream task).
- ADR: none · Status: proposed (awaiting human — accountant review of the template; not a gate for T-0018)

### DL-0073 — Dimensions and dimension sets: canonical form owned by the database; set writer in packages/ledger
- Date: 2026-10-24 · By: claude · Task: T-0019 · Category: data-model
- Decision: Migration `0006_gl_dimensions.sql` adds `app.dimension`, `app.dimension_value` (per company, archive-only) and `app.dimension_set` (INSERT/SELECT only for lf_app). A BEFORE INSERT trigger is the only author of a set's canonical form. It validates values (same tenant and company, active, one per dimension), sorts pairs by dimension id, sets `hash = sha256('<dim>=<value>;…')`, and copies the primary-slot values into indexed columns. Dedup is `INSERT … ON CONFLICT (tenant_id, company_id, hash) DO NOTHING` (BEFORE ROW triggers run before the conflict check). The empty combination is an ordinary set, so set ids are never NULL. A dimension's code, company and primary slot are immutable. `account.required_dimensions` must name active dimensions of the company. `app.dimension_set_missing_required(account, set)` answers the posting engine's "required dimensions present" check (design §3.9 validate). Because `dimension_set` is a ledger table (packages/ledger/AGENTS.md; lint rule `lf/no-direct-ledger-write`), its writer `dimensionSetId()` lives in the new package `@ledgerforce/ledger`. Dimension master data stays in `@ledgerforce/gl`.
- Why: Design §2 (unlimited dimensions, 2 primary indexed) and §3.3 (deduplicated sets like Business Central). Computing the hash in the database means no caller can store a non-canonical or forged set. Changing which dimensions are primary later needs a migrator backfill (new task when asked).
- Alternatives: hash computed in TypeScript (two implementations, forgeable by any writer); a set-entry child table (needs a deferred check to verify the hash; arrays + GIN index answer "sets containing value X"); NULL for "no dimensions" (NULLs in balance keys).
- ADR: none · Status: accepted

### DL-0074 — Journal tables: deferred balance trigger; >4-decimal amounts refused by the engine, not the column; harness support for commit-time invariants
- Date: 2026-10-24 · By: claude · Task: T-0020 · Category: data-model
- Decision: Migration `0007_ledger_journal.sql` adds `app.journal_entry` and `app.journal_line` per design §3.3 (lf_app SELECT/INSERT only). Columns whose targets don't exist yet (period_id, tax_code_id, party_id) are plain uuid until their owning tasks add the foreign keys. Every line has exactly one side > 0, and its account and dimension set must be in the entry's company. `DEFERRABLE INITIALLY DEFERRED` constraint triggers on both tables check at commit that each touched entry has at least two lines and Σdebit = Σcredit exactly; otherwise the transaction aborts. This applies to every status, so the ledger never holds an unbalanced row. Drafts that may be unbalanced belong in document tables, not the journal. Amounts stay `numeric(19,4)` (ADR-0005). PostgreSQL rounds a 5th decimal on input before any CHECK or trigger runs, so refusing more than 4 decimals is a posting-engine boundary rule (added to T-0025). Cross-tenant harness: a composite-FK child now passes its chosen values (e.g. company_id) to the parents it seeds; a foreign key is seeded only when all its columns will be non-null (MATCH SIMPLE); tables in `COMMIT_WITH_COMPANIONS` are seeded by the superuser under `session_replication_role = replica`, and their INSERT positive control is checked in-transaction then rolled back. Mutation-checked: with a permissive WITH CHECK on journal_line, the suite fails.
- Why: Design §3.3 invariant 1, ADR-0004 rule 3. A generic row generator cannot build a balanced pair, and the invariant must not be weakened for the harness.
- Alternatives: a domain `app.amount` (numeric with CHECK scale ≤ 4) so the database refuses rather than rounds. Safer, but it changes ADR-0005's column type (accounting gate), so it is proposed to the human (HANDOVER) rather than taken. Exempting journal tables from the cross-tenant suite was rejected (it would leave the most sensitive tables uncovered).
- ADR: ADR-0004, ADR-0005 (both Proposed) · Status: accepted for the schema; the domain-type alternative is proposed (awaiting human)

### DL-0075 — Ledger immutability: privileges + owner-binding triggers; posted → reversed only via a mirror-checking SECURITY DEFINER function
- Date: 2026-10-24 · By: claude · Task: T-0021 · Category: security
- Decision: Migration `0008_ledger_immutability.sql`. lf_app keeps SELECT/INSERT only on journal_entry, journal_line and dimension_set, so it cannot UPDATE, DELETE, TRUNCATE, DISABLE TRIGGER (not owner) or set session_replication_role. Triggers that bind even the owner lf_migrator refuse UPDATE or DELETE of a posted or reversed entry and its lines, and of any dimension set, and refuse TRUNCATE of all three tables. Draft entries stay owner-editable (no lf_app path; the engine posts directly). ADR-0004 rule 1's single exception, posted → reversed with every other column unchanged, is allowed by the trigger only when a posted reversal referencing the entry exists. lf_app reaches it only through `app.journal_mark_reversed(entry, reversal)`: SECURITY DEFINER, owned by lf_migrator, `search_path = pg_catalog, pg_temp`, EXECUTE revoked from PUBLIC and granted to lf_app. The function runs under FORCE RLS, so it only sees the caller's tenant, and it requires the reversal's lines to mirror the original exactly (account, dimension set, party, tax code, currency, txn amount, rate; debit and credit swapped). tax_amount is not compared until the tax engine (T-0034) defines its sign convention. A superuser can still disable triggers; the hash chain (T-0022) makes that evident.
- Why: Design §3.3 invariant 2; ADR-0004 rules 1–2 (it left the exact reversal transition to be specified by the ledger work). Checking the mirror in the database means a "reversal" that does not undo the original cannot mark it reversed.
- Alternatives: grant lf_app UPDATE(status) with a trigger (a broader privilege than one function); no trigger layer (the owner could edit posted rows silently).
- ADR: ADR-0004 (Proposed) · Status: accepted (security-relevant, flagged for the human in HANDOVER together with ADR-0004)

### DL-0076 — Hash chain built to ADR-0017: database computes at commit under a head lock; independent TypeScript verifier
- Date: 2026-10-24 · By: claude · Task: T-0022 · Category: accounting
- Decision: Migration `0009_ledger_hash_chain.sql` adds `journal_entry.chain_seq` and `app.journal_chain_head` (lf_app SELECT only), `app.ns()`, `app.journal_canonical_v1()` (canonical form v1 per RQ-0016), and a deferred constraint trigger that runs `app.journal_chain_append()` (SECURITY DEFINER, search_path pinned, EXECUTE revoked from PUBLIC) for each posted entry at commit. Further guards refuse client-supplied chain fields and lines added to a chained entry. The 0008 immutability function is replaced via CREATE OR REPLACE to permit the one-time NULL → value chain write, with everything else unchanged. `packages/ledger/src/hash-chain.ts` holds `canonicalV1` / `verifyChain`, written from the RQ-0016 text without calling the SQL function. Reasons: unchained, sequence_gap, prev_hash_mismatch, hash_mismatch, head_mismatch. `chainSeq` is reported as a decimal string (no Number() in money paths). Pinned reference test: a hand-derived v1 string must stay byte-identical.
- Why: Design §3.3 invariant 4 and §6.8; ADR-0004 rule 5; ADR-0017. Found during build: `ORDER BY chain_seq` bound to the text output column ("10" < "2") — fixed by ordering on `e.chain_seq`; the 100-entry test caught it.
- Alternatives: application-computed hash (ADR-0017 option 3); a verifier that calls the SQL canonical function (not independent).
- ADR: ADR-0017 (Proposed, accounting) · Status: accepted for the build; the canonical form awaits the human with ADR-0017

### DL-0077 — Correction: register rows set back from `evidenced` to `green` until cross-review passes
- Date: 2026-10-24 · By: claude · Task: register hygiene (found while claiming T-0024) · Category: process
- Decision: The register's rule is that a row may only be `evidenced` if its task's cross-provider review passed. 14 rows (SS-PLAT-01, 02, 03, 04, 08, 13, 19, 28, 30, 31, 32, 33, 34, UI-01) had been marked `evidenced` while their tasks were still in `review`. They are now `green`, keeping their evidence links and last-verified commits. Commit bodies and the HANDOVER that said "evidenced" meant "evidence recorded", not the register status. From now on, the reviewer (Codex) flips a task's rows to `evidenced` when its review passes; the HANDOVER continuation prompt says so.
- Why: The register must not overstate verification (AGENTS.md directive 3).
- Alternatives: leave as is (contradicts the register's own rule).
- ADR: none · Status: accepted

### DL-0078 — Gapless numbering: counter row advanced in the posting transaction; guarded; never truncating
- Date: 2026-10-24 · By: claude · Task: T-0024 · Category: data-model
- Decision: Migration `0010_ledger_number_series.sql` adds `app.number_series` (per company and code; prefix, pad_width, next_value; RLS; lf_app SELECT/INSERT/UPDATE) and `app.next_document_number(company, series)`. That function uses UPDATE … RETURNING inside the caller's transaction, so the row lock serialises writers and a rollback returns the number. A guard trigger allows next_value to move only by +1, and keeps code and company immutable and prefix and pad_width fixed once a number is issued. Tenant moves are left to RLS. The formatter pads but never truncates; plain `lpad` truncates a wider value, and a mutation test proves the guard against it. SS-UC02-06 is proven at the numbering layer in the batch's shape (40 documents, one failing at commit). The invoice batch itself stays with T-0044.
- Why: Design §3.4 ("sequences leave gaps; tax invoices need clean series"); RQ-0007 (d).
- Alternatives: database sequences (gaps on rollback); allocate-then-void numbers (gaps by design); SELECT … then UPDATE (races, killed by the concurrency test as a mutant).
- ADR: none · Status: accepted

### DL-0079 — Party model: company-scoped; identifiers validated per RQ-0017; contact roles tied to party roles
- Date: 2026-10-24 · By: claude · Task: T-0036 · Category: data-model
- Decision:
  - Migration `0011_parties_party_model.sql` adds app.party, party_role, party_address, party_contact and party_contact_role (RLS; lf_app SELECT/INSERT/UPDATE; nothing deleted).
  - A party is scoped to a company, not the tenant. Currency, payment terms, credit limit and posting profile are per company (design §4.2), and MVP has one company per tenant (§3.1). Sharing parties across companies is a Phase 2 intercompany question.
  - ABN: app.abn_is_valid (the ABR mod-89 rule) as a CHECK, with a TypeScript twin, proven to agree by fast-check on random and generated-valid ABNs.
  - Peppol delivery needs an ABN; the participant ID 0151:<ABN> is derived, not stored.
  - Salesforce Ids are stored 18-char only and are unique per company.
  - Contact roles: remittance needs an active supplier role; billing_to, billing_cc, statements and ap_contact need an active customer role. Design §4.2 marks remittance "(suppliers)" and Billing To as required for customers. Treating CC, Statements and AP contact as customer-side is an inference from the AR context they serve.
  - The Billing To rule is a helper, `invoiceApprovalBlockers` and `billingRecipients`, which T-0040 and T-0044 call.
  - Out of scope here: bank details (T-0053, verification workflow), posting profile (T-0038), payment terms (T-0039).
  - Follow-up card T-0107: company ABN checksum and the T-0018 fixture ABN that fails it.
- Why: Design §4.2; RQ-0017.
- Alternatives: tenant-scoped parties (would need per-company settings tables now, for no MVP benefit); storing both 15- and 18-char Ids (duplicate risk).
- ADR: none · Status: accepted

### DL-0080 — Bank details: envelope-encrypted account number, masked reads, one decrypt path; built to ADR-0018
- Date: 2026-10-24 · By: claude · Task: T-0037 · Category: security
- Decision:
  - `@ledgerforce/shared/crypto`: a `Kms` interface plus `LocalKeyringKms` (key file / Docker secret; rotation by adding a key and switching `active`), and `sealField`/`openField` (per-field DEK, AES-256-GCM, random 96-bit IV, record-bound AAD, fail-closed DecryptionError).
  - Migration `0012_parties_bank_accounts.sql`: `app.party_bank_account` keeps BSB, name and last 3 in clear; the account number as ciphertext/IV/tag/wrapped DEK/kek_id/version. lf_app may INSERT/SELECT and UPDATE(status) only. Source is ui|api|import (never Salesforce). A trigger requires an active supplier or employee role and skips rows of another tenant, so RLS refuses those with 42501.
  - Service: `addBankAccount`, `listBankAccounts` (masked "***" + last 3, length hidden), `revealAccountNumber` (only for ABA, T-0054).
  - API: `GET /parties/:partyId/bank-accounts` (masked; the API has no KMS, so it cannot decrypt).
  - Cross-tenant harness: a `PREREQUISITES` hook creates trigger-required rows (here a supplier role) as superuser, like FK parents.
  - Follow-up card T-0108 (OpenBao/Vault transit adapter).
- Why: Design §4.2, §6.1, §6.6; RQ-0018; ADR-0018.
- Alternatives: see ADR-0018 (Vault BUSL, OpenBao now, pgcrypto).
- ADR: ADR-0018 (Proposed, security) · Status: accepted for the build; awaiting the human with ADR-0018

### DL-0081 — Parallel build: independent tasks in separate worktrees, with pre-assigned numbers
- Date: 2026-10-24 · By: claude (on the product owner's instruction to use parallel sub-agents) · Task: T-0058, T-0011, T-0106, T-0062, T-0107 · Category: process
- Decision: Build the claimable tasks whose dependencies are met and whose code areas don't overlap in parallel: T-0058 (modules/bank), T-0011 (apps/api auth), T-0106 (packages/ui), T-0062 (salesforce/), each by a sub-agent in its own git worktree. The lead builds T-0107 in the main tree. To avoid collisions, each task gets a pre-assigned migration number, DL/RQ/SS/ADR id range (listed in HANDOVER). Sub-agents do not run conductor claim/release/set-status and do not edit HANDOVER.md, state.json or run logs; the lead does, at merge. Shared append-only files (decision log, register, backlog index, schema.ts, cross-tenant overrides, apps/api app.ts) are merged by the lead, followed by the full gates on the merged tree. Not in this round: T-0095 (CI security gates; AGENTS.md §5 forbids agents to edit CI security gates, so it needs the human) and T-0108 (Phase 1).
- Config: `.agent/config.yaml` parallel_tasks 1 → 5. The file marked it as design §11.2's open decision "whether parallel builds are allowed", and the product owner decided it with this instruction.
- Why: Product owner asked for parallel sub-agents. The global migration sequence and the shared registers are the only serialisation points, so pre-assignment removes them.
- Alternatives: sequential build (slower); parallel without pre-assignment (migration number and id collisions).
- ADR: none · Status: accepted

### DL-0082 — Bank statements: one normalised line for CSV/OFX/CAMT.053, own parsers, two-level duplicate detection
- Date: 2026-10-24 · By: claude · Task: T-0058 · Category: architecture
- Decision:
  - Every statement format normalises to `{ postedOn 'YYYY-MM-DD', amount Money (+ money in, − money out), description, reference | null, bankTxnId | null }` (the SS-UC08-01 contract). Field mapping per format as in RQ-0019 §Conclusion.
  - OFX posting date = the first 8 digits of `DTPOSTED`, as written in the bank's offset; never converted through UTC (avoids the one-day shift seen in other importers).
  - CAMT.053: only `BOOK` entries are imported; a batch entry stays one line (its booked amount).
  - Parsers are written in-house (`@ledgerforce/bank`): one tolerant tag tokenizer for OFX 1.x SGML, OFX 2.x XML and CAMT.053, and an RFC 4180 CSV reader with a column mapping. No runtime dependency, so no ADR.
  - Duplicates: (1) the file's SHA-256 is unique per bank account — a re-import creates nothing and reports `duplicate_file`; (2) each line has a `dedupe_key` unique per bank account — `id:<bankTxnId>` when given, else `h:` + SHA-256 of date | amount | description | occurrence number in the file — so overlapping statements add only new lines and the result reports how many were skipped.
- Why: Design §5.7, UC-08 flow 1 and A1; RQ-0019; AGENTS.md §0.5 (build it ourselves) and design §10.6 (runtime dependency needs an ADR).
- Alternatives: a third-party OFX/XML parser (runtime dependency + ADR, and OFX 1.x SGML support is uneven); file hash only (misses overlapping statements); line hash without occurrence number (drops a genuine second identical transaction on the same day); FITID-free hashing for all formats (loses the bank's own id where it exists).
- ADR: none · Status: accepted

### DL-0083 — Company bank accounts: own table bound to a bank GL account, number envelope-encrypted, payment details immutable
- Date: 2026-10-24 · By: claude · Task: T-0058 · Category: data-model
- Decision:
  - Migration `0013_bank_accounts_statements.sql` adds `app.bank_account` for the company's own accounts, separate from `app.party_bank_account` (supplier/employee details, T-0037).
  - Each is bound to one GL account; a trigger requires an active, postable, non-control asset of subtype `bank` whose currency (if set) equals the bank account's. One active bank account per GL account (partial unique index). The trigger skips rows of another tenant so RLS refuses them (42501), as in 0012.
  - The account number is envelope-encrypted exactly like party bank details (ADR-0018, AAD `lf-field-v1|tenant|company|company_bank_account|id|account_number`); BSB, account name and last 3 stay in clear; reads are masked; `revealCompanyBankAccountNumber` is the one decrypting call, for the ABA trace account (T-0054).
  - ABA descriptive-record fields (RQ-0006): `apca_user_id` (6 digits), `aba_user_name` (≤ 26 BECS characters), `aba_fi_mnemonic` (3 capitals), checked in the service and by CHECKs.
  - lf_app may UPDATE only `name`, `status`, `csv_mapping`; changed payment details are a new row (no in-place edits, nothing deleted).
- Why: Design §4.1 step 4 (BSB, account number, ABA user ID and APCA number), §6.6 ("envelope encryption for bank account numbers"), §3.2 (accounts by subtype); ADR-0018 already covers the mechanism, so no new ADR.
- Alternatives: reuse `party_bank_account` with a "company" party (mixes supplier SoD rules with the company's own accounts); keep the company number in clear (contradicts §6.6); bind by account code instead of id (codes can change).
- ADR: ADR-0018 (Proposed, security; mechanism reused) · Status: accepted for the build; awaiting the human with ADR-0018

### DL-0084 — Statement storage: imported data, not ledger rows; per-account CSV mapping stored as data
- Date: 2026-10-24 · By: claude · Task: T-0058 · Category: data-model
- Decision:
  - `app.bank_statement` (one row per imported file: format, SHA-256 unique per bank account, account ref, period, opening/closing balance, `lines_total`, status `imported|voided`) and `app.bank_statement_line` (`line_no` = position in file, `posted_on`, `amount numeric(19,4)` with + = money in, description, reference, bank id, `dedupe_key` unique per bank account, status `unmatched|matched|excluded` for T-0060). No journal table is touched; lf_app may UPDATE only `status`.
  - Lines found to be duplicates are not stored; the number skipped is `lines_total − count(lines)`, so no counter has to be updated after insert.
  - The statement's currency is tied to the bank account's by a composite foreign key.
  - The import is refused (nothing written) when the file's currency differs, when the file names another account (last 3 alphanumerics of OFX ACCTID / CAMT Acct/Id vs the stored last 3; the number is never decrypted for this), or when opening + lines ≠ closing.
  - The bank's CSV layout is a validated `CsvMapping` stored in `bank_account.csv_mapping` (jsonb) and used when no mapping is passed (configuration over code, design principle 3).
  - The import result has `outcome` `imported | duplicate_file | duplicate_lines`, counts, and a plain-language `message` (UC-08 A1 "the user is told").
- Why: UC-08 flow 1 and A1; design §5.7; RQ-0019; DL-0082.
- Alternatives: storing duplicate lines with a flag (rows nobody needs, and T-0060 would have to filter them); counters updated after insert (needs UPDATE grants on counts); CHECK lists added later (a new status would need a constraint change, which forward-only migrations cannot do in place, so T-0060's statuses are included now).
- ADR: none · Status: accepted

### DL-0085 — T-0058 build details: in-house parsers, byte-exact fixtures, one CAMT statement per file
- Date: 2026-10-24 · By: claude · Task: T-0058 · Category: tooling
- Decision:
  - `@ledgerforce/bank` parsers use no external library: a tolerant tag reader (SGML leaf rule: an element never closed anywhere ends at the next tag; no DTD or entity expansion beyond the XML five, `&nbsp;` and numeric references), an RFC 4180 CSV reader, and text → Money parsing that never passes through a JS number.
  - Fixtures in `packages/modules/bank/fixtures/` carry a local `.gitattributes` (`* -text`) so CRLF, BOM and Windows-1252 bytes stay exactly as a bank sends them (the root sets `eol=lf`).
  - A camt.053 file must hold exactly one `Stmt`; several statements in one file are refused with a clear message until a bank needs them (T-0059 can extend).
  - CSV text is read as UTF-8 when valid, else Windows-1252.
- Why: RQ-0019; DL-0082; AGENTS.md §0.5.
- Alternatives: an XML/OFX npm package (runtime dependency + ADR; uneven OFX 1.x support); normalising fixture line endings (would no longer test what banks send).

### DL-0086 — OIDC libraries pinned: openid-client 6.8.8 (runtime), oidc-provider 9.12.2 (dev), jose overridden to 6.2.12
- Date: 2026-10-24 · By: claude · Task: T-0011 · Category: tooling
- Decision: `apps/api` depends on `openid-client` 6.8.8 (relying party, runtime) and `oidc-provider` 9.12.2 (in-process test IdP, dev only), both exact. The root `pnpm.overrides` pins `jose` to 6.2.12, because pnpm resolved 6.2.13, published 4 days ago. 6.2.12 satisfies both libraries' ranges. Every package these two add to the lockfile is now at least 14 days old. `pnpm audit --prod`: no known vulnerabilities.
- Why: ADR-0016 and RQ-0015 name both libraries (DL-0062 covers the dependency). RQ-0020 records the release dates and API details. Found while doing this: the existing lockfile has `nan` 2.30.0 (6 days old, a `testcontainers` dev transitive), so `--config.minimum-release-age` cannot be used as a one-off flag. That is not changed here and is listed for the human.
- Alternatives: accept jose 6.2.13 (breaks the 14-day rule); set `minimumReleaseAge` repo-wide (a config change outside this task, and it fails on `nan` today).
- ADR: ADR-0016 (Proposed, security) · Status: accepted for the build; awaiting the human with ADR-0016

### DL-0087 — Tenant slug lookup: SECURITY DEFINER function plus an owner-only SELECT policy; app.auth_request (migration 0014)
- Date: 2026-10-24 · By: claude · Task: T-0011 · Category: security
- Decision:
  - `app.tenant.slug` is nullable, lower-case DNS-label shaped and unique. Existing tenants keep NULL, so they have no login URL until a slug is set.
  - `app.tenant_id_for_slug(text) RETURNS uuid` is SECURITY DEFINER, owned by lf_migrator, with `search_path = pg_catalog, pg_temp`, EXECUTE revoked from PUBLIC and granted to lf_app. It matches case-insensitively and returns the id of an **active** tenant only, so suspended and closed tenants cannot start a login.
  - FORCE RLS on `app.tenant` filters the owner too, so the function needs a policy: `slug_lookup ... FOR SELECT TO lf_migrator USING (slug IS NOT NULL)`. lf_app's policies are unchanged.
  - `app.auth_request` is tenant-scoped (RLS ENABLE + FORCE). A CHECK caps the expiry at 10 minutes, and `consumed_at` makes each row single use. lf_app gets SELECT, INSERT and UPDATE(consumed_at) only. The cross-tenant suite covers it through DEFAULT_ROW_OVERRIDES.
  - Migration number 0014 was pre-assigned (DL-0081). This branch alone has a gap at 0013, which the runner refuses, until the 0013 task is merged.
- Why: ADR-0016, login option (b). The card's step 4a asks for the FORCE RLS interaction to be designed deliberately. A policy scoped to the owner role is the narrowest way for a definer function to read under FORCE RLS without BYPASSRLS, which the runner and the roles forbid.
- Alternatives: a global slug → tenant table (a GLOBAL_TABLES security exception, and the human gate); a policy on a session variable (lf_app could set it); NO FORCE on app.tenant (forbidden by the runner).
- ADR: ADR-0016 (Proposed, security) · Status: accepted for the build; awaiting the human with ADR-0016

### DL-0088 — One fixed redirect URI with an `lf_oidc` browser-binding cookie; login error contract
- Date: 2026-10-24 · By: claude · Task: T-0011 · Category: security
- Decision:
  - Login is `GET /t/:slug/auth/login`. It answers 302 to the IdP and sets the cookie `lf_oidc=<tenant_id>.<state>` (HttpOnly, SameSite=Lax, Path=/auth, Max-Age 600).
  - Every tenant shares one callback, `GET /auth/callback`. The callback requires the cookie's state to equal the `state` parameter. It then consumes the pre-auth row atomically under the cookie tenant's RLS (`UPDATE … WHERE consumed_at IS NULL AND expires_at > now`) before the code exchange. A forged tenant id finds no row.
  - The code exchange runs with the stored PKCE verifier, the expected state and the expected nonce (`idTokenExpected`).
  - On success: 303 to `/` and `lf_session` (HttpOnly, SameSite=Lax, Path=/, Secure when the public URL is https).
  - Errors: 404 `not_found` (unknown, suspended, slug-less or malformed slug, all identical), 400 `invalid_request` (binding, replay, expiry), 400 `login_failed` (IdP or token validation), 403 `not_invited`.
  - Discovery runs lazily on the first login and is retried after a failure. The IdP is configured per deployment (`ApiOptions.oidc`). Per-tenant IdPs are part of the hosted-SaaS follow-up.
- Why: RFC 9700 asks for state/PKCE to be bound to the user agent (login CSRF), RQ-0020. One redirect URI keeps IdP client registration static. The cookie-names-tenant / row-proves-it pattern is ADR-0016's session pattern. This adds to ADR-0016 and contradicts none of it, so no new ADR.
- Alternatives: a per-slug callback `/t/:slug/auth/callback` (every tenant's URI must be registered at the IdP); a server-side lookup by state alone (no browser binding).
- ADR: ADR-0016 (Proposed, security) · Status: accepted for the build; awaiting the human with ADR-0016

### DL-0089 — Invited users by (issuer, subject); first login activates; login audited; T-0011 scope as built
- Date: 2026-10-24 · By: claude · Task: T-0011 · Category: scope
- Decision:
  - A login maps to `app.app_user` by `(idp_issuer, idp_subject)` inside the tenant. Unknown, other-issuer or disabled → 403, with no user created. `invited` becomes `active` on the first successful login (design §6.3 joiner).
  - The user's activation, the session (amr/acr from the ID token) and an audit row (`action = 'login'`, entity `session`) commit in one transaction. SessionService gains `createInTx` for this; `create` is unchanged in behaviour.
  - Scope: card steps 6 (session store and timeouts), 7 (revoke-all) and 7a (withTenant interceptor) were delivered by T-0105 and T-0104. T-0011 adds login, the callback and the slug lookup. No Keycloak realm JSON was added: tests use the in-process IdP, and the compose realm stays with the self-host install task (T-0094). Follow-ups: rate-limit the login route (design §6.9, ADR-0016 notes it) and IdP logout or back-channel logout (ADR-0016 follow-up).
  - The dev-only test IdP is typed by a minimal local declaration, `apps/api/src/auth/oidc-provider.d.ts`, instead of adding `@types/oidc-provider`.
- Why: ADR-0016 (no JIT; amr/acr captured; enforcement in T-0013). Apps/api rule: audit every mutation. A login is not an interceptor-wrapped route, so it writes its own row.
- Alternatives: match by email (an email change or a reused address at the IdP would hand over the account); activate at invitation time (the invited state would mean nothing); a separate transaction for the audit row (a session could exist with no audit row).
- ADR: ADR-0016 (Proposed, security) · Status: accepted for the build; awaiting the human with ADR-0016

### DL-0090 — Timeline lanes: greedy first-fit stacking with per-scale caps and "+n more"; Quarter = ISO weeks, Year = months; actual and expected never summed together
- Date: 2026-10-24 · By: claude · Task: T-0106 · Category: ui
- Decision: Resolve RQ-0021. Lane items are placed by greedy first-fit interval partitioning on a per-scale day footprint (Week 1 d, 5 weeks 4 d, Quarter 14 d, Year 31 d), sorted by start, then due-now first, then id; rows are capped per scale (3 / 2 / 2 / 2; Year needs 2 because the month holding the last statement date shows an actual and an expected mark) and the rest go into non-overlapping "+n more" markers that reveal them on demand and say when they hide a due-now item. Quarter aggregates by ISO week (Monday start), Year by calendar month; Week and 5 weeks by day. Each bucket keeps separate exact `Money` totals for actual and expected; overdue items are left out of expected and reported as `leftOut`; expected cash buckets report their closing balance and their lowest point.
- Why: Greedy first-fit is optimal for interval partitioning, so nothing is hidden unless it must be; deterministic and testable without text measurement; weekly buckets are the 13-week cash-flow practice because monthly totals hide troughs; P13 and P15 (RQ-0021 S1–S9).
- Alternatives: hand-set levels as in the prototype (overprints with real data); measuring text in the browser (non-deterministic, untestable in jsdom); monthly buckets for Quarter (hides the pay-run trough); counting overdue as expected today (Float's choice; shows money that may never arrive as expected cash).
- ADR: none · Status: accepted

### DL-0091 — packages/ui (`@ledgerforce/ui`) toolchain: React 19.3.0, jsdom Vitest project `ui`, Testing Library, axe via @axe-core/playwright, harness served by Vitest's Vite
- Date: 2026-10-24 · By: claude · Task: T-0106 · Category: tooling
- Decision: New workspace package `packages/ui`. Runtime dependencies `react` 19.3.0 and `react-dom` 19.3.0 (published 2026-09-09; the design's UI stack, §7.1/ADR-0002 — no new ADR), `decimal.js` 10.6.0 (ADR-0005) and `@ledgerforce/shared`. Dev-only: `@testing-library/react` 16.3.3 (2026-08-27), `@testing-library/dom` 10.4.2 (2026-09-13), `@testing-library/user-event` 14.6.7 (2026-09-02), `jsdom` 30.1.2 (2026-10-04), `@types/react` 19.3.0 and `@types/react-dom` 19.3.0 (2026-09-09); all ≥ 14 days old (DL-0061). Root dev dependency `@axe-core/playwright` 4.13.0 (2026-08-11; pulls `axe-core` 4.13.0), as named by principles v1 ("axe-core (`@axe-core/playwright`, WCAG 2.2 A/AA tags) on every screen"). This supersedes, for automated tests only, DL-0067's "axe-core from a scratch `npm pack`, not as a dependency": a CI gate cannot depend on a scratch file. A new Vitest project `ui` (jsdom, `packages/ui/src/**/*.test.{ts,tsx}`, setup file for Testing Library cleanup) is added to `pnpm test`; the `unit` project excludes `packages/ui/**` so no file runs twice. JSX is compiled by Vite's built-in transform (no `@vitejs/plugin-react`). The Playwright harness (`packages/ui/harness`) is served in-process by `createViteServer` from `vitest/node` (the Vite already installed with Vitest), so no `vite` dependency is added and nothing is built to disk. No CSS framework: the Timeline tokens and CSS are the styling.
- Why: Design §7.1 stack; test-first components need a DOM; real keyboard and ARIA behaviour is asserted in jsdom and Chromium.
- Alternatives: happy-dom (less complete ARIA/focus behaviour); `@vitejs/plugin-react` (not needed without Fast Refresh); a static build of the harness on disk (parallel Playwright workers would race on the output folder); Storybook (the card asks for a Storybook-free fixture page); keeping axe as a scratch file (not reproducible in CI).
- ADR: none (React is in ADR-0002's stack) · Status: accepted

### DL-0092 — Timeline component fixes owed before build, and what the package does not include yet
- Date: 2026-10-24 · By: claude · Task: T-0106 · Category: ui
- Decision: `@ledgerforce/ui` rebuilds the prototype as tested React components with these fixes: money is decimal strings end to end (the prototype formatted JS floats with `toLocaleString`; heights of the cash line are now computed with decimal.js); weekday labels are computed from the date (the prototype's "Mon 27 Oct", "Thu 30 Oct", "Wed 5 Nov" were wrong for 2026); hand-set lane `level`s are replaced by the RQ-0021 layout with "+n more"; the actual cash series ends at the last statement date, not at today (P15); every expected mark carries the word "expected" and every overdue span "not counted"; marks are real elements (not CSS pseudo-elements) so their state is testable; labels sit above today's rule; on phones the lanes become dated lists instead of a hidden chart; owner sentences use `sign="words"` ("12,604.10 out", P3 v1). Lane labels are clipped to the scale's footprint with an ellipsis (full text stays in the DOM) so the no-overlap invariant also holds on screen. Radix/shadcn primitives are not added: these components need only native buttons, lists and tables; they come with T-0081 when dialogs and menus are built, restyled with these tokens. `tokens.css` is a copy of `Docs/ui/system/tokens.css` (values unchanged; prettier-formatted) and the prototype stays as the reference.
- Why: The recommendation's "fixes owed before build" (`Docs/ui/research/03-recommendation.md` §2); P3, P13, P14, P15; AGENTS.md §4 (no float on money).
- Alternatives: port timeline.js as is (float money, overprinting labels); a canvas or SVG-only chart (no phone list view, weaker accessibility); adding Radix now without a consumer.
- ADR: none · Status: accepted

### DL-0093 — SS-PLAT-29 green with evidence; genericness score 1; e2e gate evidence for other tasks not committed from a worktree
- Date: 2026-10-24 · By: claude · Task: T-0106 · Category: process
- Decision: SS-PLAT-29 is `green` at bede6c3 (not `evidenced`, DL-0077) with Playwright screenshots (1440/390, light/dark, Quarter, Year, keyboard) and the Vitest JSON report in `.agent/evidence/T-0106/`. Genericness checklist on those screenshots: total 1 (G9 = 1), no item at 2. When the full `pnpm test:e2e` gate runs in this worktree it also appends T-0009 evidence (ui-mockups and evidence-harness specs); those files were moved out of the repository to the session scratch area and the T-0009 manifest restored, so the parallel branch does not change another task's evidence. Pre-commit screenshots of this task were likewise moved out and re-captured on a commit.
- Why: Evidence must point at a real commit (evidence skill step 1); parallel worktrees must not touch other tasks' areas (DL-0081).
- Alternatives: commit the T-0009 additions (mixes tasks); redirect `LF_EVIDENCE_DIR` for the gate (makes `evidence-harness.spec.ts` fail by design, so the gate would not be the real gate).
- ADR: none · Status: accepted

### DL-0094 — Salesforce package validated offline by a repo-owned contract test; sf CLI kept out of the repo
- Date: 2026-10-24 · By: claude · Task: T-0062 · Category: tooling
- Decision: The package metadata in `salesforce/force-app` is checked offline by Vitest tests in `salesforce/test/` (unit project). They read the XML with a small strict reader in `salesforce/test/xml.ts` (elements, text, the five predefined entities, comments, the root `xmlns`; anything else is refused) and assert the contract later tasks rely on. `@salesforce/cli` 2.155.0 (published 2026-10-08) is used only outside the repo, as a cross-check (`sf project convert source`), with its output recorded as evidence. No dependency is added. Config changes to make the test a first-class citizen: `vitest.config.ts` unit include `salesforce/test/**/*.test.ts`; `eslint.config.js`, `.prettierignore` and the root `tsconfig.json` cover `salesforce/test/` (the rest of `salesforce/` stays ignored).
- Why: RQ-0022: `sf project deploy validate` needs an org (none until the human provides a Dev Hub); the CLI is 697 MB / ~1,470 packages, too heavy for every `pnpm install`; no published XSD exists for source format. A hand-written strict reader avoids a lockfile change while other tasks run in parallel (DL-0081), and refusing unknown XML constructs keeps the metadata simple.
- Alternatives: `@salesforce/cli` as a devDependency (size); `fast-xml-parser` devDependency (6 transitive packages and a lockfile change, for a subset we can parse in ~100 tested lines); regex checks on raw XML (brittle).
- ADR: none · Status: accepted

### DL-0095 — Salesforce API version 67.0 for the package
- Date: 2026-10-24 · By: claude · Task: T-0062 · Category: tooling
- Decision: `sourceApiVersion` and every `*-meta.xml` that carries a version use **67.0** (Summer '26). The contract test enforces one version across the project.
- Why: RQ-0022: the CLI's own project template uses 67.0; Winter '27 (68.0) is still listed as preview in the doc sets reachable; 67.0 deploys to every current org. Re-check 68.0 after 2026-11-30.
- Alternatives: 68.0 now (preview risk); older versions (no benefit).
- ADR: none · Status: accepted

### DL-0096 — Package data contract: mirror objects, LedgerForce-owned fields and the billing-request event
- Date: 2026-10-24 · By: claude · Task: T-0062 · Category: architecture
- Decision (interpretation of design §5.4/§5.5 and UC-01/03/11/12; ADR-0006 governs ownership):
  - `LF_Invoice__c` and `LF_Payment__c`: `LF_Id__c` Text(36) **external ID, unique, case-insensitive** (the LedgerForce UUID; upsert key per §5.4); Name is Text and holds the document number (invoice number / receipt number); sharing model **Read** (public read-only, records owned by the integration user); no field is required at field level (required fields cannot carry permission-set FLS).
  - Invoice fields: `LF_Status__c`, `LF_Issue_Date__c`, `LF_Due_Date__c`, `LF_Total__c`, `LF_Amount_Due__c`, `LF_Amount_Credited__c` (UC-11), `LF_Days_Overdue__c`, `LF_Last_Payment_Date__c` (UC-03 "Paid + payment date"), `LF_PDF_Link__c`, `LF_Payment_Link__c`, lookups `LF_Account__c` and `LF_Opportunity__c`.
  - Payment fields (design names none; minimum for UC-03): `LF_Payment_Date__c`, `LF_Amount__c`, `LF_Method__c`, `LF_Reference__c`, lookups `LF_Account__c` and `LF_Invoice__c` (the invoice when a receipt pays one invoice; blank otherwise).
  - Account: `LF_Balance_Due__c`, `LF_Overdue_Amount__c`, `LF_Credit_Status__c`, `LF_Last_Payment_Date__c`. Opportunity: `LF_Invoice_Status__c`, `LF_Amount_Invoiced__c`, `LF_Amount_Paid__c`.
  - Types: money as Currency(18,2) (display mirror; the ledger keeps NUMERIC(19,4) and remains the truth); statuses as Text(40) because LedgerForce owns the vocabulary and an unknown picklist value would fail a write-back; links as Url; lookups (not master-detail) with delete constraint SetNull, because Salesforce owns Accounts/Opportunities (ADR-0006) and LedgerForce must not stop their deletion — reconciliation re-links by `LF_Id__c`.
  - `LF_Billing_Request__e`: HighVolume, PublishAfterCommit; fields `LF_Request_Id__c` (Text 36, client idempotency key, §5.6), `LF_Request_Type__c` (Text 40, e.g. `INVOICE_OPPORTUNITY`, `SEND_STATEMENT`), `LF_Record_Id__c` (Text 18), `LF_Requested_By__c` (Text 18).
- Why: RQ-0022; design §5.4–§5.6; the connector (T-0067) and LWC (T-0072) need a fixed contract.
- Alternatives: picklists for statuses (couples Salesforce to LedgerForce's status list); master-detail to Account (would block FLS in permission sets and cascade-delete mirrors); Currency(18,4) (Salesforce scale 4 shows odd cents to sales users; the mirror is display only).
- ADR: none (ADR-0006 covers ownership) · Status: accepted

### DL-0097 — Read-only enforcement: three permission sets, one custom permission, validation rules
- Date: 2026-10-24 · By: claude · Task: T-0062 · Category: security
- Decision:
  - Custom permission `LF_Integration_Write`, granted only by permission set `LF_Integration_User` (the API-only integration user, §5.1): Create/Read/Edit on both mirror objects (no Delete, no View/Modify All), Read/Edit on Account and Opportunity, `editable` on every LF field, Read on `LF_Billing_Request__e` (subscribe), user permission `ApiEnabled`.
  - `LF_Read_Only` (sales users, UC-12): Read on both mirror objects and `readable` (never `editable`) on every LF field; nothing on Account/Opportunity objects (their profiles already grant those); nothing on the event.
  - `LF_Billing_Requester` (users who press "Invoice this Opportunity"/"Send statement"): Create on `LF_Billing_Request__e` only. No `fieldPermissions` on event fields (FLS does not apply, RQ-0022 S10).
  - Validation rules: `LF_Mirror_Read_Only` on both mirror objects (`NOT($Permission.LF_Integration_Write)` — any insert or update by anyone else fails); `LF_Fields_Read_Only` on Account and Opportunity (fails when a non-integration user changes, or sets on insert, any LF field).
- Why: Design §5.4 ("permission sets and a validation rule"); salesforce/AGENTS.md; RQ-0022 S11 (custom-permission bypass pattern). The validation rule also stops admins whose profiles give FLS edit. Least privilege is asserted by tests listing exactly what each set grants.
- Known limits (for the human): validation rules do not fire on delete, so a user with Modify All Data can still delete mirror records; write-back/reconciliation restores them. Merging Accounts by an admin re-parents mirrors (fine).
- Alternatives: profile-based FLS only (cannot stop admins); one permission set for both publish and read (wider than needed).

- ADR: none · Status: accepted

### DL-0098 — Gate-run screenshots committed under T-0009 by mistake: kept, not repeated, fixed by T-0109
- Date: 2026-10-24 · By: claude (lead) · Task: T-0109 (found while merging T-0106) · Category: process
- Decision: `verify.sh` gate 9 runs `pnpm test:e2e`, whose evidence fixture writes screenshots and manifest entries for the specs' own tasks (T-0009). The lead's "verified → review" commits for T-0017 … T-0011 staged with `git add -A` and so committed about 30 T-0009 PNGs plus manifest entries per run. They are genuine runs of T-0009's scenarios at those commits, so they are kept (directive 6: never delete evidence). They overstate nothing, but they are noise filed under T-0009. From now on, gate-run evidence of other tasks is moved out of the tree before committing (as for the T-0106 merge: 38 files to the scratchpad, manifests restored). T-0109 makes the gate stop writing it.
- Why: Accuracy of the evidence record (AGENTS.md directive 8); found by the T-0106 agent's report.
- Alternatives: delete the extra PNGs (forbidden by directive 6); ignore (keeps adding noise).
- ADR: none · Status: accepted

### DL-0099 — Company ABN validated by the ABR checksum (migration 0015)
- Date: 2026-10-24 · By: claude (lead) · Task: T-0107 · Category: data-model
- Decision: `0015_platform_company_abn_checksum.sql` adds `company_abn_checksum CHECK (app.abn_is_valid(abn))` as NOT VALID, then VALIDATEs it, so a stored invalid ABN would stop the migration loudly instead of being changed. The T-0018 test fixture ABN `74625118903` (fails the checksum, RQ-0017 Finding 4) becomes the ATO's `51824753556`.
- Why: RQ-0017; a company ABN prints on tax invoices and must meet the same rule as a party's.
- Alternatives: leave the pattern-only check (a mistyped ABN reaches invoices).
- ADR: none · Status: accepted

### DL-0100 — Parallel round 2: T-0012, T-0063, T-0081; same protocol as DL-0081
- Date: 2026-10-24 · By: claude (lead) · Task: T-0012, T-0063, T-0081 · Category: process
- Decision: Round 2 of the parallel build runs T-0012 (roles/permissions: apps/api + migration 0016), T-0063 (Salesforce JWT bearer + encrypted token store: packages/connectors/salesforce + migration 0017) and T-0081 (web app shell: apps/web, no migration) in sub-agent worktrees with pre-assigned numbers (HANDOVER). Same protocol as DL-0081, plus three lessons from round 1:
  - each agent creates its branch from the stated base commit, because worktrees may start at an old commit;
  - a migration numbered above a not-yet-merged one is tested with a temporary placeholder, removed before committing (as T-0011 did);
  - gate runs must not commit other tasks' evidence (DL-0098).
  Not in this round:
  - T-0059: CAMT.053 was built inside T-0058, so the card needs re-scoping to batch entries, multi-statement files and camt.052/054.
  - T-0109: the lead does it after the merges, because it touches the shared e2e evidence fixture T-0081 uses.
  - T-0095: needs the human (AGENTS.md §5).
  - T-0103: Windows only.
  - T-0108: Phase 1.
- Why: Product owner's instruction to run independent tasks in parallel.
- ADR: none · Status: accepted

### DL-0101 — Role templates and permissions as a code constant; tenant-scoped role assignments
- Date: 2026-10-24 · By: claude · Task: T-0012 · Category: security
- Decision: The ten §6.4 role templates and the permission catalogue live in `packages/shared/src/rbac/catalogue.ts` (`@ledgerforce/shared/rbac`). The database knows only the role ids, through the IMMUTABLE function `app.role_template_exists` (migration 0016, mirrored and tested like `app.system_role_allows` in 0005). Assignments are rows in the tenant table `app.user_role` (RLS, no DELETE; revoke by setting `revoked_at`). Readings of the design that the human should check are listed in ADR-0023 *Open points*.
- Why: `packages/db/AGENTS.md` (no table without tenant_id without a security ADR); the mapping is reviewed and versioned with the code that enforces it.
- Alternatives: global template tables (GLOBAL_TABLES entry, mutable data changed only by releases); per-tenant seeded copies (drift, per-tenant data migrations for every new permission).
- ADR: ADR-0023 · Status: proposed (awaiting human)

### DL-0102 — Permission check runs in the tenant interceptor, fail-closed, denials audited separately
- Date: 2026-10-24 · By: claude · Task: T-0012 · Category: security
- Decision: `@RequirePermission(p)` / `@AnyMember()` are metadata; the check runs in `TenantInterceptor` right after the session is verified inside the tenant transaction. A tenant route with neither decorator is refused (403, `permission: null`); a permission route without a verified user principal is refused. A denial (403 `{error:'forbidden', permission}`) rolls back the request transaction and is audited in its own tenant transaction (`action = 'permission_denied'`).
- Why: NestJS runs guards before interceptors (https://docs.nestjs.com/faq/request-lifecycle), and the principal exists only after verification under RLS (ADR-0016). SS-UC02-07 requires the refusal to be audited, but a refused request's transaction never commits.
- Alternatives: a Nest guard that verifies the session again (two verifications, two transactions); default-open routes (a forgotten decorator would expose data).
- ADR: ADR-0023 · Status: proposed (awaiting human)

### DL-0103 — Role change bumps session_epoch in a database trigger
- Date: 2026-10-24 · By: claude · Task: T-0012 · Category: security
- Decision: An AFTER INSERT/UPDATE trigger on `app.user_role` increments `app.app_user.session_epoch` of the affected user in the same transaction (revoke-all, ADR-0016). The API audits the change (before/after) through the request's audit row. Owner grants/revokes need `users.roles.assign_owner` (Owner only); other roles need `users.roles.assign` (Owner, Finance Admin — design §6.3 mover). The last active Owner cannot be revoked (409 `last_owner`).
- Why: Design §6.2 "revoke-all on … role change" must hold for every writer, not only the API; least privilege for granting Owner; a tenant must not lock itself out.
- Alternatives: bump in the service only (another writer could forget it).
- ADR: ADR-0023 · Status: proposed (awaiting human)

### DL-0104 — SS-UC02-07 proven through a stand-in for T-0043's route; SS-PLAT-48/49 added
- Date: 2026-10-25 · By: claude · Task: T-0012 · Category: process
- Decision: The AR batch-run endpoint belongs to T-0043. `apps/api/src/authz/permissions.db.test.ts` mounts a test controller through the new `ApiOptions.testControllers` hook, declared exactly as T-0043 must declare its route (`@RequirePermission('ar.batch.run')`); the check, the 403 and the audit row are the real ones. T-0043 must add its own SS-UC02-07 test on the real route. New scenarios SS-PLAT-48 (role matrix) and SS-PLAT-49 (permission on every endpoint, role-change audit/revoke-all/no delete) cover the card's goal, which SS-UC02-07 alone does not. The bank-accounts API test now grants its users the Accountant role, because the endpoint requires `parties.bank_account.read`; its assertions are unchanged.
- Why: TDD needs an observable route now; the card's goal ("a guard used by every endpoint") had no AC.
- Alternatives: a stub batch endpoint in production code (would pre-empt T-0043); unit-only proof (would not show the 403 or the audit row).
- ADR: ADR-0023 · Status: accepted

### DL-0105 — Salesforce JWT bearer contract (RQ-0024): RS256, aud = login or test URL only, exp ≤ 180 s, mapped error codes
- Date: 2026-10-24 · By: claude · Task: T-0063 · Category: architecture
- Decision: The self-host connection signs `{"alg":"RS256","typ":"JWT"}` assertions with `node:crypto` (claims `iss` consumer key, `sub` integration username, `aud`, `iat`, `exp` ≤ 180 s after `iat`, random `jti`), refuses non-RSA or < 2048-bit keys, and posts `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=…` form-encoded to `<aud>/services/oauth2/token`. `aud` and token host are one stored value, `https://login.salesforce.com` or `https://test.salesforce.com` (CHECK in migration 0017), so no row can send an assertion to another host. Token-endpoint failures map to stable codes (`not_preauthorized`, `invalid_audience`, `invalid_assertion`, `invalid_user`, `ip_restricted`, `invalid_grant`, `invalid_client`, `unsupported_grant_type`, `token_endpoint_unavailable` (retryable), `malformed_response`) by case-insensitive substring of `error_description`. The HTTP client is injected; tests use a local fake endpoint that verifies signatures.
- Why: RQ-0024 (primary pages reachable only as search extracts — confidence medium), ADR-0007, design §5.2. No new runtime dependency.
- Alternatives: a JWT library such as `jose` (would be a new runtime dependency needing an ADR, for ~30 lines of code); a free-form token URL (My Domain) — not needed for this flow and widens where an assertion can be sent.
- ADR: ADR-0007 (unchanged) · Status: accepted

### DL-0106 — Salesforce access-token cache: sealed, reused for 15 minutes, re-signed after a 401, single flight by row lock
- Date: 2026-10-25 · By: claude · Task: T-0063 · Category: architecture
- Decision: `getAccessToken()` locks the connection row (`SELECT … FOR UPDATE`), returns the cached token if it is younger than 15 minutes (configurable `maxAgeSeconds`), otherwise opens the private key, signs a new assertion, exchanges it and stores the sealed token in the same transaction. Callers that get a 401 from Salesforce call `invalidateAccessToken()`. The HTTP exchange runs while the row lock is held, so concurrent callers wait for one exchange instead of each signing.
- Why: The JWT bearer response has no `expires_in` and no refresh token (RQ-0024 F3); the token lives as long as the org's session timeout, whose shortest setting is 15 minutes, so a 15-minute window avoids most 401s without a token call per request. RQ-0005 asks for single-flight refresh per org.
- Alternatives: sign per request (needless token-endpoint load); cache until a 401 only (every expiry costs a failed API call); an in-process mutex (does not cover several workers).
- ADR: none (within ADR-0007 and ADR-0018) · Status: accepted

### DL-0107 — app.salesforce_connection (migration 0017): write-once key and identity, rotation by new row, column grants
- Date: 2026-10-25 · By: claude · Task: T-0063 · Category: security
- Decision: One row per connection. The private key, login URL, username, consumer key and certificate facts are write-once (no UPDATE grant); lf_app may UPDATE only the token-cache columns, `instance_url` and `status`; no DELETE. Rotating the key or certificate inserts a new row and marks the previous active row `superseded`; a partial unique index keeps one active row per company. Private key and token use ADR-0018 envelope encryption with AAD `lf-field-v1|tenant|company|app.salesforce_connection|row|field`; each set of encryption columns is all-or-nothing by CHECK. Only the certificate's notAfter and SHA-256 fingerprint are stored (the certificate is public). `auth_flow` already admits `authorization_code_pkce` so the hosted flow can add columns later without replacing a constraint (the migration runner refuses DROP).
- Why: Design §6.1 (integration token theft), §6.6; ADR-0018; same pattern as party bank accounts (migration 0012). Read paths select named non-secret columns only.
- Alternatives: store the certificate PEM (not needed for the alert); update the key in place (loses history; directive 6); a generic secrets table (an indirection with no second user yet).
- ADR: ADR-0018 (Proposed; this adds two sealed fields under it — security gate applies to ADR-0018 itself) · Status: accepted

### DL-0108 — Test-only certificate builder and documented (not recorded) token fixtures
- Date: 2026-10-25 · By: claude · Task: T-0063 · Category: tooling
- Decision: Tests generate RSA keys at runtime and build a minimal self-signed X.509 v3 certificate in DER by hand (`packages/connectors/salesforce/src/testing/keys.ts`, node:crypto only), because Node has no certificate-creation API and openssl is not guaranteed on every developer machine. No key or certificate is committed. Token-endpoint fixtures live in `packages/connectors/salesforce/fixtures/documented/` and state that they were written from RQ-0024, not recorded, because agents may not contact a Salesforce org; `fixtures/recorded/` waits for a human-authorised scratch-org spike.
- Why: packages/connectors/AGENTS.md asks for recorded, redacted fixtures; that is impossible offline, and labelling the substitute honestly keeps the evidence truthful.
- Alternatives: shell out to openssl (platform-dependent); a certificate library (new dev dependency for one helper); commit a test key (forbidden by the salesforce-engineer rules).
- ADR: none · Status: accepted

### DL-0109 — apps/web dependencies: TanStack Router 1.170.41 and Query 5.104.1, Radix DropdownMenu 2.1.25, Vite 8.3.4; seroval pinned to 1.6.9
- Date: 2026-10-24 · By: claude · Task: T-0081 · Category: tooling
- Decision: New workspace package `apps/web` (`@ledgerforce/web`). Runtime: `@tanstack/react-router` 1.170.41 (2026-09-30), `@tanstack/react-query` 5.104.1 (2026-10-02), `@radix-ui/react-dropdown-menu` 2.1.25 (2026-10-05), `react`/`react-dom` 19.3.0 (as packages/ui), `@ledgerforce/ui`. Dev: `vite` 8.3.4 (2026-10-08; 8.3.5, already in the lockfile through Vitest, is 3 days old) for `dev`/`build`/`preview`, plus the same Testing Library, jsdom and `@types/*` versions as packages/ui (DL-0091). Root `pnpm.overrides` pins `seroval` and `seroval-plugins` to 1.6.9 (2026-10-09): `@tanstack/router-core` asks for `^1.6.7` and pnpm resolved 1.7.2, published today. All 51 new lockfile packages were dated with `npm view` (RQ-0025 E1): none younger than 14 days. `pnpm audit --prod` clean.
- Why: Design §7.1 / ADR-0002 name React, Vite, TanStack and shadcn/ui; Radix is the primitive layer shadcn/ui's dropdown is built on, used unstyled and dressed in Timeline tokens (DL-0070; deferred to this task by DL-0092). No ADR: nothing outside the design's stack. 14-day rule: DL-0061.
- Alternatives: file-based routing with `@tanstack/router-plugin` (extra dependency and code generation, RQ-0025 F1); a hand-written menu button (re-implements the keyboard and focus rules Radix already tests); no direct `vite` dependency (the app could not be built or run outside tests); taking seroval 1.7.2 (breaks the 14-day rule).
- ADR: none (ADR-0002 stack) · Status: accepted

### DL-0110 — Web shell routing and auth flow: code-based routes, same origin as the API, 401 → sign-in
- Date: 2026-10-24 · By: claude · Task: T-0081 · Category: architecture
- Decision: Resolve RQ-0025. Code-based TanStack Router routes: `/sign-in` outside the shell; a pathless layout route with `/` (Timeline), `/sales`, `/purchases`, `/bank`, `/reports`, `/settings`. The SPA is served on the API's origin (dev: Vite proxy for `/auth` and `/t`) and never uses paths under `/auth` or `/t/`. Sign-in validates the slug against migration 0014's pattern and navigates the whole page to `/t/<slug>/auth/login`; the shell reads `GET /auth/me` through TanStack Query; a 401 anywhere sends the user to `/sign-in?reason=expired`; other failures show an error with Retry. Sign-out is `POST /auth/logout`; 204 or 401 both clear the query cache and land on `/sign-in?reason=signed-out`. The API base, `fetch` and full-page navigation are injected (app environment) so components are tested without a browser.
- Why: The callback sets an `HttpOnly`, `SameSite=Lax`, `path=/` cookie and redirects to `/` (T-0011, ADR-0016), so only a same-origin SPA receives the session; full-page navigation is needed for the IdP redirect; never looping on errors other than 401.
- Alternatives: file-based routing (RQ-0025 F1); a bearer token in browser storage (ADR-0016 chose server-side sessions); `fetch` to the login URL (cannot follow a cross-origin IdP redirect as a page).
- ADR: none (follows ADR-0016) · Status: accepted

### DL-0111 — Web shell layout and behaviour: one top bar, non-modal user menu, dashed empty states, focus to the new heading
- Date: 2026-10-25 · By: claude · Task: T-0081 · Category: ui
- Decision: The shell follows the Timeline reference screens (`Docs/ui/system`, DL-0070): one top bar with "LedgerForce", the sections (Timeline, Sales, Purchases, Bank, Reports, Settings) and the person's name as the user-menu button; the current section is an ink block and carries TanStack Link's own `aria-current="page"` (the app adds no active-state props: mutation checks showed them redundant). No icon sidebar, search, bell or avatar (G5). The user menu is Radix `DropdownMenu` with `modal={false}`: the modal default puts `aria-hidden` on the page while its links stay focusable (axe `aria-hidden-focus`), and the APG menu button needs no modality. Section placeholders show a heading, a plain gloss with the accounting term in brackets (P12) and an empty state in a dashed outline (the timeline's "not there yet" mark) that says what will appear and what must happen first; no invented data, no primary action until one exists. After a client-side navigation focus moves to the new `<h1>` (tabindex -1) and the title becomes "<Section> – LedgerForce"; a skip link comes first. The shell's own Vitest project `web` (jsdom) is added to `pnpm test`; the `unit` project excludes `apps/web/**`; ESLint gives `apps/web/src` browser globals and the money-path number-conversion ban; `tests/e2e/fixtures/genericness.ts` holds the genericness probe as a shared function (the copy in ui-system.spec.ts is left as is). Queries do not retry automatically, so a failed session check shows its error and Try again at once.
- Why: Principles P12, P14 (positions are a contract), WCAG 2.4.1 (bypass blocks), 2.4.3 (focus order), 4.1.2; genericness checklist ≤ 4 (DL-0065); RQ-0025.
- Alternatives: left sidebar (G5, rejected twice in the v0.1/v2 reviews); a modal menu (axe violation); focusing `<main>` instead of the heading (screen readers then announce nothing useful); a page-wide empty illustration (G11 decoration).
- ADR: none · Status: accepted

### DL-0112 — SS-PLAT-52 and SS-PLAT-53 green with evidence; genericness score 2; gate-run evidence of other tasks kept out
- Date: 2026-10-25 · By: claude · Task: T-0081 · Category: process
- Decision: SS-PLAT-52 (sign-in, session check, sign-out) and SS-PLAT-53 (shell navigation, states, keyboard, WCAG 2.2 AA, genericness) are `green` at ae91f61 (not `evidenced`, DL-0077), with 19 Playwright screenshots (1440/390, light/dark, every section, keyboard focus, user menu, error, signed out, not-found) in `.agent/evidence/T-0081/`, captured by running only `tests/e2e/web/shell.spec.ts` on a clean tree so the manifest's commit has no `-dirty` suffix. Genericness checklist on those screenshots: total 2 (G9 = 1, G13 = 1), no item at 2. The full `pnpm test:e2e` gate (51 passed) also wrote T-0009 and T-0106 screenshots and manifest entries; those 41 files were moved to the session scratch area and both manifests restored (DL-0098). Screenshots from pre-commit runs were likewise moved out and not committed.
- Why: Evidence must point at a real, clean commit (evidence skill step 1); parallel branches must not change other tasks' evidence (DL-0081, DL-0098).
- Alternatives: commit the gate run's `-dirty` evidence (its only tracked changes were the other tasks' manifests, but the label would mislead a reviewer); redirect `LF_EVIDENCE_DIR` for the gate (makes `evidence-harness.spec.ts` fail by design, DL-0093).

### DL-0113 — Parallel agents each get their own scratchpad subfolder; register totals recomputed from rows
- Date: 2026-10-25 · By: claude (lead) · Task: process (found during round 2) · Category: process
- Decision:
  - Every parallel sub-agent brief names its own scratchpad subfolder (`scratchpad/<task-id>/`). In round 2, one agent's helper script overwrote another's at the same scratchpad path. Only scripts collided, no repository files, and results were unaffected (T-0063 report).
  - The success-scenario register's "Totals" line is recomputed from the rows at each merge, not edited by hand by agents: 144 scenarios (14 need screenshots) after merging T-0063.
  - Lead merge tooling for the append-only registers (sort blocks by id, then a line check against both parents) is kept as a scratch helper. If it is promoted into the repo later, that is a decision-log item.
- Why: Parallel builds share the session scratchpad. The totals line was stale (agents correctly left it, one adjusted it by hand).
- ADR: none · Status: accepted

### DL-0114 — T-0059 re-scoped: its CAMT.053 core was delivered by T-0058
- Date: 2026-10-25 · By: claude (lead) · Task: T-0059 · Category: scope
- Decision: T-0058's own acceptance criterion (SS-UC08-01) required CAMT.053, so CAMT.053 parsing was built there. T-0059 keeps its id and dependency but is re-scoped to what T-0058 left out: batch entries split into TxDtls, several `Stmt` per file, camt.052/054 if AU banks use them. New scenario SS-PLAT-54 replaces SS-UC08-01 on this card. The original goal is quoted in a dated note on the card (nothing deleted).
- Why: Avoid duplicate work and a misleading card (T-0058 report, HANDOVER).
- Alternatives: mark T-0059 done (would hide the remaining gaps); supersede with a new card (more churn for the same content).

- ADR: none · Status: accepted

### DL-0115 — verify gate 9 redirects other tasks' e2e evidence to a temp dir (T-0109)
- Date: 2026-10-25 · By: claude (lead) · Task: T-0109 · Category: tooling
- Decision: `verify.sh` gate 9 runs `pnpm test:e2e` with `LF_EVIDENCE_ONLY_TASK=$TASK`. The Playwright evidence fixture resolves its environment through `evidenceEnvFor()` (packages/testing/src/evidence/destination.ts): specs filed under the verified task write to `.agent/evidence/` as before; specs of any other task still run and screenshot, but into `<tmp>/lf-evidence-gate/<task>/other-tasks/`. SS-PLAT-19 (the harness test) asserts whichever location is in effect: strict `.agent/evidence/T-0009/` normally and when T-0009 itself is verified, the temp location otherwise. Without the variable nothing changes. The manual cleanup rule in HANDOVER (DL-0098) is retired.
- Why: DL-0098 — each verify run added about 30 PNGs to T-0009's evidence.
- Alternatives: skip other tasks' specs during verify (would hide regressions); stop screenshotting (loses the report attachments).
- ADR: none · Status: accepted

### DL-0116 — Parallel round 3: T-0023, T-0013, T-0059
- Date: 2026-10-25 · By: claude (lead) · Task: T-0023, T-0013, T-0059 · Category: process
- Decision: Round 3 runs T-0023 (periods, close matrix and lock dates: ledger + db, migration 0018), T-0013 (MFA for finance roles and step-up: apps/api auth, migration 0019) and T-0059 (CAMT extensions, re-scoped by DL-0114: modules/bank, migration 0020 only if needed) in sub-agent worktrees with pre-assigned numbers and per-agent scratchpad folders (HANDOVER; DL-0081, DL-0100, DL-0113). If T-0059 needs no migration, numbering stays gapless because 0020 is the highest. Gate-run evidence is now redirected automatically (DL-0115). T-0015 (SoD) waits for round 4: it changes the same authorisation code as T-0013 and needs a security ADR.
- Why: Product owner's instruction to keep building independent tasks in parallel.
- ADR: none · Status: accepted

### DL-0117 — Period matrix as data, mirrored in SQL; payout under AR lock is a tenant setting pending the product owner
- Date: 2026-10-25 · By: claude · Task: T-0023 · Category: accounting
- Decision: The §3.5 source-type × status matrix is the TypeScript constant `PERIOD_MATRIX` with the source-type catalogue `SOURCE_TYPES` (packages/ledger/src/period-matrix.ts), mirrored by IMMUTABLE SQL functions `app.source_type_class` / `app.period_decision` (migration 0018) and proven equal by a fast-check property and an exhaustive trigger test. Classes per RQ-0026 (payroll as AP, reversals need an override under any lock, unknown source types refused). The payout-under-AR-lock cell is tenant setting `payout_under_ar_lock`, default `override` (treated as AR); not decided by the agent. Stored source-type codes are the golden names with `.` → `_`, because the 0007 CHECK refuses dots and a CHECK cannot be loosened forward-only.
- Why: RQ-0026; design §3.5, §11.3 item 4; RQ-0012 item 4.
- Alternatives: global matrix table (needs a security ADR for a table without tenant_id); per-tenant matrix rows (silent divergence from §3.5); deciding the payout cell (human gate, §6.4 of AGENTS.md).
- ADR: ADR-0024 · Status: proposed (awaiting human)

### DL-0118 — Invariant 3 enforced by a BEFORE trigger; overrides are personal, per posting, and audited
- Date: 2026-10-25 · By: claude · Task: T-0023 · Category: accounting
- Decision: `app.journal_entry_period_check` (BEFORE INSERT OR UPDATE OF status) fills `period_id` from `entry_date` for posted entries, refuses no period / a wrong client period_id (`journal_entry_in_period`), unknown source types (`journal_entry_source_type_known`) and disallowed cells (`journal_entry_period_allows`); the engine maps the constraint name to PERIOD_LOCKED / NO_PERIOD / UNKNOWN_SOURCE_TYPE (`toPeriodError`). An "override" cell passes only with an `app.period_override` row for the same company, period, source type and idempotency key, granted to the entry's `created_by`, who must hold `period.lock.override`. Drafts are not checked; posted → reversed is not a posting. Posters take a shared and status changes an exclusive transaction advisory lock per period (lf_app cannot `FOR SHARE` without UPDATE). Statement lines dated in a hard-locked period cannot change status (SS-UC08-07). The ledger test fixture now gives every company the AU FY2027 periods.
- Why: Design §3.3 says the database enforces it; RQ-0026 S8 experiments.
- Alternatives: a deferred constraint trigger (the deferred hash-chain trigger hashes period_id, so the period must be fixed at insert; refusing at the statement also gives the engine the cause at once); an override flag on the entry (not attributable, not audited).
- ADR: ADR-0024 · Status: proposed (awaiting human)

### DL-0119 — Period status changes only through SECURITY DEFINER functions; reopen from hard lock by two different approvers
- Date: 2026-10-25 · By: claude · Task: T-0023 · Category: security
- Decision: lf_app has no UPDATE on `app.fiscal_period`; `app.period_set_status` checks `period.lock` (to AR/AP lock), `period.close` (to soft close / hard lock) or `period.reopen` plus a reason (backward), and refuses leaving hard_locked; `app.period_reopen_request` + `app.period_reopen_approve` need two different active holders of `period.reopen` and a reason (also a CHECK). Permissions are read from active role grants through `app.role_allows_period_permission`, an IMMUTABLE mirror of the four period permissions in the role catalogue (test proves agreement, as for 0016). Every change writes `app.period_status_change` and `audit.audit_log`; guards stop even the owner changing anything but status or deleting. Settings are insert-only history (`app.period_settings`, latest wins, needs `period.lock`). No catalogue permission was added (all four existed). This implements the "two approvers and a reason" note on `period.reopen` in the catalogue ahead of T-0015 (SoD) and T-0079 (reopen flow/UI); step-up MFA for reopen is T-0013/T-0079.
- Why: Design §3.5, §6.4; UC-10 A3; directive 6.
- Alternatives: UPDATE grant on status with a trigger (cannot know the actor's permission reliably); permission checks only in the API (not a last line of defence).
- ADR: ADR-0024 · Status: proposed (awaiting human)

### DL-0120 — Lock-date policy and fiscal-year conventions as data; SS rows marked at the period layer
- Date: 2026-10-25 · By: claude · Task: T-0023 · Category: scope
- Decision: `resolvePostingDate()` applies the tenant policy: `reject` → PeriodLockedError(PERIOD_LOCKED); `post_to_first_open_date_with_note` → start date of the first later period that allows the source type without override, with the note "Dated <d> in period <p> (<status>); posted on the first open date <d2> under the tenant lock-date policy."; none → PERIOD_LOCKED. Fiscal years are generated from `FISCAL_YEAR_CONVENTIONS` (AU: start month 7; calendar: 1), label FY<end year>, 12 monthly periods, overlaps refused. The card's db scenarios are `green (period/matrix layer …)` in the register: the Closed Won draft invoice and Sync issue (T-0069), payout posting (T-0075), bill posting (T-0050), the unmatch action (T-0061) and the close checklist (T-0078) remain with their tasks. New SS-PLAT-56 (guarded status changes and reopen) and SS-PLAT-57 (fiscal-year generation). The card's test file names `period.matrix.spec.ts` / `period.enforce.spec.ts` follow the repo convention instead (`period-matrix.test.ts`, `period.enforce.db.test.ts`, `period-control.db.test.ts`).
- Why: Design §2, §5.6 rule 5; honest evidence (DL-0077).
- Alternatives: redirecting only for hard locks (AR/AP locks would still reject automated feeds); hard-coding 1 July.
- ADR: ADR-0024 · Status: accepted

### DL-0121 — What counts as MFA, who must have it, and the mfa_required / step_up_required error contract
- Date: 2026-10-25 · By: claude · Task: T-0013 · Category: security
- Decision: Resolve RQ-0027. A session is MFA when its `amr` contains `mfa`, `otp` or `hwk`, or its `acr` is one of the configured MFA values (`createApi({ mfa: { acrValues } })`, default `urn:ledgerforce:loa:mfa`). A user holding any role whose template has `mfaRequired` (Owner, Finance Admin, Accountant, AP Clerk, Payroll Officer) gets 403 `{"error":"mfa_required"}` on every permission route until the session is MFA. Member routes (`/auth/me`, `/auth/logout`, `/auth/step-up`) stay open. A step-up route answers 401 `{"error":"step_up_required","max_age":N}` unless the session is MFA and `auth_time` is no older than N seconds (and no more than 60 s in the future). Both refusals roll back the request and are audited in their own transaction (`mfa_required`, `step_up_required`, entity `session`). Order in TenantInterceptor: session → undeclared → roles → MFA → permission → step-up.
- Why: Design §6.2; the IdP may ignore `acr_values` and `prompt=login`, so LedgerForce checks the asserted claims itself (RQ-0027 findings 1, 2, 6). MFA comes before the permission check so that a finance user without MFA can use no permission route at all. The permission check comes before step-up so that nobody is asked to re-authenticate for something they may not do.
- Alternatives: trust `acr_values` (voluntary, RQ-0027 S1); accept every RFC 8176 second-factor value (`sms`, `swk`, `fpt` are often a single factor; a deployment can map them to the MFA `acr`); a Nest guard (guards run before the tenant transaction, DL-0102).
- ADR: ADR-0025 · Status: proposed (awaiting human)

### DL-0122 — Step-up re-authenticates the existing session; auth_time from the ID token; 300 s default; fail-closed step-up permissions
- Date: 2026-10-25 · By: claude · Task: T-0013 · Category: security
- Decision: Migration `0019_auth_mfa_step_up.sql` adds `app.session.auth_time` (from the ID token's `auth_time`, NULL if not asserted, and NULL for older sessions: never fresh), plus `session_id` (composite FK to the same tenant's session), `max_age_seconds` (1..3600) and `return_to` (a same-origin path) on `app.auth_request`. Grants unchanged, nothing dropped. `GET /auth/step-up?max_age&return_to` (member route) sends the browser to the IdP with `prompt=login`, `max_age` and `acr_values`, using the login's PKCE, state, nonce and `lf_oidc` binding. The shared `/auth/callback` passes `maxAge` to `openid-client`. It requires the same valid `lf_session`, the same `(iss, sub)` user and an MFA answer, then updates `auth_time`/`amr`/`acr` on that session and audits `step_up`. A wrong user or a non-MFA answer → 403 `step_up_mismatch` / `mfa_required`, audited as `step_up_refused`, session untouched. No new session and no new cookie. `@RequireStepUp(maxAge = 300)` marks routes. Every route whose permission is in `STEP_UP_PERMISSIONS` (payment batch and net-pay release, bank-account change request and verify, period reopen and lock override) needs step-up even without the decorator.
- Why: Design §6.2 names those three actions; a session-level step-up keeps the session id stable and cannot swap the signed-in user (ADR-0025 option 2). 300 s matches the RQ-0027 inference for the IdP's LoA max age.
- Alternatives: re-login creating a new session (changes the cookie mid-task; user swap risk); per-action step-up tokens (more plumbing, can be layered on later); taking the callback time instead of the IdP's `auth_time` (would turn an SSO-cookie answer into a "fresh" step-up).
- ADR: ADR-0025 · Status: proposed (awaiting human)

### DL-0123 — T-0013 test set-up: stand-in routes, MFA fixtures in the T-0012/T-0037 tests, SS-PLAT-58/59
- Date: 2026-10-25 · By: claude · Task: T-0013 · Category: process
- Decision: The payment-batch release (T-0054), bank-detail change (T-0037) and period reopen (T-0023) endpoints do not exist yet. `mfa-step-up.db.test.ts` mounts test controllers declared exactly as those tasks must declare them (`@RequirePermission(...)` + `@RequireStepUp(300)`), as DL-0104 did for T-0043. `permissions.db.test.ts` and `bank-accounts.db.test.ts` now create their sessions with `amr ['pwd','otp']`. Their Owner, Finance Admin, Accountant and AP Clerk users need MFA since T-0013; the tests are about permissions and masking, and no assertion changed. New scenarios SS-PLAT-58 (step-up on the existing session) and SS-PLAT-59 (fail closed). SS-UC06-03 is green for its step-up part only; the real release stays with T-0054. The test IdP stamps logins with the test clock (`ts`) so `auth_time` and the API agree.
- Why: Test-first without the later tasks' endpoints; the fixtures had to follow the new policy rather than weaken it.
- Alternatives: exempt test sessions from MFA (would hide the policy); wait for T-0054/T-0037/T-0023 (blocks the security control the design requires before money moves).
- ADR: none · Status: accepted

### DL-0124 — ADR-0025 written for T-0013; local placeholder for migration 0018
- Date: 2026-10-25 · By: claude · Task: T-0013 · Category: process
- Decision: ADR-0025 (security, Proposed, human gate) records the MFA and step-up model. The brief said to write it only if ADR-0016/0023 had to change, and they did not: both left enforcement to T-0013. But the security-reviewer role requires a security ADR for a security-model change, and a new public auth endpoint and error contract also need an ADR (apps/api/AGENTS.md). ADR-0016 and ADR-0023 are extended, not superseded. Another branch owns migration 0018, so all local test runs used an untracked `packages/db/migrations/0018_placeholder.sql` (`SELECT 1;`), deleted before every commit and never committed.
- Why: AGENTS.md wins over a brief; parallel numbering (DL-0116).
- Alternatives: DL entries only (would skip the human gate for a security-model change); renumber to 0018 (collides with T-0023).
- ADR: ADR-0025 · Status: accepted

### DL-0125 — CAMT batch entries are split into their TxDtls only when the parts add up exactly; entry kept on the line (migration 0020)
- Date: 2026-10-25 · By: claude · Task: T-0059 · Category: architecture
- Decision:
  - A booked camt.053 entry with two or more `NtryDtls/TxDtls` that all carry an amount (`TxDtls/Amt`, else `AmtDtls/TxAmt/Amt`) is imported as one line per TxDtls, in file order, signed by the part's own `CdtDbtInd` or else the entry's, in the bank account's currency. The signed parts must add up exactly (Money) to the entry's booked amount; otherwise the whole file is refused, naming the entry. `Btch/NbOfTxs` and `TtlAmt` are not checked, because banks may debulk and change the count; the amounts are what count.
  - Parts without any amount: the entry stays one line with the booked amount, the entry's text and no reference (no single part's reference is put on the total). Only some parts with an amount: refused. One TxDtls: unchanged from T-0058. Pending (non-BOOK) entries stay excluded, parts included.
  - A part's `bankTxnId` is its own `TxDtls/Refs/AcctSvcrRef` or null, never the shared entry reference. A part without its own id gets the `h:` key over date, amount, currency, description, entry reference and position (plus occurrence). That key is deterministic and distinct from other parts and from an unsplit line. Keys of unsplit lines are byte-for-byte those of T-0058.
  - Migration `0020_bank_camt_extensions.sql` adds `bank_statement_line.entry_ref` (entry `AcctSvcrRef`, else `NtryRef`) and `entry_tx_no` (position). Both are nullable, with CHECK entry_ref ⇒ entry_tx_no. Additive, no grant change.
- Why: RQ-0028 findings 2–3 (the bank sample sums exactly; a known open-source parser gives every amount-less part the full entry amount). T-0060 needs per-invoice lines to match BPAY and merchant settlements, and each part must trace back to the bank's entry.
- Alternatives: keep batches as one line (blocks matching); split and trust the parts without a sum check (silent cash errors); synthesise `<entryRef>/<n>` bank ids (not the bank's id, and order-dependent); put the entry reference in `reference` (overloads a matching field); no migration (loses the link from part to entry).
- Known limit: a statement imported before T-0059 kept a batch as one line. An overlapping file imported now would add the parts beside it. No production data exists yet (RQ-0028 follow-up).
- ADR: none · Status: accepted

### DL-0126 — Several statements per camt.053 file: imported for the company, each matched to its bank account, atomically
- Date: 2026-10-25 · By: claude · Task: T-0059 · Category: architecture
- Decision:
  - New `importStatementFile(trx, { companyId, content, … })`, camt.053 only. Every `Stmt` is matched to one of the company's bank accounts using what is stored in clear: the BSB (from `Acct/Svcr/…/ClrSysMmbId/MmbId`, or an account id written "BSB-number" / "BSB number") plus the last 3 of the number, the statement currency, and active accounts only. Without a BSB, the last 3 must be unique. The encrypted number is never decrypted for this (DL-0084). An unknown, ambiguous or missing account, or the same account in two statements, refuses the file and names the statement number.
  - **Atomic, not per-statement:** all statements are matched and fully checked (currency, opening + lines = closing, batch sums) before anything is written. The writes run in the caller's transaction. Each statement gets its own `bank_statement` row (same file SHA-256, different bank account), with the file-level and line-level duplicate rules of DL-0082 applied per account. The result reports per statement and for the whole file.
  - `importStatement` (one bank account) still refuses a multi-statement file, now with a message pointing to the company file import. DL-0085's one-statement rule is superseded for the file import only.
- Why: a file is one upload. Partial imports would leave the user unsure what got in, and re-uploading is already safe through dedupe. Westpac sends many accounts per file (RQ-0028 finding 4).
- Alternatives: per-statement import with a partial result (harder to explain, and re-importing a fixed file mixes duplicate_file with new lines); let the user map each statement by hand (more UI, same rule underneath, can be added later); decrypt account numbers for an exact match (widens use of the reveal path, DL-0083).
- ADR: none · Status: accepted

### DL-0127 — camt.052 and camt.054 are recognised and refused with a reason, not imported
- Date: 2026-10-25 · By: claude · Task: T-0059 · Category: scope
- Decision: `detectFormat` and the camt reader recognise the camt.052 (intraday report) and camt.054 (debit/credit notification) namespaces, and any other camt message. They refuse them with a message that says why and asks for the end-of-day camt.053. Before this, such a file fell back to CSV and failed on the column mapping. These messages are not imported.
- Why: RQ-0028. No source shows CBA, Westpac, NAB or ANZ offering camt.052/054 to SMB customers: there are only SWIFT and host-to-host listings, seen as search-result text only; ANZ Transactive Global has no ISO 20022 support yet; nothing was found for CBA. camt.052 entries are provisional. camt.054 carries no balances, so the balance check cannot guard the import, and its entries repeat in the day's camt.053. `bank_statement.format` cannot be widened in place (forward-only migrations).
- Alternatives: import camt.054 as notifications (needs a new format column or table, and dedupe across message types); import booked camt.052 entries (puts provisional data into reconciliation). Revisit with a new card when a customer's bank sends only camt.054.
- ADR: none · Status: accepted

### DL-0128 — Parallel round 4: T-0015 (SoD) and T-0025 (generic posting pipeline)
- Date: 2026-10-25 · By: claude (lead) · Task: T-0015, T-0025 · Category: process
- Decision: Round 4 runs T-0015 (segregation-of-duties engine and small-team mode: apps/api authz + migration 0021, security ADR Proposed) and T-0025 (posting engine pipeline: packages/ledger, migration 0022 only if needed) in worktrees with pre-assigned numbers and per-agent scratchpads. T-0025 builds only the generic single write path (idempotent command, validation, resolve by system role/account, in-memory invariants, >4-decimal refusal from DL-0074, one transaction writing journal + lines + outbox placeholder). It implements no event-specific posting rule (invoice, receipt …), because every golden posting in Docs/accounting/postings.md is still Draft (AGENTS.md: posting behaviours need an Approved golden posting). T-0016 waits for T-0015 (same roles/authz code).
- Why: Product owner's instruction to keep building independent tasks in parallel; golden-posting gate respected.
- ADR: none · Status: accepted

### DL-0129 — SoD engine: rules as data, evaluated in TenantInterceptor after MFA, permission and step-up
- Date: 2026-10-25 · By: claude · Task: T-0015 · Category: security
- Decision: Segregation of duties (design §6.5 rules 1–6 and the SoD cells of §6.4) is a table of rules in `packages/shared/src/sod/rules.ts` and a pure `evaluateSod` returning allow | deny(rule) | allow_with_exception. Routes declare `@SoD('<subject>.<step>', subjectFrom)`; `TenantInterceptor` evaluates it after the MFA, permission and step-up checks and refuses with 403 `{error:'sod_violation', rule}`, audited as `sod_violation` in its own transaction. A route declares a step id, not a rule id (deviation from the task brief's `@SoD('rule-id', …)`): every rule of that step is evaluated, so a route cannot omit one. Unknown subject amounts fail closed (treated as above the threshold). The 403 body also carries `small_team_exception_required`. The admin routes `/sod/settings` and `/sod/exceptions/weekly/acknowledge` are naturally idempotent (posting unchanged settings, or acknowledging a week with nothing new, returns 200 and writes no row), because no idempotency-key infrastructure exists yet.
- Why: one central, reviewable check (apps/api/AGENTS.md; ADR-0023 hook point); same refusal path as T-0012/T-0013.
- Alternatives: checks in module services (forgettable); database triggers per business table (tables do not exist yet; rules written twice); rule-id decorators (a route could forget a rule).
- ADR: ADR-0026 · Status: proposed (awaiting human)

### DL-0130 — Append-only SoD action ledger, settings history, exceptions and weekly acknowledgements (migration 0021)
- Date: 2026-10-25 · By: claude · Task: T-0015 · Category: security
- Decision: Migration `0021_auth_sod.sql` adds `app.sod_action` (who did which step on which subject, with amount and request id), `app.sod_settings` (history, latest wins), `app.sod_exception` (small-team exceptions) and `app.sod_exception_ack` (Owner's weekly acknowledgement). All tenant-owned with RLS ENABLE + FORCE, `tenant_isolation`, `lf_app` SELECT/INSERT only, and triggers refusing UPDATE/DELETE for every role. Settings, exceptions and acknowledgements are checked (Owner via `settings.sod.manage`; reviewer active and not the actor) and audited by trigger; triggers skip rows of another tenant so RLS refuses them with 42501. The interceptor takes a transaction advisory lock per subject before reading its history.
- Why: SoD evidence must outlive edits to business rows and be impossible for the application to rewrite (directive 6, design §6.8); `lf_app` cannot read `audit.audit_log`.
- Alternatives: derive history from the audit log (no SELECT; request-shaped); columns on future business tables (do not exist yet; editable).
- ADR: ADR-0026 · Status: proposed (awaiting human)

### DL-0131 — SoD thresholds are tenant settings with the design's placeholder defaults (open decision §11.2)
- Date: 2026-10-25 · By: claude · Task: T-0015 · Category: scope
- Decision: Defaults: bill self-approval above 1,000.0000; credit-note self-approval above 1,000.0000 (§6.4 names no number — placeholder chosen equal to bills); manual-journal approval above 5,000.0000; two releasers above 10,000.0000; small-team mode off; weekly report time zone Australia/Sydney. "Above" means strictly greater. Only the Owner (new permission `settings.sod.manage`) changes them, with a reason. These values are placeholders and are listed for the product owner.
- Why: design §6.5 shows defaults; §11.2 lists SoD thresholds as an open decision, so they must be configurable and flagged, not decided by an agent.
- Alternatives: hard-coded constants (not configurable); Finance Admin may change them (an adviser weakening the controls that bind them — left for the human).
- ADR: ADR-0026 · Status: proposed (awaiting human)

### DL-0132 — Small-team mode: only when no other eligible person exists; external reviewer or recorded exception; period reopen never excepted
- Date: 2026-10-25 · By: claude · Task: T-0015 · Category: security
- Decision: A rule that would deny is excepted only when small-team mode is on, the rule allows exceptions, and no other active user of the tenant holds the route's permission. The request must then carry `sod_exception` with a reason and either an external reviewer (another active user, named) or none (recorded exception); one `app.sod_exception` row is written with the action, and it appears on the weekly report until and after the Owner acknowledges the week. Without it: 403 sod_violation with `small_team_exception_required: true`. If another eligible person exists, the conflict is denied even in small-team mode. Rule 6 (period reopen) allows no exception, matching migration 0018. Interpretation of "external reviewer" (a named reviewer, not a second approver) is listed for the product owner.
- Why: design §6.5 "the control is weakened visibly, never silently"; §6.3 small-team mode for fewer than 3 users.
- Alternatives: exceptions whenever small-team mode is on (weakens controls that can be satisfied); require the reviewer to hold the approving permission (then they are eligible and no exception is needed).
- ADR: ADR-0026 · Status: proposed (awaiting human)

### DL-0133 — Business endpoints get SoD by declaration; stand-in routes prove the contract
- Date: 2026-10-25 · By: claude · Task: T-0015 · Category: process
- Decision: Bills, payment batches, bank-detail changes and credit notes do not exist yet. `apps/api/src/sod/sod.db.test.ts` mounts test controllers declared exactly as the owning tasks must (`@RequirePermission` + `@SoD('bill.enter'| 'bill.approve', …)` etc.); the checks, refusals, ledger rows, exceptions and audit rows are the real ones (as T-0012/T-0013, DL-0104). Owning tasks must apply: T-0052 (`bill.enter`, `bill.approve`), T-0054 (`payment_batch.create`, `.approve`, `.release`, and `releasersRequired` for two releasers), T-0037 (`bank_detail_change.request`, `.verify`), T-0045 (`credit_note.create`, `.approve`), the manual-journal and posting-rule tasks (`manual_journal.post`/`.approve`, `posting_rule`/`tax_code` `.author`/`.activate`), payroll (`net_pay_batch.create`/`.release`). Register rows are green for the SoD layer only, naming the owning task.
- Why: prove the engine end to end now; keep the business tasks' contract explicit.
- Alternatives: wait for the business endpoints (blocks T-0016 and leaves the engine unproven).
- ADR: ADR-0026 · Status: accepted

### DL-0134 — T-0025 builds the generic posting pipeline only; no event posting rules while golden postings are Draft
- Date: 2026-10-25 · By: claude · Task: T-0025 · Category: scope
- Decision:
  - `packages/ledger` gets `post(trx, command, { outbox })` and `preview(trx, command)` (posting-engine.ts) over a **raw** posting command (posting-command.ts): company, idempotency key, date, source type, optional source id, memo, `createdBy`, `periodOverride`, and lines that already name the account (system role or account id), debit or credit in base currency, transaction currency/amount/rate, tax code id and tax amount, dimension values, party and memo.
  - Every golden posting in `Docs/accounting/postings.md` is still **Draft**, so nothing here decides debits and credits for an event: no invoice/receipt/bill/payout/payroll/reversal rule, no tax calculation, no FX conversion (the given rate is carried), no rounding to ROUNDING. `Docs/accounting/postings.md` is not edited. The event rules are built by their own tasks once each GP is Approved.
  - `preview` takes the transaction as well (`preview(trx, command)`), because validation and resolution read the chart, parties, dimensions and periods; it runs steps 1, 3, 4, 5 and never writes (proved in a READ ONLY transaction).
  - No migration: `journal_entry` already has `UNIQUE (tenant_id, company_id, idempotency_key)` (0007), so 0022 is not used.
  - Errors are typed: `PostingError` (code + 1-based line) for command, account, party, dimension, series and idempotency refusals; `PeriodLockedError` (T-0023) for NO_PERIOD / PERIOD_LOCKED.
  - Left as named hooks: `PostingOutbox` / `NO_OUTBOX` (T-0030 transactional outbox; runs inside the write and a throw undoes the post); subledger entries and `account_balance` (T-0027) are marked in the write step; approvals are not checked (no approval model yet).
- Why: design §3.9 single write path; AGENTS.md and packages/ledger/AGENTS.md (posting behaviour only with an Approved GP); DL-0128 round-4 scope.
- Alternatives: implement GP-001 etc. as "proposed" behaviour (rejected: human gate); `preview(command)` opening its own connection (rejected: the caller owns tenant context and transaction).
- ADR: none · Status: accepted

### DL-0135 — Journal entry numbers come from a per-source-type series `je_<source type>`
- Date: 2026-10-25 · By: claude · Task: T-0025 · Category: architecture
- Decision: The engine numbers each entry with `nextNumber(trx, company, entrySeriesFor(sourceType))`, where `entrySeriesFor(st) = 'je_' + st` (e.g. `je_manual_journal`, `je_ar_invoice`). A command whose series is missing or archived is refused (`NO_NUMBER_SERIES`) before anything is written. The number is taken inside the write savepoint, so a failed post returns it (gapless, T-0024). Document numbers (INV-…) stay the modules' own series, stored in `source_id`. Because `entry_no` is unique per company, the series of one company need distinct prefixes; creating them (with prefixes) belongs to company setup (wizard), not to the engine.
- Why: the task asks for "the series for the source type"; per-source-type series keep each journal type's numbers consecutive (auditors check gaps per journal), and the `je_` namespace cannot collide with document series codes.
- Alternatives: one `journal` series per company (simpler, one global sequence — open question for the product owner, see HANDOVER via the lead); auto-creating series on first post (rejected: prefixes are a setup decision; silent defaults collide on `entry_no`).
- ADR: none · Status: accepted (open question to the human: one series per company vs per source type, and default prefixes)

### DL-0136 — Control accounts: which subledger may post to each control role
- Date: 2026-10-25 · By: claude · Task: T-0025 · Category: accounting
- Decision: A line on an account with `is_control` is accepted only if a control role bound to that account accepts the command's source type: `AR_CONTROL` ← every AR-class source type of the period matrix (`ar_*` and `payments_stripe_charge`, which credits AR in GP-003 Draft); `AP_CONTROL` ← `ap_*`; `PAYROLL_CLEARING` ← `payroll_*`. Anything else, including `manual_journal`, `payments_stripe_payout`, and a control account with no bound control role, is refused (`CONTROL_ACCOUNT`). `ledger_reversal` cannot be posted through a raw command at all (`SOURCE_TYPE_NOT_SUPPORTED`) until the reversal flow (GP-019, Draft) is built; reversals of AR/AP entries will need their own rule there.
- Why: design §3.2 ("control accounts accept postings only from their subledger, never from manual journals"); the period matrix (RQ-0026) is the existing list of source types and their classes.
- Alternatives: allow `ledger_reversal` on control accounts now (rejected: the original's subledger must be checked, which is GP-019 work); key the rule on the period class only (rejected: payroll is class `ap` for period purposes but must not post to AP control).
- ADR: none · Status: accepted (mapping reviewable by the product owner with the golden postings)

### DL-0137 — Idempotency: advisory lock on the key, replay the first result, conflict on reuse
- Date: 2026-10-25 · By: claude · Task: T-0025 · Category: architecture
- Decision: Per RQ-0030, `post` takes `pg_advisory_xact_lock(hashtextextended('lf.posting_idem:<tenant>:<company>:<key>', 0))` after the pure checks, then looks the key up. Found → the stored entry is returned as the result (`replayed: true`) **without validating or writing again** (a retry still gets its answer after a period is locked). If the stored entry has a different `source_type` or `source_id`, the key was reused for another document → `IDEMPOTENCY_CONFLICT`. If the write hits 23505 on the key (a writer outside the lock), the savepoint is rolled back and the winner replayed, or `IDEMPOTENCY_RACE` is raised outside Read Committed. The key is scoped per company (the existing unique key). A full payload fingerprint (same key, different lines) is not compared: it needs a stored command hash (an additive column) — left for the product owner / a follow-up card.
- Why: SS-PLAT-14; connectors redeliver (design §5.6). RQ-0030 experiment E1–E4.
- Alternatives: rely on the unique key alone (second caller gets an error, not the first result); SELECT … FOR UPDATE on a key table (needs a new table and migration).
- ADR: none · Status: accepted

### DL-0138 — Posting validation details and write atomicity
- Date: 2026-10-25 · By: claude · Task: T-0025 · Category: architecture
- Decision:
  - Amounts are plain non-negative decimal strings (no JS numbers, signs or exponents); at most 4 **significant** decimals, so `1.23450` is accepted as 1.2345 and `1.00005` is refused (`AMOUNT_SCALE`). Rates: at most 8 significant decimals (`RATE_SCALE`), at most 10 integer digits, greater than zero. Sums use `Money` (decimal.js); the in-memory balance check runs before the first SQL statement (proved with a transaction stand-in that throws on use).
  - A base-currency line (no `txnCurrency`, or the base currency) is stored with rate 1 and `txn_amount` = the base amount; a different rate or amount is refused. A foreign-currency line needs both `txnAmount` and `fxRate`; the engine stores them as given and does not recompute base amounts. An account with a currency restriction takes only lines in that currency.
  - Party: must be an active party of the same company. Dimensions: values of the company, active, one per dimension; the account's required dimensions are checked in the validate step (also in preview) and again with `app.dimension_set_missing_required` after the set is created.
  - Period: `resolvePostingDate` (T-0023) with `withOverride` when the command has `periodOverride`; the engine then records the override (`recordPeriodOverride`, granted by `createdBy`, who must hold `period.lock.override`, else the database refuses). Under the lock-date policy `post_to_first_open_date_with_note` the entry is dated on the first open date and the policy note is appended to the memo (new line).
  - The write runs under `SAVEPOINT lf_posting` in the caller's transaction: on any error it is rolled back and released, so nothing is written even if the caller catches the error and commits.
  - Step 5 (check on the built lines) re-checks lines and balance. Today build copies the checked amounts unchanged, so this check cannot fail; it is kept for the tax/FX/rounding line builders that will change amounts (an equivalent mutant in the T-0025 mutation run).
- Why: design §3.3, §3.4, §3.5, §3.9; DL-0074; ADR-0005 (money).
- Alternatives: accept JS numbers that are safe integers (rejected: one input type); reject trailing zeros beyond 4 decimals (rejected: no value is lost); compute base = txn × rate (rejected: FX conversion and its rounding are not specified until the FX golden postings are approved).
- ADR: none · Status: accepted

### DL-0139 — DL-0136 (control-account source types) and DL-0135 (journal numbering) need the product owner
- Date: 2026-10-25 · By: claude (lead, at the T-0025 merge) · Task: T-0025 · Category: accounting
- Decision: DL-0136 decides which source types may post to each control account: AR control ← every AR-class source type, including the Stripe charge; AP control ← ap.*; payroll clearing ← payroll.*. It is logged as accepted, but it is an accounting choice, so treat it as proposed (awaiting human) until the product owner confirms it; the engine enforces it meanwhile. DL-0135 (one entry-number series per source type, `je_<source type>`, rather than one per company) is likewise put to the human. Neither changes any golden posting.
- Why: AGENTS.md §6: accounting-category choices go to the product owner; design §3.2 says control accounts accept postings only from their subledger but doesn't list the source types.
- ADR: none · Status: proposed (awaiting human)


### DL-0140 — Parallel round 5: T-0016, T-0027, T-0030, T-0053
- Date: 2026-10-25 · By: claude (lead) · Task: T-0016, T-0027, T-0030, T-0053 · Category: process
- Decision: Round 5 runs four tasks in worktrees branched from the round-4 head. Each has pre-assigned numbers:
  - T-0016 (user lifecycle and scoped API tokens): migration 0022, DL-0141..0145, RQ-0031, ADR-0027, SS-PLAT-70..71.
  - T-0027 (account_balance maintenance): migration 0023, DL-0146..0150, RQ-0032, ADR-0028, SS-PLAT-66..67.
  - T-0030 (transactional outbox + pg-boss worker): migration 0024, DL-0151..0155, RQ-0033, ADR-0029, SS-PLAT-68..69.
  - T-0053 (bank-detail change verification + cooling-off): migration 0025, DL-0156..0160, RQ-0034, ADR-0030.
  - Lead: DL-0161+, SS-PLAT-72+.

  Skipped this round:
  - T-0095: CI security gates are human-only (AGENTS.md §5).
  - T-0103: needs Windows.
  - T-0026, T-0028 and T-0029: they edit the same posting-engine code as T-0027/T-0030. They go next round.
  - T-0108: Phase 1; MVP tasks first.
  T-0027 and T-0030 change only the generic engine (no event posting rule) while golden postings are Draft.
- Why: Product owner's instruction to build independent tasks in parallel. One engine-touching pair per round keeps merge conflicts small.
- ADR: none · Status: accepted

### DL-0141 — Scoped personal API tokens: split-token, SHA-256, scopes ∩ owner, never step-up (ADR-0027)
- Date: 2026-10-25 · By: claude · Task: T-0016 · Category: security
- Decision: Personal API tokens `lfpat.<tenant>.<id>.<secret>` (32 random bytes), stored as SHA-256 only, sent only as `Authorization: Bearer` (a cookie plus an Authorization header is refused). Scopes are catalogue permissions minus `TOKEN_FORBIDDEN_SCOPES` (every step-up permission, user/role administration, SoD settings, subscription), a subset of the owner's permissions at issue; at each request permissions = scopes ∩ the owner's current role permissions. Issuing needs a session with a fresh MFA step-up (300 s), so the MFA-role rule is met by the token later; a token never satisfies a step-up and cannot mint tokens. SoD treats the owner as the actor. Expiry 1–366 days (default 90), last use tracked, revoke once, never deleted. Audit rows of token requests carry `audit.audit_log.api_token_id` (new nullable column). App tokens for the Integration role are left to the connector tasks.
- Why: RQ-0031 (OWASP Session Management, Password Storage, REST, Authorization cheat sheets; ASVS 5.0 V7; GitHub fine-grained PATs); design §6.2.
- Alternatives: JWT tokens (rejected: revocation list needed anyway, scope frozen at issue); argon2/bcrypt hash (rejected: 256-bit secret, slow hash only adds latency); tokens without step-up at issue (rejected: an MFA bypass for finance roles).
- ADR: ADR-0027 · Status: proposed (awaiting human)

### DL-0142 — Leaver revocation is a database trigger; disabled is never re-activated
- Date: 2026-10-25 · By: claude · Task: T-0016 · Category: security
- Decision: When `app.app_user.status` becomes `disabled`, trigger `app_user_offboard` revokes every open session (`user_disabled`), every active API token and every active role grant (`leaver`, revoked_by = disabled_by), the guard bumps `session_epoch` and stamps `disabled_at`, and one `user.disabled` audit row records the counts. `disabled → active` is refused for every role; `disabled → invited` (re-invite through the joiner gate) is allowed. `disabled_by` and the reason are required by the API, not the database, so an older path that only sets the status (session.db.test.ts does) still revokes everything. A disabled user gets no role grant, except from a superuser (test data, as 0021). Offboarding needs no step-up (it only removes access). Session and token verification also check that the owner is active, which covers a session or token committed concurrently with the offboard.
- Why: ASVS 7.4.2; directive 6 (nothing deleted); "no path can forget it" as 0016 did for role changes.
- Alternatives: revoke in the controller only (rejected: forgettable); make disabled terminal (rejected: the unique e-mail index would block a rehire).
- ADR: ADR-0027 · Status: accepted

### DL-0143 — "Reassign pending approvals": successor + `app.approval_assignee`, report what exists
- Date: 2026-10-25 · By: claude · Task: T-0016 · Category: scope
- Decision: No table yet assigns an approval to a named person (bills T-0052, payment batches T-0054 are not built; period-reopen requests wait for *any* other `period.reopen` holder and are immutable; SoD exceptions are recorded after the fact). T-0016 therefore records an optional successor on offboarding (an active user of the tenant, not the leaver), provides `app.approval_assignee(user)` that follows successors of disabled users to an active user (NULL if none), and reports the leaver's pending period-reopen requests in the offboard response. T-0052 and T-0054 must route approvals through `app.approval_assignee`.
- Why: RQ-0031 finding 8; design §6.3 leaver step 3.
- Alternatives: a generic approval-assignment table now (rejected: speculative, no consumer); cancelling the leaver's reopen requests (rejected: immutable history, and another holder can still approve).
- ADR: ADR-0027 · Status: accepted

### DL-0144 — Mover SoD: no self-grant; no forbidden role combinations (question for the product owner)
- Date: 2026-10-25 · By: claude · Task: T-0016 · Category: security
- Decision: The SoD check on a role change is requester ≠ beneficiary: nobody grants a role to themselves (API 403 `self_grant`, audited `self_grant_refused`; database trigger 42501). No combination of roles is blocked, because design §6.4 defines none, the Owner holds every permission, and per-item SoD (ADR-0026) already stops self-approval. Whether some combinations (e.g. AP Clerk + Approver) should be blocked or need a documented exception is put to the product owner.
- Why: design §6.3 mover step 2, §6.5 (requester ≠ verifier); RQ-0031 finding 7.
- Alternatives: block AP Clerk + Approver and similar (rejected for now: not in the design, breaks small teams; human decision).
- ADR: ADR-0027 · Status: proposed (awaiting human) — for the combinations question only

### DL-0145 — Joiner details: MFA before first access for MFA roles, welcome event, invite shape
- Date: 2026-10-25 · By: claude · Task: T-0016 · Category: security
- Decision: `POST /users` (users.manage, plus the permission to assign each role) creates an `invited` user bound to (idp_issuer, idp_subject) — no just-in-time accounts (ADR-0016) — with role grants by the inviter (`invited_by`). At the first OIDC login a user whose roles need MFA (ADR-0025 list) is activated only by an MFA authentication; otherwise 403 `mfa_enrolment_required`, audited `login_refused`, user stays invited. Activation writes `user.joined` (roles, amr). Users whose roles need no MFA are activated by any login. A "last Owner" check on offboarding is not needed: only the Owner holds `users.manage`, and self-offboarding is refused, so an active Owner always remains.
- Why: design §6.2 (which roles need MFA) and §6.3 joiner steps 1–4.
- Alternatives: MFA for every joiner (rejected: contradicts §6.2's role list; ADR-0025 enforces per role).
- ADR: ADR-0027 · Status: accepted

### DL-0146 — account_balance is maintained by the database in the writer's transaction
- Date: 2026-10-25 · By: claude · Task: T-0027 · Category: architecture
- Decision: Migration 0023 creates `app.account_balance` (lf_app: SELECT only) and keeps it with an AFTER INSERT FOR EACH STATEMENT trigger on `journal_line` (`REFERENCING NEW TABLE`), SECURITY DEFINER owned by lf_migrator: the inserted lines of non-draft entries are summed per key and upserted with `INSERT … ON CONFLICT DO UPDATE SET x = account_balance.x + EXCLUDED.x`, rows in key order. The engine inserts an entry's lines in one statement inside its `lf_posting` savepoint, so the balance update is part of the post and a failed post leaves no change. The engine's write step only gains a comment (T-0030 edits the same function).
- Why: RQ-0032 findings 2–6: atomic add under concurrency (no lost update, E1/E1b), deterministic lock order (no deadlock within an entry, E5), no `lf_app` write path at all (E6), and a write path that cannot be forgotten by future code. Proven by SS-PLAT-66/67.
- Alternatives: an explicit engine call to a SECURITY DEFINER function (callable by any lf_app code, needs its own "applied once" guard); granting lf_app UPDATE and upserting from TypeScript (gives lf_app a direct write path); read-then-write (loses updates, E2).
- ADR: none · Status: accepted

### DL-0147 — account_balance key includes the transaction currency
- Date: 2026-10-25 · By: claude · Task: T-0027 · Category: architecture
- Decision: The key is (tenant, company, account, period, dimension set, transaction currency). `debit_total`/`credit_total` are base-currency sums as in design §3.3; `txn_debit_total`/`txn_credit_total` add Σ `txn_amount` per side. A company's base balance per (account, period, dimension set) is the sum over currencies. No ADR: the table is in the design; the extra key column refines it without changing any accounting treatment. Flagged to the lead in the T-0027 report in case the product owner wants an ADR.
- Why: the lead's T-0027 brief ("per company/account/period/dimension set/currency"); design §3.7 (foreign-currency balances are needed for revaluation and multi-currency reports); RQ-0032 finding 1.
- Alternatives: base totals only (the design's minimum; a foreign-currency balance would then need a full scan of the journal).
- ADR: none · Status: accepted

### DL-0148 — Which lines count, and the accumulate-only guard
- Date: 2026-10-25 · By: claude · Task: T-0027 · Category: architecture
- Decision: Only lines of non-draft entries count. A row trigger (AFTER UPDATE OF status, draft → non-draft; owner only today) adds an entry's lines when it leaves draft. posted → reversed changes nothing (the reversal is its own entry). Lines of another tenant, or written with no tenant set, are skipped (the functions run under FORCE RLS; superuser writes are outside the application). A BEFORE UPDATE/DELETE trigger lets an update only increase totals with the key unchanged and refuses DELETE; TRUNCATE is refused (`app.ledger_no_truncate`). This binds the owner too.
- Why: posted lines are immutable (0008), so a balance can only grow; RQ-0032 findings 7–8; the cross-tenant protocol (triggers skip other-tenant rows).
- Alternatives: count drafts and subtract on change (drafts are not in the ledger); no guard (the owner could silently rewrite a balance).
- ADR: none · Status: accepted

### DL-0149 — Reading balances: trialBalance() and the accountBalanceDrift() verifier
- Date: 2026-10-25 · By: claude · Task: T-0027 · Category: architecture
- Decision: `packages/ledger/src/account-balance.ts` adds `trialBalance(trx, companyId)` (one row per account, base debit/credit summed over periods, sets and currencies) and `accountBalanceDrift(trx, companyId)` (every key where account_balance differs from the sum of posted lines, either side missing included), both plain read-only SQL with exact NUMERIC text. `packages/db/src/schema.ts` gets `AccountBalanceTable` with every column non-insertable and non-updatable, and the cross-tenant generator gets a currency override for the new table (`DEFAULT_ROW_OVERRIDES`).
- Why: reports read from account_balance (design §3.3); the verifier is the property test's oracle (INV-balance-table) and an audit tool that detects tampering (proved by SS-PLAT-66).
- Alternatives: a SQL function for the verifier (one more database object, no benefit); period-filtered trial balance now (no report task yet; added with the TB report task).
- ADR: none · Status: accepted

### DL-0150 — The concurrency test spreads postings over eight number series
- Date: 2026-10-25 · By: claude · Task: T-0027 · Category: process
- Decision: SS-PLAT-67 posts 36 entries on 12 connections across eight source types (eight `je_<source>` series), half debiting A and crediting B, half the reverse, each holding its row locks 20 ms before commit. The mutation check records that a read-then-write balance update survives a one-series test (numbering serialises a series) but is killed with eight series.
- Why: RQ-0032 finding 9: a single-series test cannot see a lost update, so it would prove nothing about the balance upsert.
- Alternatives: several companies (no shared balance rows, so no contention); a test-only hook inside the trigger (production code for tests).
- ADR: none · Status: accepted

### DL-0151 — pg-boss 12.37.1 and @opentelemetry/api 1.9.1; new packages packages/outbox and apps/worker
- Date: 2026-10-25 · By: claude · Task: T-0030 · Category: tooling
- Decision: Pin `pg-boss` 12.37.1 (2026-10-08) and its required peer `@opentelemetry/api` 1.9.1 exactly. The new workspace package `packages/outbox` (`@ledgerforce/outbox`) holds the producer, consumer, queue config and test harness. `apps/worker` (`@ledgerforce/worker`) gets its first `package.json`; it holds the consumer process and queue administration, and depends on `pg` 8.23.1, which is already in the lockfile. `packages/ledger` exports `./testing` (the journal fixture) for the outbox db tests. Every package added to the lockfile is at least 15 days old (RQ-0033 S1).
- Why: ADR-0008 (Accepted) is the dependency ADR for pg-boss, so no new ADR is needed. 12.38.0 is 11 days old, which breaks the 14-day rule (DL-0061). The OpenTelemetry API is imported statically by pg-boss, so it is pinned rather than left to pnpm's peer auto-install. The outbox has its own package because both the API (producer) and the worker (consumer) need it, and apps must not import apps.
- Alternatives: pg-boss 12.38.0 (too new). Putting the outbox in `packages/ledger` (rejected: it would make the ledger depend on pg-boss and mix non-ledger tables into the ledger package). Putting everything in `apps/worker` (rejected: the API would have to import an app).
- ADR: ADR-0008 · Status: accepted

### DL-0152 — Outbox: event row and pg-boss job in the caller's transaction; per-handler inbox; no relay scan
- Date: 2026-10-25 · By: claude · Task: T-0030 · Category: architecture
- Decision: `enqueue(trx, boss, msg)` inserts `app.outbox_event` and sends a pg-boss job through the caller's transaction (`fromKysely(trx)`). For a posting, that is inside the engine's `SAVEPOINT lf_posting`. The job id is the event id and the payload is `{ tenantId, eventId }`. `ledgerOutbox(boss)` implements the engine's existing `PostingOutbox` hook with topic `ledger.entry.posted` and aggregate `journal_entry`. On the consumer side, `deliver` runs each handler of the event's topic in its own `withTenant` transaction. It inserts `app.outbox_inbox (event, handler)` with `ON CONFLICT DO NOTHING` and runs the handler only when the row is new, so the effect commits with its inbox row. The engine is unchanged apart from a doc comment: its default stays `NO_OUTBOX`, and production callers pass `ledgerOutbox(boss)`.
- Why: Design §3.9 says "outbox and jobs commit atomically with postings". RQ-0033 E3 proved that a pg-boss send joins a Kysely transaction. Writing the job together with the row removes the need for a relay that polls outbox rows. Such a relay would have to see every tenant, but `lf_app` sees one tenant per transaction, so it would need a new privileged cross-tenant read path (a security ADR). ADR-0008 rule 2's "relay reads committed outbox events" is therefore met by the worker consuming jobs that committed with their events. The relay's polling step is unnecessary, and nothing is lost: an event row cannot commit without its job.
- Alternatives: A relay with a `relayed_at` flag (rejected: cross-tenant scan, mutable outbox rows, polling lag). One inbox transaction for all handlers of an event (rejected: one failing handler would replay the others). Making the outbox mandatory in `post()` (not done here: it changes the engine's signature while T-0027 edits the same file; it goes to the lead as a follow-up).
- ADR: ADR-0008 · Status: accepted

### DL-0153 — pg-boss role model: schema owned by lf_migrator, lf_app DML only, supervision as owner
- Date: 2026-10-25 · By: claude · Task: T-0030 · Category: security
- Decision: Migration 0024 creates schema `pgboss` with `AUTHORIZATION lf_migrator`, grants `USAGE` to `lf_app`, and sets default privileges so that `lf_app` gets SELECT/INSERT/UPDATE/DELETE on tables `lf_migrator` creates there, and USAGE/SELECT on its sequences. `lf_app` gets no CREATE, TRUNCATE or TRIGGER. pg-boss's tables and the outbox queues are installed by pg-boss itself as `lf_migrator`, through `installQueue` and the `install-queue` CLI, at deploy right after `migrate`; it refuses any other role. Runtime instances (`lf_app`) run with `migrate`, `supervise`, `schedule` and `registerInstance` off. Supervision (expiring crashed workers' jobs, retention, stats partitions, reindex) is DDL and runs on an owner instance (`startMaintenance`).
- Why: RQ-0033 findings 3–4. pg-boss's construction SQL contains `DROP TABLE` inside `pgboss.delete_queue`, which the runner rightly refuses, and pg-boss versions its own schema. DELETE is needed because pg-boss moves failed and retried jobs by deleting and re-inserting them (found by the acceptance test). These rows are queue state, not tenant records; the event stays append-only. ADR-0008 rule 5 is kept.
- Security implications (for the product owner):
  - (a) The pgboss tables have no RLS, and `lf_app` can read, change and delete any tenant's jobs. Mitigation: payloads hold ids only; events are read under RLS; a forged tenant id finds nothing (SS-PLAT-24 test). A lost job leaves an event with no inbox row, which can be detected; a re-send sweep is a follow-up.
  - (b) `lf_app` can create non-partitioned queues through `pgboss.create_queue`, because EXECUTE is granted to PUBLIC. It cannot run DDL.
  - (c) Production supervision needs a long-running process holding `lf_migrator` (DDL owner) credentials. A dedicated owner role would narrow this, but it is a bootstrap change, which is a security ADR and a human gate. It was not built.
- Alternatives: Commit pg-boss's SQL as a migration (rejected: DROP inside a function body, and version lock-in). Let `lf_app` install at start-up (rejected: ADR-0008 rule 5, and it would need CREATE). Run supervision as `lf_app` (impossible: it is DDL).
- ADR: ADR-0008 · Status: proposed (awaiting human) for (c), the maintenance credentials; the rest is built as described.

### DL-0154 — Outbox tests: pg-boss TestClock shared by the owner and lf_app sessions; crash = effect committed, job never acknowledged
- Date: 2026-10-25 · By: claude · Task: T-0030 · Category: tooling
- Decision: Tests drive pg-boss time with its `TestClock`. The owner instance attaches it, which is DDL on `pgboss.job_now()`. `lf_app` instances and the Kysely pool used for posting opt in with the `pg` startup option `-c pgboss.test_clock=on`; the lf_app pg-boss instances receive the clock's timers without `attach`. SS-PLAT-24's "worker crash after send" is simulated as follows: a runtime instance fetches the job, `deliver` commits the handler's effect, and the instance stops without completing the job. Time then moves past `expireInSeconds` and the first backoff step, the owner runs `supervise`, and a new worker process receives the same job id with `retryCount` 1. The test-only downstream table `lf_test.effect` has no unique key, so a duplicate effect would show. The posted "invoice" of the card is a raw manual journal, because no event posting rule exists while golden postings are Draft. Migrations 0022 and 0023 were scratchpad placeholders at test time and were never committed.
- Why: apps/worker AGENTS.md says "no sleep-based waits; drive time with fake timers or job-queue test helpers". RQ-0033 E4 and the clock note.
- Alternatives: `expireInSeconds: 1` with real waiting (rejected: sleeps and flaky); calling `fail()` to simulate the crash (rejected: a crash does not fail the job); updating pg-boss rows directly (rejected: depends on pg-boss internals).
- ADR: none · Status: accepted

### DL-0155 — Outbox queue policy: backoff 1 min to 6 h over 10 retries, 5 min lease, 400-day retention, dead-letter queue
- Date: 2026-10-25 · By: claude · Task: T-0030 · Category: architecture
- Decision: Queue `outbox.deliver` uses `retryLimit` 10, `retryDelay` 60 s, `retryBackoff` true, `retryDelayMax` 21,600 s, `expireInSeconds` 300 and `deadLetter` `outbox.deliver.dead`. Both queues use `retentionSeconds` of 400 days; pg-boss's default of 14 days would silently drop undelivered jobs. A job expired after a crash counts as a failed attempt, so it waits out the backoff (first step 60–120 s with jitter). The dead-letter queue is where the Sync issues inbox (design §5.6) will read exhausted deliveries; that UI and its one-click retry are follow-up work.
- Why: apps/worker AGENTS.md ("exponential backoff from 1 min to 6 h, then a Sync issues inbox entry"); RQ-0033 E4. With 10 retries the 6-hour cap is reached, since 60 s × 2⁹ exceeds 6 h.
- Alternatives: heartbeats (`heartbeatSeconds`, which must be at least 10 s) instead of the lease (deferred until long handlers exist); the default 15-minute lease (rejected: a slower recovery for short jobs).
- ADR: none · Status: accepted

### DL-0156 — Bank-detail change workflow enforced in the database (RQ-0034, ADR-0030)
- Date: 2026-10-25 · By: claude · Task: T-0053 · Category: security
- Decision: RQ-0034 is resolved. Migration 0025 adds `app.bank_detail_change` (requested → verified | rejected), written only by SECURITY DEFINER functions; `lf_app` has SELECT only. Requester ≠ verifier (`SOD_BANK_DETAIL_SELF_VERIFY`) is checked again at COMMIT by a deferred constraint trigger, which accepts a self-verification only with small-team mode on and a recorded `app.sod_exception` for that change and actor. The request and verify functions also check the acting session's step-up (own, live, current epoch, MFA, `auth_time` ≤ 300 s by the database clock). A guard on `app.party_bank_account` makes new rows `pending_verification`, allows `active` only with a verified change, keeps `superseded`/`archived` final, and allows one active account per party.
- Why: design §6.1, §6.2 and §6.5 rule 2. Migration 0012 let `lf_app` insert or switch an account to `active` with no verification (the T-0053 RED test proved it). The PostgreSQL 16.15 spike in RQ-0034 S6 showed that the deferred check sees the exception row written after the handler, and that FORCE RLS still applies to the definer.
- Alternatives: API-only checks (rejected: any other code path could activate an account); checking requester ≠ verifier inside the verify function (rejected: it would break the small-team exception, whose row is written after the handler).
- ADR: ADR-0030 · Status: proposed (awaiting human)

### DL-0157 — T-0053 scope: eligibility function for SS-UC06-05, durable notices, first account verified too
- Date: 2026-10-25 · By: claude · Task: T-0053 · Category: scope
- Decision:
  - Payment batches do not exist yet (T-0054). SS-UC06-05 is proven at database/service level with `app.party_payment_eligibility(uuid[])` and `paymentEligibility()`, which T-0054 must call; the exclusion reason is `BANK_DETAILS_COOLING_OFF` (or `NO_VERIFIED_BANK_DETAILS`). The SS-UC06-05 row keeps T-0054 as a task.
  - There is no notification channel yet, and T-0030 (outbox) is being built in parallel. Verification writes durable `app.bank_detail_change_notice` rows (masked details, `pending`, or `no_recipient` when no remittance contact had an email), in the same transaction. A later dispatcher may only record delivery.
  - "Previous remittance contact" means the contacts holding an active remittance role, with an email, when the change is **requested** (snapshot), notified when it is verified.
  - The first bank details of a party also need a verified change and the cooling-off.
- Why: lead's brief; RQ-0034 findings 3–5; RQ-0012 item 7 (b).
- Alternatives: depending on T-0030's outbox (rejected: not on this base); notifying contacts as they are at verification (rejected: whoever made the change may have edited the contact, and the M8 mutant proves the test catches it); verifying only changes, not first details (rejected: an unverified first account would be payable at once). Product owner to confirm the first-details reading.
- ADR: ADR-0030 · Status: proposed (awaiting human)

### DL-0158 — Cooling-off length is tenant configuration, frozen at verification
- Date: 2026-10-25 · By: claude · Task: T-0053 · Category: security
- Decision: `app.bank_detail_settings` (insert-only history, latest row wins) holds `cooling_off_hours`, default 24, allowed 1–720. Only a user holding `settings.sod.manage` (Owner) may set it; each change is audited (`bank_detail.settings_changed`). Verification copies the hours in force onto the change and sets `payable_from = verified_at + hours` with the database clock, so a later change does not shorten a running cooling-off. Module: `setBankDetailCoolingOff`. No API route yet.
- Why: design §6.5 ("configurable thresholds, default values shown"), and the lead's brief ("configuration, not a constant; use the database clock"). SoD thresholds are an open decision of design §11.2 (DL-0131), so the 1 h minimum and the 24 h default are placeholders for the product owner.
- Alternatives: a column on `app.sod_settings` (rejected: it would change T-0015's settings trigger and API shapes in a parallel round); recomputing from the current setting at payment time (rejected: an Owner could shorten a running cooling-off); allowing 0 h (rejected: it switches the control off silently).
- ADR: ADR-0030 · Status: proposed (awaiting human)

### DL-0159 — Bank-detail change API: routes, request path and optional KMS
- Date: 2026-10-25 · By: claude · Task: T-0053 · Category: architecture
- Decision: The API has three routes:
  - `POST /parties/:partyId/bank-accounts`: request. Needs `change_request`, step-up 300 s, and the SoD step `bank_detail_change.request`, whose subject is a change id chosen by the server before the handler runs.
  - `POST /bank-detail-changes/:changeId/verify`: needs `verify`, step-up 300 s, and the SoD step `bank_detail_change.verify`.
  - `POST /bank-detail-changes/:changeId/reject`: needs `verify`.

  Database refusals map to 400/401/403/404/409 as listed in ADR-0030. `createApi` takes an optional `kms` (`KMS` token). Without it, the request route answers 503 `kms_not_configured`. `main.ts` is unchanged.
- Why: The request is not at `/parties/:partyId/bank-detail-changes` because T-0013's `mfa-step-up.db.test.ts` mounts a stand-in route there. The real route would shadow it: the full run returned 503 instead of < 300, and existing tests are not changed. Adding a bank account always opens a change, so POST on the bank-accounts collection fits. The verify route declares `@RequireStepUp(300)` explicitly, although `STEP_UP_PERMISSIONS` would add it anyway (equivalent mutant M11).
- Alternatives: registering test controllers before the real ones in `app.ts` (rejected: it changes a shared test hook for every suite); a client-chosen change id (rejected: the server chooses ids).
- ADR: ADR-0030 · Status: proposed (awaiting human)

### DL-0160 — T-0053 build process: placeholders, harness edits, mutation run
- Date: 2026-10-25 · By: claude · Task: T-0053 · Category: process
- Decision:
  - Test runs used untracked scratchpad placeholders (`SELECT 1;`) for migrations 0022–0024, which belong to other round-5 branches. They were never committed.
  - The cross-tenant harness gained an override (`app.bank_detail_change_notice.status = 'no_recipient'`) and an Owner prerequisite for `app.bank_detail_settings`.
  - Mutation check: 11 hand mutants; 10 killed, and M11 (verify route without `@RequireStepUp`) survived as an equivalent mutant (the step-up permission default and the database check still refuse).
  - The RQ-0034 spike ran as an untracked vitest file, deleted after the run.
- Why: round-5 protocol (DL-0140); AGENTS.md §0 (prove it with evidence).
- Alternatives: none.
- ADR: none · Status: accepted

### DL-0161 — DL-0153 (pg-boss privileges) raised to a security ADR (ADR-0029, Proposed)
- Date: 2026-10-25 · By: claude (lead, at the T-0030 merge) · Task: T-0030 · Category: security
- Decision: The lead wrote ADR-0029 (Proposed, security, human gate) to record the job-queue privilege model built in migration 0024: lf_app gets DML (including DELETE) on the shared, non-RLS pgboss schema; job payloads hold ids only; supervision runs with lf_migrator credentials. The T-0030 agent had logged this as a decision against ADR-0008. T-0030 is merged and in review; the model stays Proposed until the product owner accepts it. A dedicated queue-owner role is the proposed narrowing.
- Why: AGENTS.md §6 and design §10.6: a change to the security model needs a security ADR, and the "no DELETE for lf_app" rule had applied everywhere until now.
- ADR: ADR-0029 · Status: proposed (awaiting human)


### DL-0162 — Parallel round 6: T-0026, T-0064, T-0076, T-0093
- Date: 2026-10-25 · By: claude (lead) · Task: T-0026, T-0064, T-0076, T-0093 · Category: process
- Decision: Round 6 runs four tasks in worktrees branched from the round-5 head, with pre-assigned numbers. A migration number is used only if needed; the lead closes any gap by renumbering unmerged files before merge.
  - T-0026 (posting preview): migration 0026, DL-0163..0166, RQ-0035, ADR-0031, SS-PLAT-15 (existing) and SS-PLAT-72..73.
  - T-0064 (CDC subscriber with a replay-id store): migration 0027, DL-0167..0171, RQ-0036, ADR-0032, SS-PLAT-27 (existing) and SS-PLAT-74..75.
  - T-0076 (TB, P&L and BS): migration 0028, DL-0172..0176, RQ-0037, ADR-0033, SS-UC10-08 (existing) and SS-PLAT-76..77.
  - T-0093 (UI for users, roles, SoD report and audit viewer): migration 0029, DL-0177..0181, RQ-0038, ADR-0034, SS-PLAT-78..80.
  - Lead: DL-0182+, SS-PLAT-81+.

  Not in this round:
  - T-0028 and T-0029 edit the engine alongside T-0026; they go next round.
  - T-0067 needs a scratch org for its e2e and shares the connector with T-0064.
  - T-0094 needs Docker.
  - T-0095 is human-only; T-0103 needs Windows; T-0108 is Phase 1.
- Why: Product owner's instruction to build independent tasks in parallel, with one engine-touching task per round.
- ADR: none · Status: accepted

### DL-0163 — Preview refuses what post refuses: createdBy and override permission checked before the write
- Date: 2026-10-25 · By: claude · Task: T-0026 · Category: architecture
- Decision: The engine's shared validate step now checks that `createdBy` is a user of the tenant (`UNKNOWN_USER`) and, when the date needs a period override, that the user holds `period.lock.override` (`OVERRIDE_NOT_PERMITTED`, message names the permission), before any write. Both are new `PostingErrorCode`s; post() therefore throws typed errors where it used to surface raw 23503 / 42501 from the write. The database foreign key and the `period_override_check` trigger stay as the last line of defence.
- Why: RQ-0035 findings 2a–2b: these were checked only by the database during the write, so preview (which has no write) accepted commands post refused. Design §3.9: preview powers "show me the journal"; it must not show a journal that cannot post.
- Alternatives: preview writes inside a savepoint and rolls back to reuse the database checks (rejected: sequences such as audit_log's identity are never rolled back, and it would take the number-series and chain-head locks; RQ-0035 finding 4); leave the gap and document it (rejected: the task requires the same errors).
- ADR: none (no accounting treatment, data model or security model change; additive error codes) · Status: accepted

### DL-0164 — Preview of a used idempotency key: ALREADY_POSTED or IDEMPOTENCY_CONFLICT
- Date: 2026-10-25 · By: claude · Task: T-0026 · Category: architecture
- Decision: preview() looks the key up as post() does, without the advisory lock (it writes nothing). A key that already posted this document → `PostingError('ALREADY_POSTED')` carrying `entryId` and `entryNo` (post() would replay that entry and write nothing, so there is no new journal to show; the caller shows the stored entry). A key used by another document → `IDEMPOTENCY_CONFLICT`, as post(). `PostingError` gained optional `entryId`/`entryNo`.
- Why: RQ-0035 findings 2c–2d: the base preview built a fresh journal for a key whose post() would replay or refuse.
- Alternatives: return the stored entry in preview's shape (rejected: requested date, redirect and override flags are not stored, so it would be an approximation, and it doubles the read path); return the built journal with an `alreadyPosted` flag (rejected: a replay does not validate again, so the built journal could carry errors the replay never raises).
- ADR: none · Status: accepted

### DL-0165 — "Writes nothing" is proven by a whole-database fingerprint, and parity by single-fault properties
- Date: 2026-10-25 · By: claude · Task: T-0026 · Category: process
- Decision: SS-PLAT-15 tests compare `databaseFingerprint` (packages/ledger/src/testing/db-fingerprint.ts: every ordinary/partitioned table in every non-system schema → count + order-independent md5 of the rows; every sequence → last_value; tables read from the catalogue) before and after preview, as the superuser. The pg-boss case lives in packages/outbox/src/preview.db.test.ts because packages/ledger cannot depend on packages/outbox (cycle). The parity property (SS-PLAT-72) generates valid commands with at most one fault each and asserts the expected code per fault. Test helpers `storedJournal`/`expectedJournal` are exported from `@ledgerforce/ledger/testing`.
- Why: RQ-0035 finding 6: a list of named tables goes stale when subledger_entry/allocation arrive and misses UPDATEs; a multi-fault generator let a mutant survive (only the first check is ever reached).
- Alternatives: per-table counts as in T-0025's snapshot (rejected: misses counter/head UPDATEs and future tables); pg_stat_xact counters (rejected: per-backend and not visible across connections).

### DL-0167 — Pub/Sub API client stack: grpc-js + proto-loader on the vendored proto, avsc for Avro
- Date: 2026-10-25 · By: claude · Task: T-0064 · Category: architecture
- Decision: The CDC subscriber talks gRPC with `@grpc/grpc-js` 1.14.6 and `@grpc/proto-loader` 0.8.1, loading `packages/connectors/salesforce/proto/pubsub_api.proto`, which is the forcedotcom file byte for byte (CC0-1.0, SHA-256 pinned by a contract test). Payloads decode with `avsc` 5.7.9 (no dependencies), Avro `long` as BigInt. All three are pinned exact, at least two weeks old, and `pnpm audit --prod` is clean. The local fake server used by tests is built from the same proto.
- Why: RQ-0036 F1, F5, F7. It is the reference stack (pozil/pub-sub-api-node-client), it is pure JS, and it decodes losslessly. A new runtime dependency needs an ADR (design §10.6).
- Alternatives: avro-js (Apache's avsc fork; older); protoc-generated code plus a hand-written Avro decoder; polling only (rejected, design §5.3).
- ADR: ADR-0032 · Status: proposed (Accepted on green CI + cross-review)

### DL-0168 — Replay cursor per (company, channel), moved by compare-and-set in the batch transaction
- Date: 2026-10-25 · By: claude · Task: T-0064 · Category: architecture
- Decision: Migration 0026 adds `app.salesforce_replay_cursor` keyed by (tenant, company, channel). It is not keyed by connection, so a key rotation keeps the cursor. The subscriber moves `replay_id` from the value this run last committed to the batch's last replay id in the same tenant transaction as the effects (row lock and compare-and-set; a mismatch raises `ReplayCursorConflict` and rolls the batch back). It requests more events only after the commit, at most `batchSize` (≤ 100) outstanding. With no stored id it subscribes from `LATEST`; an initial load is the reconcile job's work, not a 72 h `EARLIEST` replay that spends the event allocation. A keepalive with nothing in flight stores `latest_replay_id`, so a quiet channel stays inside the 72 h retention.
- Why: SS-PLAT-27 (resume from R with no loss or duplication), design §5.3; RQ-0036 F2, F3; the allocation limit (design §5.3).
- Alternatives: commit the replay id after the effects in a separate transaction (a crash between the two repeats or loses effects); key by connection id (rotation would lose the position); `EARLIEST` on first start (spends up to 72 h of the allocation).
- ADR: ADR-0032 · Status: accepted

### DL-0169 — Inbound idempotency key includes the sequence number; a separate Salesforce event inbox
- Date: 2026-10-25 · By: claude · Task: T-0064 · Category: architecture
- Decision: For each record, the CDC idempotency key is `cdc:<entity>:<record id>:<commit number>:<sequence number>`. An overflow event's key is `cdc:<entity>:overflow:<transaction key>:<sequence>`, and a platform event's key is `event:<uuid>`. Keys are stored in a new append-only table `app.salesforce_event_inbox`. `app.outbox_inbox` is not reused, because it references `app.outbox_event` ids. The handler only receives the event's records that it has not seen before.
- Why: Design §5.6 rule 1 says "record Id + commit number". One transaction can produce two events for the same record (for example, a create followed by an update), and these share a commit number but differ in `sequenceNumber` (RQ-0036 S7). Without the sequence number the second, legitimate event would be dropped. The inbox catches at-least-once redelivery and overlapping replays after a reset.
- Alternatives: record id + commit number only (would drop a legitimate second event); key by replay id (a re-published or replayed event gets a new replay id); rely on the cursor alone (does not cover redelivery).
- ADR: ADR-0032 · Status: accepted

### DL-0170 — Rejected replay id, gap and overflow events become resync requests, never guesses
- Date: 2026-10-25 · By: claude · Task: T-0064 · Category: architecture
- Decision: A Subscribe error whose `error-code` trailer is in the `sfdc.platform.eventbus.grpc.subscription.fetch.replayid.*` family (documented: `…replayid.corrupted`, INVALID_ARGUMENT) clears the stored replay id and inserts a `replay_id_invalid` row into `app.salesforce_resync_request` with `since` set to the last commit time. The run then ends with status `replay_reset`, and the next run starts at `LATEST`. A `GAP_*` event inserts a `gap_event` row with its records. A `GAP_OVERFLOW` event inserts an `overflow` row for its entity, because its record id is a placeholder. Neither kind of gap event is passed to the handler. The reconcile job (design §5.3, SystemModstamp delta) consumes these rows and sets only `resolved_at`. Auth, transient and other errors are thrown as `PubSubError` with a `kind` for the supervisor.
- Why: RQ-0036 F4 and F6. A gap event has no field data to apply, and the events between the last commit and a fresh `LATEST` are gone from the stream. Only a re-read from Salesforce can close the gap.
- Alternatives: resubscribe with `EARLIEST` (still loses anything older than 72 h and spends the allocation); retry the same replay id (it can never succeed); apply gap events as empty updates (wrong data).
- ADR: ADR-0032 · Status: accepted

### DL-0171 — T-0064 build notes: documented fixtures, 0026 placeholder, cross-tenant overrides, mutation check
- Date: 2026-10-25 · By: claude · Task: T-0064 · Category: process
- Decision:
  - The Pub/Sub fixtures are *documented*, not recorded: `fixtures/documented/pubsub-account-change-events.json`. They were generated by the committed script `pubsub-account-change-events.gen.mjs` from the documented `ChangeEventHeader` (RQ-0036 S7) and use 18-character test ids only. They will be replaced by scratch-org recordings later.
  - Migration 0026 does not exist on the round base. Tests used a `SELECT 1` placeholder from the scratchpad, which was never committed (round protocol).
  - The cross-tenant generator gained overrides for the three 0026 tables.
  - The mutation check is recorded on the card.
- Why: Round-6 protocol (DL-0162). AGENTS.md §0 directive 8.
- Alternatives: none.

- ADR: none · Status: accepted

### DL-0172 — Reports live in a new module `packages/modules/reporting`; ledger figures come from a read API in `packages/ledger`
- Date: 2026-10-25 · By: claude · Task: T-0076 · Category: architecture
- Decision: The TB, P&L and BS are in a new workspace package `@ledgerforce/reporting` (`packages/modules/reporting`), the *Reporting* module of design §8.1. It reads company, chart, system roles, fiscal years and periods itself, but every ledger figure comes from `accountMovements()` in `packages/ledger/src/account-balance.ts` (read-only, next to `trialBalance()`), so no SQL outside `packages/ledger` touches `journal_*`, `account_balance` or `dimension_set`. Statement shaping is pure (`statements.ts`); the database part is `reports.ts`. No migration (0028 unused) and no ADR (ADR-0033 unused): the package adds no third-party dependency (it uses `@ledgerforce/db`, `ledger`, `shared` and `kysely`, already in the workspace).
- Why: `packages/ledger/AGENTS.md` ("any SQL touching these tables outside this package is a defect"); design §7.3 module layout and §8.1 module catalogue; RQ-0037.
- Alternatives: reports inside `packages/modules/gl` (gl cannot depend on ledger — ledger already depends on gl for its fixture; a cycle); report SQL functions in a migration (more surface, no need: lf_app already has SELECT).
- ADR: none · Status: accepted

### DL-0173 — Report data source: whole periods from account_balance, cut periods from posted lines
- Date: 2026-10-25 · By: claude · Task: T-0076 · Category: architecture
- Decision: `accountMovements({ companyId, from?, to, dimensionValueIds? })` sums base-currency debit and credit per account. Periods wholly inside [from, to] are read from `account_balance`; a period the range cuts is read from its posted (non-draft) lines filtered by `entry_date`. `from` omitted = from the first period. A dimension filter keeps the dimension sets that contain **every** requested value (`value_ids @> filter`). The CTEs are `MATERIALIZED` and movements are aggregated per account before the account join: with freshly grown tables (no planner statistics yet) the first form ran 1-row-estimate nested loops of 9k–17k iterations (287 ms per call, up to ~1 s); the new form keeps the property test at ~8 s instead of ~80 s.
- Why: account_balance is keyed by period (migration 0023) but reports need dates (design §8.1); each entry lies in the one period holding its date (0018), so each line counts once (RQ-0037 Q1, Q5).
- Alternatives: dates restricted to period boundaries (would refuse a mid-month balance sheet); read everything from journal_line (ignores the design's "reports read from here").
- ADR: none · Status: accepted

### DL-0174 — Statement definitions; presentation choices left open for the product owner
- Date: 2026-10-25 · By: claude · Task: T-0076 · Category: accounting
- Decision: (1) TB: one row per account with posted activity in the range, its net balance on the debit or credit side, totals and `netsToZero`; real ledger balances only (no computed roll-up). (2) P&L for [from, to]: revenue then expenses, grouped by subtype, groups ordered by their lowest account code and lines by code (the chart decides the layout); revenue credit-positive, expenses debit-positive, net profit = revenue − expenses. (3) BS at a date D: needs the fiscal year holding D (`NO_FISCAL_YEAR` otherwise); assets debit-positive, liabilities and equity credit-positive by subtype; RETAINED_EARNINGS line = its posted balance + all P&L dated before the fiscal-year start; CURRENT_YEAR_EARNINGS line = its posted balance + P&L from the year start to D; both always shown, flagged `computed`; `balanced` = assets equal liabilities + equity. A year-end closing entry needs no special case. All amounts in the company's base currency as `Money`. No dimension filter on the BS. Presentation questions the design does not settle go to the product owner (RQ-0037 follow-ups): TB roll-up of prior-year P&L into retained earnings like Xero; a Gross Profit subtotal; AASB 18 categories from 2027; current/non-current split on the BS; a BS by dimension.
- Why: Design §3.5 (retained earnings computed at report time, optional closing entry), §8.1; RQ-0037 (AASB 101/IAS 1, AASB 18, Xero conventions); AGENTS.md §6 (presentation the design leaves open is a human choice). No posting behaviour is defined.
- Alternatives: copy Xero's layout (Gross Profit, TB roll-up) now — a presentation choice the design leaves open; hard-coded subtype order (configuration over code, modules AGENTS.md).
- ADR: none · Status: accepted (computation per design §3.5); presentation items proposed (awaiting human)

### DL-0175 — SS-UC10-08 scope: TB nets to zero now; subledger = control waits for T-0028
- Date: 2026-10-25 · By: claude · Task: T-0076 · Category: scope
- Decision: `trialBalanceReview({ companyId, periodId })` returns the TB as at the period end, `netsToZero`, and for AR_CONTROL and AP_CONTROL the control balance on its normal side with `subledgerBalance: null` and `status: 'subledger_not_available'`. The status values `reconciled` / `difference` are reserved for when `subledger_entry` exists (T-0028); T-0028 or T-0078 (close checklist) must fill them and extend the SS-UC10-08 test. The register row says "green (TB layer; subledger = control pending T-0028)".
- Why: No `subledger_entry` table exists in the base (T-0028 is `todo`); the task brief asks to implement and test what exists and record the scope. Reporting "reconciled" without a subledger would be a false check.
- Alternatives: compare the control with itself (vacuous); block the task (the TB part is buildable now).
- ADR: none · Status: accepted

### DL-0176 — T-0076 build process: RED captures, property test, mutation run
- Date: 2026-10-25 · By: claude · Task: T-0076 · Category: process
- Decision: RED was captured for `account-movements.db.test.ts`, `statements.test.ts` and `reports.tb-pl-bs.db.test.ts` against stubs that throw "not implemented" (fixtures and postings succeeded first; for the db reports test the stub file was put back temporarily from the previous commit). The database property test `reports.prop.db.test.ts` (SS-PLAT-77, default numRuns) was written after the implementation; its power is shown by the mutation run instead. Ten hand mutants (drafts counted, ANY instead of ALL dimension filter, cut period without date filter, CYE including prior years, netsToZero always true, expenses credit-positive, RE without prior profit, AR control sign, date round-trip check, prior years ending on the FY start day) were all killed; the first run left "drafts counted" alive because drafts normally have no period, so a draft carrying its October period was added to the movements test. Tests post raw journals through the engine only (AR/AP lines with `ar_invoice` / `ap_bill` source types so the control accounts accept them); no event posting rule.
- Why: Round-6 protocol (TDD, mutation check); AGENTS.md §0.2–0.3.
- Alternatives: none.

### DL-0177 — Audit log read path: a permission-checked SECURITY DEFINER reader, not SELECT for lf_app (ADR-0034, Proposed)
- Date: 2026-10-25 · By: claude · Task: T-0093 · Category: security
- Decision: Migration 0027 adds `audit.read_log(...)` (owner lf_migrator, STABLE, `search_path = pg_catalog, pg_temp`, EXECUTE for lf_app only) and `app.role_allows_audit_read(role)` (mirror of the role templates holding `audit_log.read`). The reader needs a tenant context, re-checks that the acting user is active and holds an audit-reading role (42501 otherwise), filters `tenant_id` explicitly under FORCE RLS, returns at most 100 rows newest first with keyset pages (`id < before`). lf_app keeps INSERT only on `audit.audit_log`. `GET /audit-log` (`audit_log.read`) is the only route reading it; dates are calendar days in the tenant's report time zone, `to` inclusive; `next_before` is exact (probe for one older row).
- Why: design §6.4 (Auditor reads the audit log) and §6.8 (insert, never update); least privilege for lf_app; project pattern of migration 0018 ([RQ-0038](../research/RQ-0038-admin-ui-audit-read-path.md)).
- Alternatives: `GRANT SELECT` to lf_app (rejected: every code path could read the whole trail, guarded by one decorator); a reporting role or replica (later, for exports).
- ADR: ADR-0034 · Status: proposed (awaiting human)

### DL-0178 — Admin read routes `GET /users` and `GET /auth/me/access`; `/auth/me` unchanged
- Date: 2026-10-25 · By: claude · Task: T-0093 · Category: architecture
- Decision: `GET /users` (`users.read`) lists the tenant's users by name with status and active roles. `GET /auth/me/access` (any member) returns the active role ids and the request's effective permissions (role permissions ∩ token scopes), sorted, so the web app hides or disables actions it may not take; the API stays the authority. `/auth/me` keeps its exact body.
- Why: the users screen had no list endpoint; existing tests assert `/auth/me` with `toEqual`, and the round protocol forbids changing existing assertions (RQ-0038 Q2, Q3). Recorded in ADR-0034 as public API changes.
- Alternatives: add `roles`/`permissions` to `/auth/me` (rejected, above); compute permissions in the browser from roles (rejected: ignores token scopes, duplicates the server's rule).
- ADR: ADR-0034 · Status: proposed (awaiting human)

### DL-0179 — Admin screens: routes, permission-aware actions, step-up routing
- Date: 2026-10-25 · By: claude · Task: T-0093 · Category: ui
- Decision: Routes `/settings/users`, `/settings/users/$userId`, `/reports/control-exceptions?week=`, `/reports/audit-log?<filters>` inside the shell (IA §2, S19); the Settings and Reports pages list them. Every screen has loading, error with Try again, forbidden (naming who can) and empty states. Actions the caller lacks are hidden and a sentence says who can (P6). A self-grant is explained before it is tried and the API's `self_grant` refusal is shown if it is tried anyway. Offboarding needs a reason and a confirmation and reports what was revoked and who takes over approvals. A `401 step_up_required` from any admin call leaves the app for `/auth/step-up?max_age=<n>&return_to=<this page>` (same-origin path only); another 401 goes to sign-in. Router search params are plain text both ways (no JSON quoting of numeric-looking values such as `before=54`). Tables become labelled stacks below 900 px. apps/web now depends on the workspace package `@ledgerforce/shared` (role templates, SoD rule ids) — internal, no third-party dependency added.
- Why: design §6.3–6.5, §6.8; ui-engineer rules; principles P2, P6, P8, P12, P13; ADR-0025.
- Alternatives: a modal for offboarding (rejected: a second focus context for one step); OFFSET paging (rejected, RQ-0038 Q5); copying role names into the web app (rejected: drift from the catalogue).
- ADR: none · Status: accepted

### DL-0180 — T-0093 build process: placeholders, fake API in e2e, mutation run
- Date: 2026-10-25 · By: claude · Task: T-0093 · Category: process
- Decision:
  - Migrations 0026..0028 belong to other round-6 tasks; local `SELECT 1` placeholders from the scratchpad were copied in for `pnpm test:db` and never committed.
  - `tests/e2e/web/admin.spec.ts` serves the app with Vite and fakes the API with `page.route`, as shell.spec.ts does; the faked contracts are proven against the real API by `users.lifecycle`, `users.list`, `permissions`, `sod` and `audit-log` db tests. The spec imports the role catalogue by relative path because the repo root does not depend on `@ledgerforce/shared`.
  - Mutation check: 14 hand mutants; 13 killed (M10, revoked roles listed, first survived and was killed after the seed gained a revoked grant). M6 (reader without its explicit tenant filter) survives as an equivalent mutant: FORCE RLS still confines the definer; the filter is defence in depth.
  - `apps/web/src/admin/client.ts` was drafted before its unit test (the test was written and run before the other admin modules); recorded here for honesty.
- Why: round-6 protocol (DL-0162); AGENTS.md §0 (prove it with evidence).
- Alternatives: none.
- ADR: none · Status: accepted

### DL-0181 — T-0093 scope: quarterly access review not built; reading the audit log not audited
- Date: 2026-10-25 · By: claude · Task: T-0093 · Category: scope
- Decision: The card's goal mentions the quarterly access review (design §6.3 item 4: every user, role, last login and exception, signed off in-app). The lead's assignment for this round lists four screens without it, and it needs a sign-off record and a last-login source that do not exist. It is not built here; the lead should add a follow-up card. Reading the audit log is not itself audited (GET requests are not audited today); whether it should be is left to the product owner (design §6.9 mentions alerts on mass export).
- Why: keep T-0093 to its assigned screens; both items need data or decisions outside this task.
- Alternatives: build an unsigned review page now (rejected: no storage for the sign-off).

### DL-0182 — Round 6 migration renumbering: T-0064 0027 → 0026
- Date: 2026-10-25 · By: claude (lead) · Task: T-0064 · Category: process
- Decision: T-0026 and T-0076 needed no migration. Before merging, the lead renamed T-0064's never-merged migration 0027_salesforce_replay_cursor.sql to 0026 (commit 07532db on its branch), so the merged sequence stays gapless. Its own references were updated; DL-0162 is left as written. If T-0093 adds a migration, it becomes 0027 the same way.
- Why: The runner refuses gaps; DL-0162 said the lead closes gaps by renumbering unmerged files. No merged migration's checksum changes.

- ADR: none · Status: accepted

### DL-0183 — Unexplained intermittent failure in scripts/agent/test/run.test.ts:104 recorded, not fixed
- Date: 2026-10-26 · By: claude (lead) · Task: — (conductor tooling) · Category: process
- Decision: At the T-0076 merge, `node --test scripts/agent/test` failed once on the main checkout. The test "a provider that is still exhausted is skipped on the next run" saw one extra `fake-success T-0002` call. Five immediate reruns, and the final round-6 tree, gave 82/82. The merged branches did not touch `scripts/`. The cause is not yet found. The test stays unchanged (no skip, no weakening). It is listed in HANDOVER for the next session to root-cause; one possibility is the second run picking T-0002 again before `--task T-0004`, depending on timing.
- Why: "Flake" is not a root cause (AGENTS.md directive 3); the evidence must be kept rather than hidden.
- ADR: none · Status: accepted

### DL-0184 — Parallel round 7: T-0028, T-0067, T-0094, T-0108
- Date: 2026-10-26 · By: claude (lead) · Task: T-0028, T-0067, T-0094, T-0108 · Category: process
- Decision: Round 7 runs four tasks in worktrees branched from the round-6 head. Migrations are numbered only if needed; the lead renumbers unmerged files to keep the sequence gapless (DL-0182).
  - T-0028 (subledger entries and allocations): migration 0028, DL-0185..0189, RQ-0039, ADR-0035, SS-PLAT-81..82. Mechanics only: open items and allocation records. A realised-FX journal on allocation is a posting behaviour that needs an Approved golden posting, so it is deferred and recorded.
  - T-0067 (Salesforce write-back via sObject Collections): migration 0029, DL-0190..0194, RQ-0040, ADR-0036, SS-UC01-09/UC03-04/UC04-02 (existing), SS-PLAT-83..84. The contract and db parts are built; scratch-org e2e rows stay not-started.
  - T-0094 (Docker Compose self-hosted install): migration 0030 only if needed, DL-0195..0199, RQ-0041, ADR-0037, SS-PLAT-23 (existing), SS-PLAT-85..86. There is no Docker daemon in this container, so the agent must try to run one (directive 5), or else prove what it can (compose config validation, image build files) and leave SS-PLAT-23 not proven.
  - T-0108 (OpenBao/Vault transit KMS adapter, Phase 1, nothing in MVP depends on it): migration 0031 only if needed, DL-0200..0204, RQ-0042, ADR-0038, SS-PLAT-87..88.
  - Lead: DL-0205+, SS-PLAT-89+.

  Not in this round:
  - T-0029 shares engine code with T-0028.
  - T-0095 is human-only; T-0103 needs Windows.
  - Most other remaining cards wait on Draft golden postings or on these tasks.
- Why: Product owner's instruction to build independent tasks in parallel.
- ADR: none · Status: accepted

### DL-0185 — Open items: one per AR/AP control line, signed like the GL, filled by the database
- Date: 2026-10-26 · By: claude · Task: T-0028 · Category: accounting
- Decision: The posting engine writes one `subledger_entry` for every line on an account bound to AR_CONTROL or AP_CONTROL, in its write savepoint after the lines; preview returns the same items (`BuiltEntry.subledgerItems`) and writes nothing. A BEFORE INSERT trigger fills each item from its line (role, account, party, document, dates, currency, amounts), so the writer gives only company, entry, line and due date. Amounts are signed like the GL (debit +, credit −) in transaction currency (`original_amount`, `open_amount`, `currency`, as design §3.3) and base currency (`base_original_amount`, `base_open_amount`). `PostingLineInput.dueDate` is allowed only on such lines (default: the entry date). A control line with txnAmount 0 is refused. PAYROLL_CLEARING lines get no item (design §3.3 says AR/AP open items).
- Why: RQ-0039 findings 1–3: the sum of items equals the control balance by construction.
- Alternatives: unsigned amounts with a side flag; computing open amounts on read (ADR-0035 options 2–3).
- ADR: ADR-0035 · Status: proposed (awaiting human)

### DL-0186 — Allocations: append-only, priced and applied by SECURITY DEFINER triggers; advisory locks in the engine
- Date: 2026-10-26 · By: claude · Task: T-0028 · Category: architecture
- Decision: `allocate` / `reverseAllocation` (packages/ledger/src/subledger.ts) take an advisory lock on the idempotency key (a repeat returns the first result; another payload under the key is IDEMPOTENCY_CONFLICT), then advisory locks on both items in id order (lf_app cannot SELECT … FOR UPDATE, RQ-0039 E2), check every rule with a typed AllocationError, and insert in a savepoint. In the database, a BEFORE INSERT trigger locks both items FOR UPDATE in id order, re-checks, and computes the base released from each item (proportional, half-up to 4 decimals; the whole remainder when the item closes) and fx_difference; an AFTER INSERT trigger updates both items' open amounts. CHECKs keep 0 ≤ |open| ≤ |original| on the original's side, so even a writer that bypasses the engine cannot over-allocate (proved with two concurrent lf_app transactions). A guard lets an item change only its open amounts and only from that trigger (`pg_trigger_depth() > 1`); allocations never change; no DELETE/TRUNCATE. Reversal = a new row with `reversal_of_id` and the original's amounts negated; one per allocation; a reversal is never reversed. Allocations are not period-checked (they post no journal).
- Why: RQ-0039 findings 5–7; AGENTS.md: posted = immutable, corrections by reversal.
- Alternatives: a SECURITY DEFINER `allocate()` function doing everything in SQL (rejected: the engine gives typed errors and idempotency like post()); row locks only (impossible for lf_app).
- ADR: ADR-0035 · Status: accepted (mechanics; the accounting meaning is in ADR-0035, proposed)

### DL-0187 — fx_difference is recorded as data; no realised FX journal is posted
- Date: 2026-10-26 · By: claude · Task: T-0028 · Category: accounting
- Decision: The design lists `fx_difference` on allocation and says realised FX "posts at allocation" (§3.7). The FX journal is a posting behaviour whose golden posting is Draft, so T-0028 only stores `fx_difference = base released from the credit item − base released from the debit item` (the base debit to the control account the FX journal would post) and posts nothing. `subledgerReconciliation` reports it as `unpostedFxDifference` and reconciles `subledger = control + unposted FX`. Open question for the product owner: approve the realised-FX golden posting (and confirm the sign convention) so a follow-up can post it at allocation.
- Why: AGENTS.md golden-posting gate; RQ-0039 finding 4.
- Alternatives: refuse cross-rate allocations until FX posting exists (rejected: blocks foreign-currency receipts entirely); post FX now (forbidden: Draft golden posting).
- ADR: ADR-0035 · Status: proposed (awaiting human)

### DL-0188 — Subledger read API for the close checklist (SS-UC10-08) lives in packages/ledger
- Date: 2026-10-26 · By: claude · Task: T-0028 · Category: architecture
- Decision: `subledgerReconciliation(trx, { companyId, asOf? })` returns, for AR_CONTROL and AP_CONTROL, the accounts (bound now or carrying items), the control balance (Σ debit − credit of posted lines), the subledger balance (Σ base open; as at a date: items dated ≤ D less base released by allocations dated ≤ D), the unposted FX difference, the difference and `reconciled`. All amounts debit-positive NUMERIC text. `subledgerDrift` lists control lines without an item and items whose open amounts differ from original − allocations. packages/modules/reporting (T-0076, merged) is not edited: the lead or a follow-up wires `trialBalanceReview` to it (pass `asOf = period end`; its controlBalance is on the normal side, so negate for AP).
- Why: Lead's instruction; DL-0175 reserved `reconciled` / `difference` for this.
- ADR: none · Status: accepted

### DL-0189 — Cross-tenant suite: seed steps for subledger_entry and allocation; inline lint exemption for them
- Date: 2026-10-26 · By: claude · Task: T-0028 · Category: process
- Decision: The generated cross-tenant suite needs consistent rows for the two new tables when lf_app inserts them (positive control): PREREQUISITES give the generated entry a journal line on an AR_CONTROL-bound account, and turn the generated "to" item of an allocation into a credit on the "from" item's account, both as a superuser seed step with `session_replication_role = replica`. Those two literal SQL statements in packages/db/src/testing/cross-tenant.ts carry `eslint-disable-next-line lf/no-direct-ledger-write` with a reason (precedent: money.ts); the generic seeder writes the same tables through a dynamic table name. Product code is unaffected.
- Why: AGENTS.md: every tenant table must pass the cross-tenant suite.
- Alternatives: move the prerequisites into packages/ledger (rejected: packages/db cannot depend on the ledger); build the SQL with a dynamic table name to avoid the rule (rejected: hides the write from the lint rule).

### DL-0190 — Salesforce write-back contract: mirrors upserted by LF_Id__c, Account/Opportunity updated by Salesforce id
- Date: 2026-10-26 · By: claude · Task: T-0067 · Category: architecture
- Decision: The write-back is the outbox handler `salesforce.writeback`. It upserts `LF_Invoice__c` and `LF_Payment__c` by `LF_Id__c` and updates Account and Opportunity by Salesforce id through sObject Collections, `allOrNone: false`, ≤ 200 records and each key once per request, money as exact two-decimal JSON numbers, API 67.0. Any request-level or per-record failure throws so the delivery retries with the queue backoff. This refines design §5.4's "upsert by LF_Id__c", which can't apply to objects without that field.
- Why: RQ-0040 F1–F4: the package has `LF_Id__c` only on the mirrors. An upsert that misses on a Salesforce-owned object would create a stray record, while an update by id fails instead. Both are idempotent when the values are absolute.
- Alternatives: add external IDs to Account/Opportunity (rejected: new fields on Salesforce-owned objects, a backfill, and stray records on a miss). A staging table that coalesces events across deliveries (deferred: not needed at MVP volume, ADR-0036 option 3). `allOrNone: true` (rejected: one bad record would block every other record's status).
- ADR: ADR-0036 · Status: proposed (accepted on green CI + cross-review)

### DL-0191 — Write-back scope: synthetic events against a versioned `writeBack` payload contract
- Date: 2026-10-26 · By: claude · Task: T-0067 · Category: scope
- Decision: Invoice and payment documents don't exist yet (T-0040+), so T-0067 defines the producer contract `payload.writeBack = { version: 1, invoices?, payments?, accounts?, opportunities? }` (current-state snapshots, not deltas) and tests the mapping with synthetic events. SS-UC03-04 and SS-UC04-02 prove the payload side only: the upstream "Given" steps (SS-UC03-02, SS-UC04-01) belong to T-0074 and T-0068. SS-UC01-09 uses a balanced manual journal as a stand-in for the invoice journal (GP-001 is Draft). SS-UC01-02 (scratch-org e2e) stays not-started, and so do SS-UC11-05 and SS-UC12-05 (no refunds or aged AR yet). The handler also subscribes to `invoice.drafted`, because SS-UC01-02 needs the Draft status written back.
- Why: The product owner's instruction for T-0067. Snapshots make replays idempotent and give producers one shape to emit.
- Alternatives: wait for T-0040 (rejected: blocks the connector). Map from each topic's own payload (rejected: N producer-specific shapes, harder to keep strict).
- ADR: ADR-0036 · Status: accepted

### DL-0192 — Write-back no-op for companies without an active Salesforce connection; status words as data
- Date: 2026-10-26 · By: claude · Task: T-0067 · Category: architecture
- Decision: If the event's company has no active `app.salesforce_connection`, the handler records the delivery (inbox row) and sends nothing. Status words are data: invoice `draft→Draft, awaiting_approval→Awaiting approval, approved→Approved, posted→Posted, part_paid→Part paid, paid→Paid, overdue→Overdue, void→Void, reversed→Reversed`; credit `current→Current, overdue→Overdue, on_hold→On hold`. These follow Docs/ui/principles.md P2 and UC-04.
- Why: Not every company uses Salesforce, and retrying until dead-letter would fill the Sync issues inbox with noise. If a connection is added later, the nightly reconciliation (design §5.3) brings Salesforce up to date. The labels are text fields in the package (T-0062), so changing a word is a data change.
- Alternatives: throw until a connection exists (rejected: dead-letters every event of non-Salesforce companies). Picklists in the package (deferred: a package change).
- ADR: none · Status: accepted

### DL-0193 — Outage and throttle handling: queue backoff governs, Retry-After reported, Sforce-Limit-Info gate
- Date: 2026-10-26 · By: claude · Task: T-0067 · Category: architecture
- Decision: `401` invalidates the cached token and re-signs once. `503`/5xx/network → `unavailable`, `429` → `rate_limited`, `403 REQUEST_LIMIT_EXCEEDED` → `request_limit`, and the gate's own refusal → `throttled` are retryable. Other 4xx (`rejected`) and an unparseable 2xx (`malformed_response`) aren't, but they still fail the delivery, so after the retry limit they reach the dead-letter queue (Sync issues follow-up). `Retry-After` is parsed (seconds or HTTP-date) and carried on the error. The pg-boss queue backoff (1 min → 6 h) decides the retry time, because `fail()` has no per-call delay. The `ApiUsageGate` keeps the last `Sforce-Limit-Info` reading per org. While a reading younger than 5 minutes is at or above the share (default 25 %), it refuses to send. A stale reading lets one call through to refresh it.
- Why: RQ-0040 F6–F8 and S12. The gate costs no extra API calls, which a `/limits` call per delivery would.
- Alternatives: call `/limits` before each delivery (rejected: spends the allocation it protects). Schedule a new job at Retry-After (rejected: a second retry path beside the outbox's).
- ADR: ADR-0036 · Status: accepted

### DL-0194 — Write-back test layout: contract tests in the connector, outage db test in apps/worker; workspace devDeps
- Date: 2026-10-26 · By: claude · Task: T-0067 · Category: tooling
- Decision: The card's `writeback.payload.spec.ts` / `writeback.outage.spec.ts` follow repo conventions as `packages/connectors/salesforce/src/writeback/writeback.payload.contract.test.ts` and `apps/worker/src/salesforce-writeback.outage.db.test.ts`. The connector exports test-only helpers at `@ledgerforce/connector-salesforce/testing` (fake sObject Collections server, fake token endpoint, test keys). `apps/worker` gains devDependencies on the workspace packages `@ledgerforce/connector-salesforce` and `@ledgerforce/shared` (no third-party package added). The fake validates every field against the SFDX metadata in `salesforce/force-app`, and on purpose it's stricter than Salesforce about money types. No migration was needed (0029 unused).
- Why: packages/connectors AGENTS.md (contract tests `*.contract.test.ts`), vitest projects (`*.db.test.ts`), apps/worker AGENTS.md (the Salesforce write-back lives with the outbox consumer's tests).
- Alternatives: db test inside the connector package (rejected: it would need the ledger fixture and the outbox harness as new devDeps there).

### DL-0195 — Agent sandboxes start their own Docker daemon; images from Docker Hub; optional build CA
- Date: 2026-10-26 · By: claude · Task: T-0094 · Category: tooling
- Decision: When the Docker CLI is present but no daemon runs, agents start `dockerd` (it runs as root in the sandbox VM) and prove compose work locally. Keycloak is pulled from Docker Hub (`keycloak/keycloak`, the official image's mirror) because quay.io is refused by the sandbox egress proxy. Image builds accept an optional BuildKit secret `extra_ca` (a CA for networks that inspect TLS), used only by the corepack and `pnpm fetch` steps and never stored in a layer; `infra/compose/smoke.sh` passes it from `LF_BUILD_CA_FILE`.
- Why: RQ-0041 S1–S2 (dockerd 29.9.2 starts; quay.io 403; containers see a TLS-inspecting CA). Directive 5: solve the block instead of stopping. Corporate networks have the same TLS inspection.
- Alternatives: leave SS-PLAT-23 to CI only (the daemon works here, so this would leave it unproven for no reason); bake the CA into images (it would ship to every install).
- ADR: none · Status: accepted

### DL-0196 — One multi-stage Dockerfile with four targets, digest-pinned bases, workspace layout at runtime; compose.yaml supersedes docker-compose.yml
- Date: 2026-10-26 · By: claude · Task: T-0094 · Category: architecture
- Decision: `infra/docker/Dockerfile` builds `api`, `worker`, `setup` (node:22.23.4-bookworm-slim, USER node) and `web` (nginxinc/nginx-unprivileged:1.30.6-alpine, USER 101) from shared fetch/build/prod stages; `infra/docker/keycloak.Dockerfile` makes an optimized Keycloak 26.8.1 (uid 1000). Bases are `tag@sha256:<index digest>`. The runtime keeps the pnpm workspace layout (symlinked packages) rather than `pnpm deploy`. `infra/compose/compose.yaml` is the stack; `docker-compose.yml` is kept as an `include:` of it (never deleted). `yaml` 2.9.1 (already in the lockfile) becomes a root devDependency for the compose contract test.
- Why: RQ-0041 S3–S4: Node refuses to strip types under node_modules, so `pnpm deploy` would break the TypeScript-source workspace packages; one build shares the dependency layers.
- Alternatives: one Dockerfile per app (duplicated dependency stages); compiling every package (a second build system); Keycloak `start` without build (slower start, build options at runtime).
- ADR: none · Status: accepted

### DL-0197 — First Owner: Keycloak account with a one-time temporary password, invited as Owner by the setup service
- Date: 2026-10-26 · By: claude · Task: T-0094 · Category: security
- Decision: The compose `setup` one-shot (apps/worker/src/setup) checks roles (lf_migrator / lf_app, no superuser, no BYPASSRLS), migrates and installs the queue as lf_migrator, creates the tenant and an invited Owner bound to the Keycloak subject as lf_app under RLS, sets a unique 25-character temporary password with CONFIGURE_TOTP + UPDATE_PASSWORD, and prints the sign-in link with it once. Re-runs print nothing; `LF_SETUP_REISSUE=1` reissues only while the Owner is invited.
- Why: RQ-0041 findings 4–5 (no admin API returns an action link; this reuses the ADR-0027 invite model with no migration). Design §6.3 "no default passwords": the credential is unique, random and single use.
- Alternatives: SMTP + mail catcher; a third-party Keycloak extension; forged action tokens; open self-registration with a setup token (all in ADR-0037).
- ADR: ADR-0037 · Status: proposed (awaiting human)

### DL-0198 — Self-host realm: LoA flow with default ACR = MFA for every login (HANDOVER Q13)
- Date: 2026-10-26 · By: claude · Task: T-0094 · Category: security
- Decision: The `ledgerforce` realm uses a two-level browser flow (password; OTP), `acr.loa.map` {urn:ledgerforce:loa:pwd: 1, urn:ledgerforce:loa:mfa: 2} and client `default.acr.values` = urn:ledgerforce:loa:mfa; no registration, no e-mail reset, no direct grants, PKCE S256, brute-force protection, password length 12+.
- Why: RQ-0041 S11: first login (after enrolment) and step-up both return `acr = urn:ledgerforce:loa:mfa`, which ADR-0025's default policy accepts; without it the Owner's first login is refused (`mfa_enrolment_required`).
- Alternatives: per-role conditional MFA in Keycloak (needs role data in the IdP); relying on `amr` (Keycloak sends none without extra mappers).
- ADR: ADR-0037 · Status: proposed (awaiting human)

### DL-0199 — Secrets as compose file secrets; one public origin through nginx; local host `ledgerforce.localhost`
- Date: 2026-10-26 · By: claude · Task: T-0094 · Category: security
- Decision: Six secrets generated by `infra/compose/init-secrets.sh` into the git-ignored `infra/compose/secrets/` and mounted only into the services that need them; Node services read `<NAME>_FILE` (packages/db `readSecret`), Keycloak through its entrypoint. nginx (the only published service, loopback by default) serves the SPA, proxies the API's prefixes (kept equal to `API_CONTROLLERS` by a test) and Keycloak's `/realms/`, `/resources/`, and returns 404 for `/admin/` and `/realms/master/`. Local installs use `http://ledgerforce.localhost:<port>` with that name as the web service's network alias, so the API reaches the same issuer; the API allows http only for loopback/`*.localhost` hosts.
- Why: RQ-0041 findings 7–9; Keycloak's exposed-path guidance; RQ-0025 same-origin cookies.
- Alternatives: env-var secrets (visible in `docker inspect`); publishing Keycloak on its own port (two origins, issuer mismatch between browser and API); an `/api` prefix (public API change, left as the RQ-0025 follow-up).
- ADR: ADR-0037 · Status: proposed (awaiting human)

### DL-0200 — Transit KMS binds the record through a derived key's context, stores the 60-byte body and a versioned key id (RQ-0042)
- Date: 2026-10-26 · By: claude · Task: T-0108 · Category: security
- Decision:
  - `TransitKms` wraps each data key with `POST /v1/<mount>/encrypt/<key>` on an `aes256-gcm96` key created with `derived=true`.
  - It sends `context = base64("lf-kek-transit-v1|" + record aad)` on encrypt, decrypt and rewrap, and never sends `associated_data`.
  - `wrapped` is the 60 bytes decoded from after `vault:v<N>:`, and `keyId` is `tr.<key>.v<N>`. Both fit the existing `dek_wrapped`/`kek_id` CHECKs, so no migration is needed (0031 unused).
  - The adapter does not use the `datakey` endpoint: the `Kms` interface and `sealField` are unchanged.
- Why: RQ-0042 checked the source and ran experiments against OpenBao 2.7.1. Rewrap drops `associated_data` (path_rewrap.go), so AAD-bound ciphertexts cannot be re-keyed on the server. A derived context gives the same per-record binding (wrong context → 400 auth failure) and keeps rewrap working.
- Alternatives: `associated_data` (rejected: no server-side rewrap); storing the whole `vault:v1:…` string (rejected: violates the 60-byte CHECK and needs a migration); `datakey` (no security gain; interface change).
- ADR: ADR-0038 · Status: proposed (awaiting human)

### DL-0201 — Transit transport: HTTPS-only fetch, no redirects, per-attempt timeout, retry only 429/5xx/network
- Date: 2026-10-26 · By: claude · Task: T-0108 · Category: security
- Decision:
  - Node's built-in `fetch` only; the address must be `https:`.
  - `http:` is allowed only for loopback hosts and only with `allowInsecureLoopbackHttp: true` (tests, `bao server -dev`). A private CA is given via `NODE_EXTRA_CA_CERTS`.
  - `redirect: 'manual'`, and any 3xx is a non-retried `redirect_refused` error.
  - Each attempt has `AbortSignal.timeout(timeoutMs)` (default 5 s).
  - 429, 5xx, network errors and timeouts are retried up to `maxAttempts` (default 3) with exponential full-jitter backoff (base 100 ms, cap 2 s). `Retry-After` is honoured up to the cap.
  - 4xx is never retried.
  - Errors carry op, kind and status only; log events carry op, status, attempt, ms, outcome and reason, never values, tokens or server bodies.
- Why: RQ-0042 Finding 9 — with the default `redirect: 'follow'`, Node forwards `X-Vault-Token` to the redirect target (experiment). Findings 6 and 8 — OpenBao docs class 500/502/503 as "try again later" and 429 as rate limit or standby, while 4xx do not change on retry. Encrypt, decrypt and rewrap are stateless, so retries are safe.
- Alternatives: retrying 5xx only (rejected: a connection reset during failover is the most common transient); following redirects to the active node (rejected: token leak; OpenBao standbys forward requests themselves); an SDK (rejected: no new runtime dependency, ADR-0018).
- ADR: ADR-0038 · Status: proposed (awaiting human)

### DL-0202 — Transit adapter refuses to start on a key that would weaken binding or allow KEK export
- Date: 2026-10-26 · By: claude · Task: T-0108 · Category: security
- Decision: `TransitKms.connect` reads `GET /v1/<mount>/keys/<key>` and throws unless all of these hold: `type=aes256-gcm96`, `derived=true`, `convergent_encryption` not true, `supports_encryption` and `supports_decryption`, `exportable=false`, `allow_plaintext_backup=false`, and `latest_version ≥ 1`. The app token's minimum ACL policy (RQ-0042) has no `create` on encrypt and no rotate.
- Why: RQ-0042 Finding 4 — `context` sent to a non-derived key is silently ignored, so a misconfigured key would lose record binding with no error. An exportable key, or a plaintext backup, lets the KEK leave OpenBao, which defeats the purpose of the adapter. Any type other than aes256-gcm96 changes the wrapped size.
- Alternatives: a warning only (rejected: fail closed); allowing chacha20-poly1305, which is also 60 bytes (deferred: one tested type).
- ADR: ADR-0038 · Status: proposed (awaiting human)

### DL-0203 — Configuration selects the KMS (`LF_KMS_PROVIDER`); MVP boot path unchanged
- Date: 2026-10-26 · By: claude · Task: T-0108 · Category: architecture
- Decision: `kmsFromEnv(env)` in `@ledgerforce/shared/crypto` returns the KMS that `LF_KMS_PROVIDER` selects:
  - `local` → `LocalKeyringKms.fromFile(LF_KMS_KEYRING_FILE)`.
  - `transit` → `TransitKms.connect`, configured from `LF_KMS_TRANSIT_*`. Secrets come only from files: `_TOKEN_FILE`, or `_APPROLE_ROLE_ID_FILE` + `_APPROLE_SECRET_ID_FILE`.
  - Unset → `null` (no KMS; bank-detail routes answer 503 as today).
  - Any other value → an error.

  `apps/api/src/main.ts` is not changed in T-0108; wiring it is a follow-up.
- Why: The task requires that nothing in the MVP depends on the transit adapter and that config chooses the KMS. Keeping `main.ts` untouched leaves the MVP boot path exactly as it was.
- Alternatives: wiring `main.ts` now (deferred: outside the card, and not needed for any MVP flow); tokens in environment variables (rejected: secrets in files, the same as the keyring, ADR-0018).
- ADR: ADR-0038 · Status: proposed (awaiting human)

### DL-0204 — Real-OpenBao integration run is opt-in (`pnpm test:openbao`), uses the pinned 2.7.1 release binary, and has no skip path
- Date: 2026-10-26 · By: claude · Task: T-0108 · Category: tooling
- Decision:
  - `scripts/test/openbao.sh` downloads `openbao_2.7.1_linux_amd64.tar.gz` into `node_modules/.cache/openbao/`, pinned by SHA-256 `0e2f1ce1…2243` (checked against the release `checksums.txt`). It refuses to run on a mismatch or on any other platform.
  - It starts `bao server -dev-tls` on loopback, creates a derived aes256-gcm96 key and an AppRole, sets `NODE_EXTRA_CA_CERTS` to the generated CA, and runs the Vitest project `openbao` (`*.openbao.itest.ts`).
  - The project is not part of `pnpm test` or `pnpm test:db`, so the default suites never skip it. Inside the run, a missing `LF_OPENBAO_*` variable fails the test; it is never skipped.
  - This is dev-only tooling: no package is added.
- Why: The task asks for an optional real-server test only if the binary can be obtained legally and safely, and without Docker. OpenBao is MPL-2.0; the official release verifies against published checksums; `-dev-tls` runs in memory (RQ-0042 Finding 11). Being opt-in by command (not by a skip flag) means AGENTS.md §5 "never skip a test" holds.
- Alternatives: building from source with Go (rejected: slow, large toolchain download); Docker image (rejected: no Docker daemon in this environment); `describe.skipIf(!env)` in the default suite (rejected: a silent skip).

- ADR: none · Status: accepted

### DL-0205 — T-0067 verify fix: deterministic outage test; e2e and refund/aged-AR write-back scenarios move to T-0110
- Date: 2026-10-26 · By: claude · Task: T-0067 · Category: scope
- Decision:
  - (1) `apps/worker/src/salesforce-writeback.outage.db.test.ts` moves the pg-boss TestClock only to each failed job's own `startAfter`, and no further. It awaits the worker's start and stops the worker gracefully before asserting `completed`. Each test uses its own invoice, Account and Opportunity, and asserts on the fake's requests for those records only. The re-sign test primes and revokes its own cached token. Every runtime a test starts is stopped in `afterEach`. No timeout was raised and no assertion weakened.
  - (2) SS-UC01-02 (scratch-org e2e with screenshot), SS-UC11-05 (refund net paid) and SS-UC12-05 (aged-AR reconcile) move from T-0067 to the new card T-0110. T-0110 depends on T-0067, T-0069, T-0055 and T-0049. T-0067's step 7 (Playwright evidence) is n/a: the task has no UI, and its contract and db evidence are in the manifest.
- Why:
  - (1) Verify on the lead branch timed out at 60 s. `TestClock.tick` fires every due timer in order and settles pg-boss after each, so ticking 6 h of simulated time cost about 13 s of CPU per tick. The test took 7 to 31 s unloaded and more than 60 s under load. The next test depended on a token cached by that test. After the fix, test 1 takes 0.6 to 1.8 s, 10 of 10 runs pass, 3 of 3 pass while `pnpm test` and `pnpm test:db` run in parallel, and each test passes alone.
  - (2) Those scenarios need a scratch org, refunds and aged AR, none of which exist yet. Verify gates 9 and 12 cannot pass while T-0067 lists them (DL-0191).
- Alternatives: raise the test timeout (rejected: it hides a CPU-bound wait and the protocol forbids it). Keep the scenarios on T-0067 as blocked (rejected: T-0067's own scope is done, and blocking it would hold back T-0068, T-0069, T-0070 and T-0071, which depend on it).
- ADR: none · Status: accepted

### DL-0206 — SS-UC10-08 subledger = control wired into trialBalanceReview (supersedes DL-0175's placeholder)
- Date: 2026-10-26 · By: claude (lead, after the T-0028 merge) · Task: T-0076, T-0028 · Category: accounting
- Decision: `trialBalanceReview` now calls `subledgerReconciliation({ companyId, asOf: period end })` from T-0028. For each control it reports `subledgerBalance` and `unpostedFxDifference` on the control's normal side (AP negated from the debit-positive reconciliation), and status `reconciled` or `difference` from the reconciliation (subledger = control + unposted FX, DL-0187). `subledger_not_available` remains only for a role with no reconciliation row.
  - The SS-UC10-08 assertion moves from the DL-0175 placeholder (`null`, `subledger_not_available`) to the real values (`1100`/`220`, `reconciled`). This is a stronger expectation, not a weaker one.
  - A new test covers a control line written outside the engine (no open item), which must show `difference`, plus a November engine invoice after the October period end.
  - Done test-first (RED captured). 3 hand mutants killed: status always reconciled; AP side not negated; asOf dropped. The last survived until the post-period invoice was added.
- Why: Design §10.8 item 3 and UC-10 ("AR/AP subledgers = controls"); T-0028 provided the read API (DL-0188). DL-0175 deferred this explicitly until then.
- ADR: ADR-0035 (Proposed) · Status: accepted (DL-0175 superseded for this point)


### DL-0207 — Parallel round 8: T-0029, T-0071, T-0072; T-0007 golden postings is now the critical path
- Date: 2026-10-26 · By: claude (lead) · Task: T-0029, T-0071, T-0072 · Category: process
- Decision: Round 8 runs the only three remaining claimable cards in worktrees, with pre-assigned numbers:
  - T-0029 (manual journals with approval rule; control accounts reject manual journals): migration 0029, DL-0208..0212, RQ-0043, ADR-0039, SS-PLAT-07 (existing), SS-PLAT-89..90.
  - T-0071 (Sync issues inbox, retry/backoff, API-limit throttling): migration 0030, DL-0213..0217, RQ-0044, ADR-0040, SS-PLAT-25 (existing), SS-PLAT-91..92.
  - T-0072 (LWC Account component): no migration expected (0031 if needed), DL-0218..0222, RQ-0045, ADR-0041, SS-UC12-01/03 (existing). SS-UC12-04 (scratch-org e2e) stays not-started.
  - Lead: DL-0223+, SS-PLAT-95+.

  Most remaining MVP cards (T-0031 golden-posting runner → tax, invoices, bills, payments, Stripe …) depend on T-0007 "Golden postings DRAFT", which is `blocked` on the human gate. After this round, the build cannot advance materially until the product owner approves golden postings. This is raised as the top open question in HANDOVER.
- Why: Product owner's parallel-build instruction; AGENTS.md §6 golden-postings human gate.
- ADR: none · Status: accepted

### DL-0223 — DL-0183 investigation: not reproduced in 25 runs under CPU load; mechanisms ruled out
- Date: 2026-10-26 · By: claude (lead) · Task: — (conductor tooling) · Category: process
- Decision: The DL-0183 extra `fake-success T-0002` call is still unexplained, and the test stays unchanged. Findings so far:
  - The extra call can only come from the first `run --once`. With `--task T-0004`, `pickTask` returns the explicit card only, so a second fake-success launch on T-0002 means the first codex attempt was classified as not done, then retried after claude was skipped as exhausted.
  - A stale card write is ruled out: `setCard` re-reads the file before writing.
  - A git `index.lock` clash is unlikely: the conductor only commits deferred checkpoints, and the test providers commit themselves.
  - A scratch repro (`scratchpad/dl0183/repro.ts`) ran the scenario 25 times with 6 busy CPU loops and three sub-agents running: 0 failures.
  - Next step if it recurs: capture the conductor's stdout (the outcome line says why the first attempt was not "done").
  - A cheap aid is to print `r.stdout` in that test's assertion message. That only adds a diagnostic message and weakens nothing; it needs a small follow-up.
- Why: Directive 3 (no "flake" without a cause); keeps the investigation in the repository.
- ADR: none · Status: accepted
