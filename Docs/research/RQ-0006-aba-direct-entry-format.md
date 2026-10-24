---
id: RQ-0006
title: ABA (Cemtex / BECS Direct Entry) file format for supplier and staff payment batches
status: resolved
opened: 2026-10-24
resolved: 2026-10-24
opened_by: claude
linked_tasks: []
linked_adrs: []
---

# RQ-0006 — ABA / Direct Entry file format

## Question

Exact layout of record types 0 (descriptive), 1 (detail) and 7 (file total): positions, lengths,
alignment/padding, BSB format, transaction codes (13/50/53), totals and line endings — enough to
write golden ABA fixtures for UC-06/UC-07.

## Why it matters

A malformed file is rejected by the bank at upload (best case) or pays the wrong account
(worst case). Golden fixtures must be byte-exact.

## Sources consulted

The APCA/AusPayNet BECS Procedures (Appendix C2, "BECS DE file format") is the formal spec but
the auspayplus.com.au / apca.com.au hosts were not reachable from this sandbox; bank PDFs were
seen via WebSearch extracts. One full annotated layout was fetched directly from GitHub.

| # | Source | Accessed | Kind | What it says |
|---|---|---|---|---|
| S1 | https://raw.githubusercontent.com/mjec/aba/main/sample-with-comments.aba | 2026-10-24 | secondary (derived from APCA BECS Procedures App. C2/C7, cited inside) | Full field table for types 0/1/7, character sets, transaction-code list, sample file. |
| S2 | https://www.boq.com.au/content/dam/boq/files/help-and-support/internet-and-apps/direct-entry-file-specification.pdf (via WebSearch) | 2026-10-24 | primary (bank spec, extract) | Type 0 pos 1 = "0", 2–18 blank, 19–20 reel seq "01", 57–62 user id, 75–80 DDMMYY; type 7 pos 2–8 "999-999", 21–30 net, 31–40 credit, 41–50 debit total, 75–80 count of type-1 records; amounts in cents, right-justified zero-filled, unsigned; records separated by CRLF. |
| S3 | https://paymentsplus.stgeorge.com.au/docs/downloads/aba.pdf (St.George / Westpac group, via WebSearch) | 2026-10-24 | primary (bank spec, extract) | Type 1 pos 2–8 BSB `nnn-nnn` with hyphen in pos 5; 19–20 transaction code from industry list; 21–30 amount. |
| S4 | https://www.nab.com.au/content/dam/nab/documents/guides/banking/nab-connect-australian-direct-entry-payments-and-dishonour-report.pdf (via WebSearch) | 2026-10-24 | primary (bank guide, extract) | One header and one trailer per file; 53 = pay credit; 13 = debit. |
| S5 | https://developer.azupay.com.au/docs/aba-outbound (via WebSearch) | 2026-10-24 | secondary | Each line exactly 120 chars terminated with CRLF. |
| S6 | https://docs.fileformat.com/finance/aba/ (via WebSearch) | 2026-10-24 | secondary | 120 characters per record excluding newline; 13 = externally initiated debit. |

## Findings

All records are **120 characters**, ASCII, fixed width. Alpha fields left-justified space-filled;
numeric fields right-justified zero-filled; amounts are unsigned whole cents.

**Type 0 — descriptive record (exactly one, first)**

| Pos | Len | Content |
|---|---|---|
| 1 | 1 | `0` |
| 2–18 | 17 | blank (some banks accept funding BSB/account here; APCA requires blank) |
| 19–20 | 2 | reel sequence number, `01` |
| 21–23 | 3 | bank mnemonic of the user's FI (e.g. `CBA`, `WBC`/`WPC`, `NAB`, `ANZ`) |
| 24–30 | 7 | blank |
| 31–56 | 26 | user preferred name (as registered with the bank), left, space-filled |
| 57–62 | 6 | APCA / Direct Entry User ID number, right, zero-filled |
| 63–74 | 12 | file description (e.g. `SUPPLIERS`), left |
| 75–80 | 6 | processing date `DDMMYY` |
| 81–120 | 40 | blank (some banks read 81–84 as HHMM; APCA: blank) |

**Type 1 — detail record (1..n; most banks cap ~500 per file unless agreed)**

| Pos | Len | Content |
|---|---|---|
| 1 | 1 | `1` |
| 2–8 | 7 | payee BSB `nnn-nnn` (hyphen at pos 5) |
| 9–17 | 9 | payee account number, right-justified, **space**-filled (keep leading zeros that belong to the number; strip hyphens if >9 chars) |
| 18 | 1 | indicator: blank, or `N`, `T`, `W`, `X`, `Y` (W/X/Y need withholding) |
| 19–20 | 2 | transaction code (below) |
| 21–30 | 10 | amount in cents, right, zero-filled |
| 31–62 | 32 | account title (payee name), left |
| 63–80 | 18 | lodgement reference (shown on payee's statement), left |
| 81–87 | 7 | trace BSB (our funding account) `nnn-nnn` |
| 88–96 | 9 | trace account number, right, space-filled |
| 97–112 | 16 | name of remitter, left |
| 113–120 | 8 | withholding tax amount in cents, zero-filled (normally `00000000`) |

Transaction codes: `13` externally initiated debit; `50` externally initiated credit (general);
`51` Australian Government security interest; `52` family allowance; `53` pay (salary);
`54` pension; `55` allotment; `56` dividend; `57` debenture/note interest.

**Type 7 — file total record (exactly one, last)**

| Pos | Len | Content |
|---|---|---|
| 1 | 1 | `7` |
| 2–8 | 7 | `999-999` |
| 9–20 | 12 | blank |
| 21–30 | 10 | file net total = credits − debits (cents) |
| 31–40 | 10 | file credit total |
| 41–50 | 10 | file debit total |
| 51–74 | 24 | blank |
| 75–80 | 6 | count of type-1 records |
| 81–120 | 40 | blank |

Character set: BECS set `A–Z a–z 0–9 space & ' ( ) * + , - . / : ; = ? @ [ ] ^ _ ! $ % #`
(S1, from APCA App. C7). Anything else (accents, newlines, `|`, `"`) must be stripped or
transliterated; a newline inside a field is the classic cause of "line too short" rejections (S5).

Line endings: CRLF between records (S2, S5). Sources disagree on a CRLF after the type-7 record
(S1 says none; most generators emit one) — bank-dependent.

Self-balancing: some banks require (or accept) a balancing type-1 **debit** record (code 13) to
the funding account so that net total = 0; others reject it. Bank-dependent.

## Conclusion / decision

- Implement `packages/connectors/aba` as a pure function `(batch, bankProfile) → string` with a
  per-bank profile: `{ mnemonic, userIdNumber, userName, trailingCrlf: true, selfBalancing:
  false, maxDetailRecords: 500 }`. Defaults: CRLF after every record **including** type 7,
  no balancing record; both switchable per bank.
- Supplier payments use code `50`; net-pay batches use `53`; never emit `13` except for an
  enabled self-balancing record.
- Validate before writing: BSB `^\d{3}-\d{3}$`, account `^[0-9A-Za-z-]{1,9}$` after stripping,
  amount > 0 and ≤ 9,999,999,999 cents, BECS character set, every line length 120, totals and
  count consistent. Money from decimal.js → integer cents with exact conversion (reject sub-cent).
- Golden fixtures: one supplier batch (3 lines, code 50), one net-pay batch (code 53), one
  self-balanced variant, each asserted byte-for-byte including CRLFs.

## Confidence

High for positions and codes (three independent bank/vendor specs agree with the APCA-derived
table). Medium for line-ending of the last record and self-balancing — handled by per-bank profile.

## Follow-ups

- When a pilot bank is chosen, attach its current DE spec PDF to the bank profile and run a
  test upload in the bank's test facility (human step).

**Affects:** `packages/connectors/aba`, AP payment batches (UC-06), net-pay batches (UC-07),
setup wizard step 4 (APCA user ID), golden ABA fixtures.
