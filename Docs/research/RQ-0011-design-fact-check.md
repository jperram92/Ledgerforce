---
id: RQ-0011
title: Fact-check of the solution design's external claims (design §11.3 item 12)
status: resolved
opened: 2026-10-24
resolved: 2026-10-24
opened_by: claude
linked_tasks: []
linked_adrs: [ADR-0007, ADR-0010]
---

# RQ-0011 — Design fact-check (§11.3 item 12)

## Question

Are the design's factual claims about Xero, NetSuite, Business Central, Salesforce, the ATO and
the AGENTS.md convention correct as of 2026-10-24?

## Why it matters

Several build decisions (ECA auth, CDC selection, payroll scope, retention defaults, agent
instruction files) rest on these claims.

## Sources consulted

Sources are listed per claim. Access method: WebSearch extracts for vendor/regulator pages that
the sandbox proxy blocks; direct fetch for code.claude.com, GitHub and npm. Supporting detail is
in RQ-0001…RQ-0010.

## Findings

| # | Design claim (section) | Verdict | Source(s) | Impact on the build |
|---|---|---|---|---|
| 1 | Xero has two lock dates: one stops everyone except advisers, one stops all users; only advisers set them (§2) | **Confirmed** | https://help.dext.com/en/articles/105721-how-do-xero-lock-dates-affect-publishing-in-dext ; https://support.approvalmax.com/en/articles/414718-how-approvalmax-handles-lock-dates-in-xero-workflows (later date wins when both set) | None; staged close design stands. |
| 2 | Xero tracking categories: two active (§2 table) | **Confirmed** (Xero allows 4 categories, 2 active; user requests to raise it open since Oct 2025) | https://productideas.xero.com/forums/967124/suggestions/50517771 | None. |
| 3 | Xero moved from a broad transactions scope to granular OAuth scopes (§2, §6.2) | **Confirmed, with new dates** — the design's source (mcp.directory) is weak; primary: Xero changelog. Apps created on/after **2 Mar 2026** get only granular scopes (`accounting.invoices`, `accounting.payments`, `accounting.banktransactions`, `accounting.manualjournals`, …); broad scopes usable by older apps until **13 Sep 2027**. | https://developer.xero.com/changelog ; https://developer.xero.com/documentation/guides/oauth2/scopes/ | Phase 1 Xero importer must request granular scopes only. Replace design source link. |
| 4 | NetSuite period close checklist: Lock A/R, Lock A/P, Lock All, then Close; Override Period Restrictions lets users post into locked periods (§2) | **Confirmed** (Lock All = shortcut for locking AR+AP; closed periods block even override holders) | https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N1452163.html ; https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N1455781.html | None. |
| 5 | Business Central: general business × general product posting group matrix decides G/L accounts (§2, §4.4) | **Confirmed** (design's MS Learn sources; not re-fetched — learn.microsoft.com blocked) | https://learn.microsoft.com/en-au/dynamics365/business-central/finance-posting-groups | None. |
| 6 | Business Central: 2 global + up to 8 shortcut dimensions; dimension sets deduplicated (§2, §3.3) | **Confirmed** ("two global dimensions and eight shortcut dimensions"; dimension set = unique combination stored as dimension set entries) | https://learn.microsoft.com/en-us/dynamics365/business-central/finance-dimensions | None. |
| 7 | Business Central has "eight posting-group types" (§2 "What we do not copy") | **Unverifiable / imprecise** — BC has more than eight posting-group kinds (general business/product, VAT business/product, customer, vendor, inventory, bank account, FA, employee, job…); count depends on what is included | design's MS Learn sources | Cosmetic; no build impact. |
| 8 | Salesforce CDC over gRPC Pub/Sub in Avro, ordered by replay ID (§5.3) | **Confirmed** | https://github.com/forcedotcom/pub-sub-api (proto) | — |
| 9 | CDC delivery allocation shared with high-volume platform events; Unlimited default 50,000 / 24 h (§5.3) | **Confirmed but incomplete** — Enterprise Edition is **25,000 / 24 h**; deliveries count per subscriber | https://developer.salesforce.com/docs/platform/change-data-capture/guide/cdc-allocations.html | Budget for 25,000 (typical SMB = Enterprise). RQ-0004. |
| 10 | Entities selectable for CDC capped without add-on (§5.3) | **Confirmed: 5 entities** — but design §5.3 lists **8** CDC objects | same as #9 | **Contradiction** — default CDC set must be ≤ 5; rest polled (RQ-0004). |
| 11 | CDC events retained for a limited window (§5.3) | **Confirmed: 72 hours** | https://developer.salesforce.com/docs/platform/pub-sub-api/guide/event-message-durability.html | Outage > 72 h ⇒ replay ID invalid ⇒ reconciliation path required (RQ-0004). |
| 12 | JWT bearer: no client secret, app pre-authorised; RSA keys only, ECDSA unsupported (§5.2) | **Confirmed**; also: no refresh token is issued | https://docs.withampersand.com/customer-guides/salesforce-jwt (note: design links `/provider-guides/`, now `/customer-guides/`) | RQ-0005. |
| 13 | New integrations should use External Client Apps; ECAs don't support username-password (§5.2) | **Confirmed and stronger** — Connected App creation disabled by default since Spring '26; support ends Summer '27; **refresh-token rotation forced on new ECAs (Oct 2026)** | https://help.salesforce.com/s/articleView?id=005390912 ; https://truesolv.com/connected-apps-salesforce/ | Token store needs single-flight refresh + re-consent handling (RQ-0005). |
| 14 | ATO: STP payroll software requires product registration and the DSP Operational Security Framework (§1 D5, §6.10) | **Confirmed**; in-house-only software exempt; OSF covers any product transmitting tax/accounting/payroll data through ATO digital services; TLS 1.3 required for ATO systems from 31 Jan 2026 | https://softwaredevelopers.ato.gov.au/STP_ProductRegistration ; https://softwaredevelopers.ato.gov.au/scope-dsp-operational-security-framework | D5 stands. Any future **SBR BAS lodgement** also triggers OSF (design already says so). |
| 15 | Record retention: tax law generally 5 years, company law 7 years; default 7 (§6.8) | **Confirmed** (ATO 5 years from lodgement/transaction, longer for assets/losses; Corporations Act s286: 7 years after the transactions) | https://www.ato.gov.au/Business/Record-keeping-for-business/Overview-of-record-keeping-rules-for-business/Records-to-keep-longer-than-five-years ; https://sprintlaw.com.au/articles/s286-corporations-act-financial-record-keeping-requirements/ | Keep default 7 years; never auto-purge records tied to open assets/losses. |
| 16 | AGENTS.md is the cross-tool convention read by Codex, Cursor, Copilot (§10.2) | **Confirmed** — now stewarded by the Linux Foundation's Agentic AI Foundation (Dec 2025) | https://openai.com/index/agentic-ai-foundation/ ; Codex source `core/src/agents_md.rs` | None. Keep AGENTS.md ≤ 32 KiB (Codex truncates — RQ-0001). |
| 17 | Claude Code added an AGENTS.md fallback in 2.1.277; by default reads it only when no CLAUDE.md exists (§10.2) | **Confirmed by official docs** (design cited a news site) | https://code.claude.com/docs/en/memory.md | `CLAUDE.md = @AGENTS.md` remains correct (RQ-0002). Replace the RuntimeWire source. |
| 18 | Conductor runs Claude "in print mode" and Codex "via `codex exec`" (§10.4) | **Confirmed but incomplete** — `claude -p` now defaults to Manual permission mode (≥ 2.1.302); `codex exec` defaults to read-only sandbox, `--full-auto` removed, workspace-write cannot write `.git` | RQ-0001, RQ-0002 | Conductor must pass explicit modes; commits made by the conductor for Codex. |
| 19 | Failure detection via "HTTP 429, insufficient_quota, credit balance messages" (§10.4) | **Outdated/incomplete** — Claude limit messages say "session limit"/"weekly limit"/"spend limit"; Codex says "usage limit", "Quota exceeded", "at capacity"; Claude prints in-run failures on stdout | RQ-0001, RQ-0002 | Extend `failure_patterns`; scan stdout too. |
| 20 | Peppol PINT A-NZ is the AU format (§1, §5.7) | **Confirmed** (BIS 3.0 retired) | RQ-0010 | Phase 2 only. |
| 21 | Testcontainers in the stack (§7.1) | **Confirmed tool, environment-dependent** — needs Docker | RQ-0008 | DL-0007 fallback confirmed. |

## Conclusion / decision

- No claim is wrong in a way that invalidates the architecture. **Two require design changes
  (human):** #10 (8 CDC objects vs 5-entity cap) and #9 (Enterprise allocation 25,000).
- **Process/tooling updates (agents):** #18, #19 conductor flags and failure patterns.
- **Source hygiene:** replace weak/moved links in design §11.4: mcp.directory (Xero) → Xero
  changelog; RuntimeWire → code.claude.com/docs/en/memory; Ampersand `/provider-guides/` →
  `/customer-guides/`.

## Confidence

High for #12–#19 (official docs / source code / executed CLIs). Medium for vendor-UI facts
(#1, #2, #4) derived from consistent secondary or doc extracts.

## Follow-ups

- Human: approve design §5.3 change (default CDC set) — see RQ-0004.
- Scribe: propose the §11.4 source-link replacements as a design revision (human-owned file).

**Affects:** design §2, §5.2, §5.3, §6.8, §6.10, §10.2, §10.4, §11.4; `.agent/config.yaml`;
ADR-0007, ADR-0010.
