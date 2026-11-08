---
adr: 0009
title: "Licence: AGPL-3.0 core, Apache-2.0 SDKs and Salesforce package (open decision)"
status: Proposed
date: 2026-10-24
author: claude
category: process
human_gate: yes
supersedes: none
superseded_by: none
---

# ADR-0009: Licence — AGPL-3.0 core, Apache-2.0 SDKs and Salesforce package (open decision)

## Status

Proposed — **open decision for the product owner** (design §11.2 "Licence"; §7.4 says "the final
call is ADR-0009"). Not design-committed: the design gives a recommendation and an alternative.
It is a human gate because it is listed in §11.2 (AGENTS.md §6 item 4). Risk §11.1 requires it
to be decided **before the first public commit / making the repository public**. Agents must not
add a `LICENSE` file or SPDX headers that pre-empt this decision; until it is accepted the
repository should stay private.

## Context and problem statement

LedgerForce is intended to be open source (§1) with two delivery models: self-hosted and hosted
SaaS (§7.2). The licence decides (a) whether a third party may run a modified LedgerForce as a
hosted service without sharing changes, (b) whether partners can embed the API SDKs and the
Salesforce package in proprietary products, (c) whether the project counts as "open source"
(OSI definition) — which matters for community trust and for some adopters' procurement — and
(d) the project's ability to fund itself via hosted SaaS. Risk §11.1: "licence choice deters
adopters or invites free-riding".

Facts (checked 2026-10-24):

- **AGPL-3.0** is OSI-approved (since 2008) and adds to GPL a network-use clause (§13): users
  interacting with a modified version over a network must be offered its source.
- **Apache-2.0** is OSI-approved, permissive, with an explicit patent grant.
- **ELv2 (Elastic License 2.0)** and **BSL 1.1 (Business Source License)** are
  *source-available*, not OSI-approved open source. ELv2 forbids providing the software as a
  managed service; BSL restricts production use until a change date (≤ 4 years) after which the
  code converts to a named open-source licence. Elastic itself added AGPL as an option in 2024
  after its move to ELv2/SSPL, citing community concerns.

## Decision drivers

- Prevent a hosted competitor from taking the core private (free-riding).
- Encourage an ecosystem: integrators, accounting firms and ISVs embedding SDKs/package.
- Be genuinely open source (OSI) for community trust and contributions.
- Keep the Salesforce package installable and redistributable by any admin/partner.
- Simplicity of compliance for SMB self-hosters (who rarely modify code).

## Considered options

1. **AGPL-3.0 core + Apache-2.0 for API SDKs and the Salesforce package** (design recommendation).
2. **Apache-2.0 throughout** (design alternative, "maximum adoption").
3. **Source-available: BSL 1.1 or ELv2 for the core.**
4. (Variant of 1) **AGPL-3.0 core with a CLA / dual commercial licence.**

### Option 1 — AGPL core, Apache edges

- Good, because hosted competitors must publish modifications (AGPL §13), protecting the core.
- Good, because SDKs and the SF package are permissive, so partners can embed them freely.
- Good, because both are OSI-approved — "open source" claim stays true.
- Bad, because some enterprises have blanket policies against AGPL dependencies (mostly
  irrelevant to SMB self-hosters who run, not embed, the core).
- Bad, because the boundary between AGPL core and Apache SDK must be kept clean (SDKs must not
  copy core code).

### Option 2 — Apache-2.0 throughout

- Good, because maximum adoption and zero licence friction; simplest.
- Bad, because anyone can offer a proprietary hosted fork and compete with the project's own
  SaaS without contributing back.

### Option 3 — BSL / ELv2

- Good, because explicitly blocks competing managed services.
- Bad, because not open source (OSI); contradicts the "open-source" positioning; deters
  contributors and some adopters; BSL's delayed conversion adds complexity.

### Option 4 — AGPL + CLA / dual licence

- Good, because enables selling commercial (non-AGPL) licences later.
- Bad, because CLAs deter contributors; adds legal process. Can be added later only if a CLA is
  in place from the first external contribution — so it must be decided together with Option 1.

## Decision outcome

**Not yet decided.** Recommendation (from design §7.4/§11.2, retained here): **Option 1 —
AGPL-3.0-only (or -or-later, to be chosen) for the core; Apache-2.0 for API SDKs and the
Salesforce package.** The product owner chooses between Option 1 and Option 2 (or another) and
whether a CLA/DCO is required. On acceptance, a follow-up task adds `LICENSE` files per package,
SPDX headers and a licence-check CI step.

## Consequences

### If Option 1 is accepted

- Good: core protected; ecosystem encouraged; OSI-compliant.
- Bad: must police the core/SDK boundary; dependency licences must be AGPL-compatible
  (Apache-2.0, MIT, BSD fine; check others).

### If Option 2 is accepted

- Good: maximum adoption. Bad: no protection against proprietary hosted forks.

### Either way

- Runtime dependencies must be licence-compatible; the dependency ADR checklist includes a
  licence check.

## Compliance and verification

| Check | Where | Gate |
|---|---|---|
| Until accepted: no `LICENSE`/SPDX header committed; repo not public | reviewer checklist; release gate | human gate (release) |
| After acceptance: every package has the correct `LICENSE` and `license` field in `package.json` | licence-check script (follow-up) | §10.8 gate 7 |
| All dependencies' licences compatible with the chosen licence | dependency licence scan in CI (follow-up) | gate 7 |

## Links

- Design: §1, §7.4, §11.1 (licence risk), §11.2 (open decision)
- Related ADRs: ADR-0002
- External (retrieved 2026-10-24): GNU AGPL-3.0 — https://www.gnu.org/licenses/agpl-3.0.html ;
  OSI approved licences — https://opensource.org/licenses ; Elastic licence FAQ / clarification —
  https://www.elastic.co/blog/license-change-clarification ; InfoQ "Elastic adds AGPL" (2024) —
  https://www.infoq.com/news/2024/09/elastic-open-source-agpl ; MariaDB BSL 1.1 —
  https://mariadb.com/bsl11/
