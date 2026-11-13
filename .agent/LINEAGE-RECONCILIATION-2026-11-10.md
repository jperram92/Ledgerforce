# Lineage reconciliation — owner decision and first comparison

Owner selected the `feat/T-*` family as canonical on 2026-11-10 Sydney. Decision: DL-0310.
The newer Claude branch is retained as source history, not merged wholesale.

## Immutable references

| Reference | Commit | Purpose |
| --- | --- | --- |
| Claude source | 872c4fa1fc74bb53bb19114035c8fa23d0759ecc | Pickup, completed alternate implementations, interrupted patches |
| Canonical Salesforce line | 3ba54818223454849d0090b1246f9cc9f4320b81 | Contains canonical T-0069 and T-0070 |
| Current canonical payment repair | 96a6b935e2a9aa268d659b1ae2144a017e602f73 | Preserve T-0057 date repair and approved scanner exceptions |
| Common ancestor | c1dfbca476f9394103739efea0f41fe953aef424 | Verified with git merge-base after fetch |

The canonical family has several stacked branches; T-0070 is not a substitute for all of them.
T-0061 and T-0080 have independent changes described in the preserved handover.

## Interrupted source tasks

The source pickup's instructions to finish these on its own architecture are superseded by
DL-0310 and this comparison-first route. Source files, patches and approvals remain in history.

| Source task | Canonical implementation observed | Next action |
| --- | --- | --- |
| T-0041 PDF scaffold | T-0041 review; packages/modules/documents/src/invoice-pdf.db.test.ts, migration 0036, ADR-0045 | Review canonical PDF behavior; compare source RQ-0132/ADR-0046 and patch only for unmet requirements |
| T-0047 prepayment research | T-0047 review; packages/modules/ar/src/prepayments.ts and prepayments.db.test.ts, migration 0042 | Compare single-supply attribution and final application against source ADR-0045 R1–R9 before adding tests or code |
| T-0048 write-off builder | T-0048 review; packages/modules/ar/src/write-off.ts and write-off.db.test.ts | Compare allowance and direct-write-off paths and BAS effects; canonical goldens govern until researched supersession |
| T-0069 Closed Won draft | T-0069 review on canonical SF line | Review canonical idempotency and golden coverage; compare all three source patches for missing cases |

These are inventory findings, not cross-review PASS verdicts. No tests were rerun for this inventory.

## Known identifier collisions

| Source ID (872c4fa) | Canonical meaning | Treatment |
| --- | --- | --- |
| T-0115 nightly profile gap check | AASB alignment research | Keep canonical ID; allocate fresh ID if a genuine gap remains |
| T-0116 sales invoice API | Template roles/source types for goldens | Compare canonical API before creating follow-up |
| T-0117 invoice approval SoD | Period-end system roles | Preserve source proposal separately; security approval remains required |
| T-0121 AU templates v2 | Bills inbox transports | Compare template/account/tax mappings, then allocate a fresh port task |
| T-0124 golden variants | Setup-line collision reported in prior handover | Inspect T-0080 branch before assigning any mapping |
| ADR-0044 GST determination | DAST security ADR | Never transplant source approval onto canonical security ADR |
| ADR-0045 single-supply GST | PDF rendering ADR | Allocate fresh accounting ADR if needed; preserve both histories |
| DL-0242 onward / migration 0031 onward | Independently assigned canonical entries | Qualify every source reference; no numeric overwrite |

## Candidate additions still requiring comparison

- Accountant-reviewer persona: source `.claude/agents/accountant-reviewer.md` contains explicit AI disclosure and source-verification procedure. Its DL/RQ references must be remapped before adoption.
- Source AU templates v2: compare CAP, ECL, overseas profiles, EXP/EXS and BAS mappings with canonical T-0116/T-0118 and approved goldens.
- Source GST determination ADR and golden variants: compare semantic expectations against canonical AASB decisions; original identifiers cannot be copied as equivalent.
- Source 10,000-document suite: canonical `packages/ledger/src/ledger.invariants.db.test.ts` and `posting-invariants.prop.db.test.ts` already exist. Inspect assertions and generators before claiming missing coverage.
- Source follow-up cards: inventory against the union of canonical task branches, including T-0080, before assigning new IDs or supersession links.

## Continuation

## Verified selective port (2026-11-10)

T-0166 on feat/T-0166-gross-ecl-reconciliation maps source GP-007-A to canonical GP-039 (GP-038's initial mapping correction is preserved; DL-0316..0312). CI 42729484847 at ad56bb9 passed static/unit, DB/RLS, browser and fresh-seed 10,000-document invariants. Exact allowance 1,375.00, write-off 1,250.00 plus GST 125.00, subsequent release 125.00 and cash/accrual BAS are now covered against real PostgreSQL. No accounting production code was needed. Final verifier and independent review remain separate gates.

Single-supply comparison: canonical recordPrepayment refuses single supplies with known totals; canonical deposit invoices do not store a supply-pattern choice. Source ADR-0045 R1–R9 therefore identifies a real remaining gap, not a patch that can be applied unchanged. Canonical roles have a fixed SQL CHECK and BAS mapping differs from source. New work must design additive role/settings storage, explicit classification, GST-UB attribution, finalisation/price changes/cancellation and aged unbilled reporting together. Current full advance-invoice GP-021 remains valid. Do not silently turn ordinary deposits into whole-supply attribution.

Security ADRs 0016/0018/0023/0025/0026/0030 are still Proposed on the canonical checkout too; source accounting delegation does not accept them.

Superseding review direction: owner authorized independent Codex review of T-0057/0166/0167
under ADR-0052. Those scoped reports are saved, including the GP-038 selection defect and its
reviewed repair. Full verification gates remain explicit. Independently
cross-review Claude-built canonical cards. For each source gap, create a bounded fresh task,
record its source mapping, research unclear behavior, demonstrate RED, implement and verify.
Do not use review status, historical test totals or this inventory as completion evidence.

## PDF delivery gap confirmed (2026-11-11)

Canonical T-0041 supplies the renderer/template library; the actual worker has an empty handler
registry and its runtime image has no Chromium. T-0119 already owns completion of that path.
RQ-0135 records durable storage, image compatibility/security and event retry questions.
Existing document_attachment stores bill/inbox files; do not assume it already permits invoices.
The email handler attaches rendered bytes but does not persist them. These inspected facts are
not a full T-0041 cross-review verdict or proof that deployed PDFs/email work.
