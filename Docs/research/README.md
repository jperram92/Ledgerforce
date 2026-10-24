# Research records (RQ)

A **research record** (`RQ-NNNN-<slug>.md`) answers one unclear question with real sources
*before* anything is built on it (AGENTS.md directive 4). It states the question, why it matters,
the sources actually consulted (URL or command, date accessed, what each says), the findings, a
conclusion the builders can act on, a confidence level and what it affects.

## When an RQ is required

Open one before writing code whenever any of these is unclear:

- a **requirement** (design text ambiguous, contradictory or silent);
- an external **API** or file format (Salesforce, Stripe, ABA, bank statements, Peppol, CLIs);
- a **regulation** (ATO, GST/BAS, privacy, record retention);
- a **library or platform behaviour** (PostgreSQL, CEL, test tooling).

**Gate:** a task card may not enter `in_progress` while any RQ linked to it is `open`
(AGENTS.md §2.3). The `research` skill walks through the process.

## Lifecycle

```
open ──▶ resolved
  │
  └────▶ superseded (by RQ-MMMM)
```

- `open` — question recorded, research in progress; linked tasks stay in `researching`.
- `resolved` — conclusion written with sources and confidence. If the conclusion implies a
  decision, it is logged in `Docs/decisions/decision-log.md` (and an ADR when design §10.6
  requires one). Accounting/security conclusions remain *proposals* until the human accepts the
  ADR or golden posting.
- `superseded` — newer facts replace it: set `status: superseded`, `superseded_by: RQ-MMMM`,
  and add the new RQ. Never delete or rewrite a resolved RQ's findings (directive 6); append a
  dated *Addendum* section for small corrections.

Some records written by other roles use the variant status `answered-pending-human`: the
research is done but the conclusion waits on a human gate (e.g. golden postings).

## Conventions

- File name `RQ-NNNN-<kebab-slug>.md`; start from [`RQ-0000-template.md`](RQ-0000-template.md).
- Number ranges in Sprint 0: RQ-0001…0049 researcher; RQ-0080…0089 UI; RQ-0090…0099 accounting.
- Prefer primary sources (vendor docs, legislation, regulator pages, source code, executed
  experiments). Say how a source was accessed (direct fetch, search extract, experiment).
- Supporting scripts/data go in [`assets/`](assets/) and are linked from the RQ.
- End every RQ with **Conclusion**, **Confidence** and an **Affects:** line.

## Index

| ID | Title | Status | Conclusion (one line) | Affects |
|---|---|---|---|---|
| [RQ-0001](RQ-0001-codex-exec-noninteractive.md) | Codex CLI `codex exec` non-interactive mode, AGENTS.md, skills, errors | resolved | Run `codex exec --cd <repo> -s workspace-write -c sandbox_workspace_write.network_access=true --json -o <file>`; `--full-auto` is gone, exit code is always 1 on failure, `.git` is read-only in the sandbox so the conductor commits; skills via `.agents/skills` symlink. | conductor, config.yaml, skills layout |
| [RQ-0002](RQ-0002-claude-code-headless.md) | Claude Code headless `claude -p`, errors, imports, AGENTS.md, skills/agents | resolved | Always pass `--permission-mode` (≥2.1.302 defaults to Manual), use stream-json + `is_error`/`subtype`, scan stdout for "session/weekly/spend limit"; AGENTS.md fallback 2.1.277 confirmed; keep `CLAUDE.md = @AGENTS.md`. | conductor, CLAUDE.md, .claude/skills, .claude/agents |
| [RQ-0003](RQ-0003-cel-javascript-decimal.md) | CEL library for TS rules and decimal money | resolved | Use `@marcbachmann/cel-js` with a decimal.js-backed `decimal` custom type and operator overloads; reject `double` via `check()` + AST lint; verified 0.1+0.2 = 0.3. | packages/rules, ADR (new dep) |
| [RQ-0004](RQ-0004-salesforce-pubsub-cdc.md) | Salesforce Pub/Sub API client, replay, CDC retention and allocations | resolved | `salesforce-pubsub-api-client`; store replay IDs as bytes per batch; retention 72 h; Enterprise 25k / UE 50k deliveries per day; **max 5 CDC entities** without add-on — poll the rest. | connectors/salesforce, ADR-0006, design §5.3 |
| [RQ-0005](RQ-0005-salesforce-auth-2026.md) | Salesforce auth: ECA vs Connected App, JWT, PKCE, RTR | resolved | ECA only (Connected App creation disabled); JWT = RSA-2048 RS256, pre-authorised user, no refresh token; PKCE for hosted; rotation forced on new ECAs ⇒ single-flight refresh. | connectors/salesforce auth, ADR-0007 |
| [RQ-0006](RQ-0006-aba-direct-entry-format.md) | ABA / BECS Direct Entry file format | resolved | 120-char records, types 0/1/7 with exact positions; codes 50 (supplier) / 53 (pay) / 13 (debit); CRLF; per-bank profile for trailing CRLF and self-balancing. | connectors/aba, UC-06, UC-07 |
| [RQ-0007](RQ-0007-postgres-ledger-patterns.md) | PostgreSQL balance trigger, immutability, forced RLS, gapless counters | resolved | Verified on PG 16.15: deferred constraint trigger, UPDATE/DELETE + **INSERT** guards, `NULLIF(current_setting(...,true),'')` in policies, row-locked counter; minimum 16.15 / 17.11. | ledger migrations, tenancy, ADR-0003/0004 |
| [RQ-0008](RQ-0008-test-db-without-docker.md) | Test DB without Docker | resolved | Confirms DL-0007: Testcontainers else local initdb/pg_ctl cluster (non-root user); PGlite smoke-only (single connection, PG18); pg-mem rejected. | test harness, verify.sh |
| [RQ-0009](RQ-0009-au-gst-bas-mvp.md) | Australian GST/BAS facts for MVP | resolved | 10% GST; Simpler BAS (<$10m) = G1/1A/1B; ≥$1,000 invoice needs buyer identity or ABN; cash basis <$10m; ATO rounding is total-invoice / taxable-sale rule (round at total) — **differs from design §3.4** (human). | tax module, AR/AP, golden postings |
| [RQ-0010](RQ-0010-stripe-and-peppol-mvp.md) | Stripe payment collection, payouts, GST on fees; Peppol status | resolved | Checkout Session per invoice; reconcile payouts via balance transactions `payout=`; fee GST appears as `fee_details.type = "tax"` (account-dependent); PINT A-NZ current, Phase 2. | connectors/stripe, UC-03, RQ-0090 |
| [RQ-0011](RQ-0011-design-fact-check.md) | Design fact-check (§11.3 item 12) | resolved | Claims largely confirmed; contradictions: 8 CDC objects vs 5-entity cap, Enterprise 25k allocation, outdated failure patterns/conductor flags; replace three weak source links. | design §2, §5, §10, config.yaml |
| [RQ-0012](RQ-0012-design-review-checklist.md) | Design review checklist (§11.3 items 1–11) | resolved | Fails: ledger-write bypass paths (2), MVP→Phase 1 dependencies (10), missing SMB accounting areas (11); unclear: GST on deposits/bad debts (1), control accounts (3), period matrix (4), outage recovery (6), RLS coverage (8); SoD passes only in standard mode (7). | backlog, golden postings, security/accounting ADRs |
| [RQ-0080](RQ-0080-ui-patterns-accessibility.md) | UI patterns and accessibility baseline (UI agent) | resolved | WCAG 2.2 AA tokens (text ≥4.5:1, UI ≥3:1, never colour alone); tabular right-aligned money; two density modes; UC-12 built from SLDS/Lightning base components only. | Docs/ui, apps/web, UC-12 |
| [RQ-0090](RQ-0090-golden-posting-tax-treatments.md) | AU GST treatments for the draft golden postings (accounting agent) | answered-pending-human | Bad-debt decreasing adjustment at 1B (accruals only); Stripe fees carry GST (see RQ-0010 for `fee_details`); deposit GST on receipt is a human decision; SG 12%. | Docs/accounting/postings.md, T-0007 |
