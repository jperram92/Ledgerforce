---
adr: 0017
title: "Journal hash chain: canonical form v1 (netstrings), computed in the database at commit"
status: Proposed
date: 2026-10-24
author: claude
category: accounting
human_gate: yes
supersedes: none
superseded_by: none
---

# ADR-0017: Journal hash chain — canonical form v1, computed in the database at commit

## Status

Proposed — accounting category (refines ADR-0004 rule 5), awaiting product-owner acceptance.
T-0022 is built to this proposal so it can be judged on working, tested code.

## Context and problem statement

ADR-0004 rule 5 requires each posted entry to store `hash = SHA-256(canonical serialisation of
entry + lines + prev_hash)`, chained per company, and says the canonical form must be specified
precisely and versioned. RQ-0016 researched the options and measured PostgreSQL's formatting.

## Decision drivers

- Independent re-computation by an auditor tool must give identical bytes.
- No dependency on session settings (DateStyle, TimeZone), locale or client type parsing.
- The one permitted post-posting change (status → reversed) must not break the chain.
- No forks under concurrent posting. No way for the application role to write a chosen hash.

## Considered options

1. **Netstring concatenation of explicitly rendered fields (chosen).**
2. RFC 8785 canonical JSON: standard, but reproducing ECMAScript number formatting and
   UTF-16 key order in SQL adds divergence risk.
3. Hash computed by the application before insert, checked by the database: two places must
   agree on every post, and a buggy client could still be the only author.

## Decision outcome

Option 1, specified exactly in RQ-0016 *Conclusion*. Summary:

- **Fields:** NULL → `~`; else `<UTF-8 byte length>:<text>,`. uuid lowercase; numeric `::text`;
  date `YYYY-MM-DD`; timestamptz UTC `YYYY-MM-DDTHH24:MI:SS.USZ`.
- **Order:** the version tag `lf-journal-v1`, the entry header fields (with chain_seq and
  prev_hash), the line count, then the lines by line_no.
- **Excluded:** status, created_at, hash.
- **Computed** by a deferred constraint trigger at commit, which locks the company's
  `app.journal_chain_head` row, so the chain is linear (chain_seq 1, 2, 3 …).
- **Verified** by an independent TypeScript verifier that reports the first broken entry.

### Consequences

- Good: settings-proof, escaping-free, identical in two languages, proven by a property test.
- Good: lf_app never writes a hash; the chain function is SECURITY DEFINER and owner-only.
- Bad: posting serialises per company at commit (accepted in ADR-0004 for SMB volumes).
- Bad: changing anything in the form (field order, a new column) needs `lf-journal-v2` and a
  new ADR. Entries keep the version they were hashed with.

## Compliance and verification

| Claim | Proven by |
|---|---|
| 100 posted entries verify; a superuser's altered amount, memo, deleted entry or re-linked hash is reported at the first broken entry | `packages/ledger/src/hash-chain.db.test.ts` (SS-PLAT-03) |
| TypeScript and SQL canonical strings are identical for random content | same file, fast-check property |
| Concurrent posting in one company yields one linear chain | same file |
| Reversal (status change) keeps the chain valid | same file |

## Links

- ADR-0004; RQ-0016; design §3.3 invariant 4, §6.8; T-0022.
