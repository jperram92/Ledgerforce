---
id: RQ-0016
title: Canonical serialisation of a journal entry for the per-company SHA-256 hash chain
status: answered
opened: 2026-10-24
resolved: 2026-10-24
opened_by: claude
linked_tasks: [T-0022]
linked_adrs: [ADR-0004, ADR-0017]
---

# RQ-0016 — Canonical serialisation of a journal entry for the hash chain

## Question

ADR-0004 rule 5 requires `hash = SHA-256(canonical serialisation of entry + lines + prev_hash)`
and says the canonical form "must be specified precisely and versioned". Concretely:

1. Q1 — Which byte string represents an entry, so that two independent implementations (the
   database, and an auditor-side verifier) produce identical bytes regardless of session
   settings, locale or client library?
2. Q2 — How are numbers, dates, timestamps, UUIDs, text and NULL rendered?
3. Q3 — Which columns are covered, given that ADR-0004 allows exactly one later change
   (`status` posted → reversed)?
4. Q4 — Where is the hash computed and how is the chain kept linear under concurrent posting?

## Why it matters

Design §3.3 invariant 4 and §6.8 (tamper evidence, 5–7 year retention). If the canonical form
depends on a session setting (DateStyle, TimeZone) or a client's type parsing, an honest chain
fails verification ("false tamper"), or a verifier is quietly bent to match. If a mutable field
is hashed, the permitted reversal transition breaks the chain. If posting is not serialised per
company, two entries can claim the same predecessor (a fork).

## Sources consulted

| # | Source | Accessed | Kind | What it says |
|---|---|---|---|---|
| S1 | https://www.postgresql.org/docs/17/datatype-numeric.html | 2026-10-24 | primary | numeric output shows the declared scale; values outside precision raise "numeric field overflow" |
| S2 | https://www.postgresql.org/docs/17/datatype-datetime.html (§8.5.2 output, DateStyle) | 2026-10-24 | primary | date/time output format depends on DateStyle; timestamptz output is shown in the session TimeZone |
| S3 | https://www.postgresql.org/docs/17/functions-formatting.html | 2026-10-24 | primary | `to_char` patterns (`YYYY-MM-DD`, `HH24:MI:SS.US`) are explicit and DateStyle-independent |
| S4 | https://www.postgresql.org/docs/17/functions-binarystring.html | 2026-10-24 | primary | `sha256(bytea)` (PG 11+), `convert_to(text, 'UTF8')` |
| S5 | https://www.postgresql.org/docs/17/sql-createtrigger.html | 2026-10-24 | primary | constraint triggers can be `DEFERRABLE INITIALLY DEFERRED` and fire at commit |
| S6 | https://cr.yp.to/proto/netstrings.txt (D. J. Bernstein, netstrings) | 2026-10-24 | primary (spec) | `<len>:<bytes>,` — a self-delimiting, unambiguous encoding with no escaping |
| S7 | RFC 8785 JSON Canonicalization Scheme, https://www.rfc-editor.org/rfc/rfc8785 | 2026-10-24 | primary (spec) | canonical JSON needs number serialisation per ECMAScript and UTF-16 key sorting — heavy to reproduce in SQL |
| S8 | FIPS 180-4 / NIST example values, SHA-256("abc") = ba7816bf…f20015ad | 2026-10-24 | primary | standard test vector |
| S9 | Experiment E1 (scratch db test, PostgreSQL 16, 2026-10-24) | 2026-10-24 | experiment | see Findings 1–5 |
| S10 | node-postgres type parsing, https://node-postgres.com/features/types | 2026-10-24 | primary | `timestamptz` parsed to JS Date (millisecond precision); `date` parsed to a local-time Date; numeric returned as string |

## Findings

1. `numeric(19,4)::text` and `numeric(18,8)::text` always print the declared scale with no
   exponent: `110.0000`, `-0.5000`, `0.00000001`, `100000000000000.0000`,
   `999999999999999.9999` (S1, E1). `1e15` overflows `numeric(19,4)` (E1).
2. `date::text` and `timestamptz::text` change with DateStyle/TimeZone: under `SQL, DMY` and
   `Australia/Sydney`, `2026-10-24` prints `24/10/2026` and a UTC instant prints
   `24/10/2026 20:00:00.123456 AEDT` (S2, E1). `to_char(d, 'YYYY-MM-DD')` and
   `to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` are unaffected (S3, E1).
3. `uuid::text` is lowercase canonical form (E1). `octet_length(convert_to('é€😀','UTF8'))` = 9,
   matching JavaScript `Buffer.byteLength` (2 + 3 + 4 bytes) (E1). Server encoding is UTF8 (E1).
4. `encode(sha256(convert_to('abc','UTF8')),'hex')` equals the FIPS test vector (S4, S8, E1).
5. node-postgres turns `timestamptz` into a millisecond Date (microseconds lost) and `date` into
   a local-time Date (S10). *Inference:* a verifier must ask PostgreSQL for the explicitly
   formatted text of these columns, never re-format JS Dates.
6. Netstrings need no escaping and are trivially identical in SQL and TypeScript (S6). RFC 8785
   JSON would need ECMAScript number formatting and UTF-16 key ordering reproduced in SQL (S7),
   which is far more surface for divergence. *Inference:* netstrings are the safer v1.
7. Only `status` may change after posting (ADR-0004 rule 1). `hash`, `prev_hash` and the chain
   sequence are outputs of the chain, not inputs. `created_at` is database bookkeeping.

## Conclusion / decision

Specify **canonical form v1** exactly as follows (recorded as ADR-0017; a change needs a new
version and a new ADR):

- **Field encoding:** NULL → `~`; any other value → `<n>:<v>,` where `<v>` is the field's text
  as below and `<n>` its length in UTF-8 **bytes**, in decimal.
- **Renderings:** uuid → lowercase canonical text; text/char → as stored; integer → decimal;
  numeric → `::text` (declared scale, never exponent); date → `to_char(d,'YYYY-MM-DD')`;
  timestamptz → `to_char(ts AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.
- **Order:** `lf-journal-v1`, tenant_id, company_id, id, chain_seq, prev_hash, entry_no,
  entry_date, period_id, source_type, source_id, reversal_of_id, idempotency_key, memo,
  created_by, approved_by, posted_at, line count; then for each line by ascending line_no:
  line_no, account_id, debit, credit, txn_currency, txn_amount, fx_rate, tax_code_id,
  tax_amount, dimension_set_id, party_id, memo.
- **Not covered:** status (the one permitted change), created_at, hash.
- **Hash:** lowercase hex SHA-256 of the UTF-8 bytes. The first entry of a company has
  chain_seq 1 and prev_hash NULL.
- **Where:** in the database, at commit, by a deferred constraint trigger (S5) that locks a
  per-company chain-head row (`FOR UPDATE`), assigns `chain_seq = last + 1` and
  `prev_hash = last_hash`, and stores the hash. Concurrent posts in one company therefore
  serialise on the head row and the chain cannot fork. Lines cannot be added to an entry once
  it is chained.
- **Verifier:** TypeScript, independent of the SQL implementation. It reads rows with the
  explicit SQL renderings above (Finding 5), rebuilds v1 itself, and reports the first entry
  whose hash, link or sequence is wrong. A property test proves TypeScript and SQL produce
  identical canonical strings for random content (unicode, control characters, empty strings,
  NULLs).

## Confidence

`high` — primary documentation plus an executed experiment on the target PostgreSQL. The
TS/SQL agreement is enforced continuously by the property test.

## Follow-ups

- ADR-0017 (Proposed, human gate with ADR-0004).
- The posting engine (T-0025) does not compute hashes; it only posts.
- An auditor-facing report endpoint for the verifier (later, with reports).

**Affects:** T-0022, packages/ledger, migration 0009, ADR-0004, design §3.3 invariant 4, §6.8.
