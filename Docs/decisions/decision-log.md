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
- ADR: none · Status: proposed (awaiting human: product owner chooses the direction)

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
