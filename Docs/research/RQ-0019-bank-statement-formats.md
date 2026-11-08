---
id: RQ-0019
title: Bank statement import — OFX 1.x/2.x, CAMT.053 and CSV facts, one normalised line, duplicate detection
status: answered
opened: 2026-10-24
resolved: 2026-10-24
opened_by: claude
linked_tasks: [T-0058]
linked_adrs: []
---

# RQ-0019 — Bank statement formats and duplicate detection

## Question

1. Q1 — OFX: how do OFX 1.x (SGML) and 2.x (XML) files differ, and how are the statement
   transaction fields (`FITID`, `DTPOSTED`, `TRNAMT`, `NAME`, `MEMO`, `CHECKNUM`, `REFNUM`) and
   dates (with time-zone offsets) to be read?
2. Q2 — CAMT.053: which elements carry the booking date, signed amount, status, bank reference,
   description and the opening/closing balances, across message versions .001.02 and .001.08?
3. Q3 — CSV: is there a standard bank CSV layout we can hard-code?
4. Q4 — What one normalised statement line can all three formats produce identically
   (SS-UC08-01)?
5. Q5 — How do we detect a duplicate import (SS-UC08-02), with and without a bank transaction id?

## Why it matters

Design §5.7 lists "Bank statement import (CSV, OFX, CAMT.053)" as the MVP reconciliation input;
§4.1 step 4 sets up the bank accounts; UC-08 main flow 1 and A1 ("Duplicate file → no duplicate
lines"). A wrong date (time-zone shift) or sign makes every match in T-0060 fail; a weak
duplicate key either double-counts cash or silently drops a genuine second transaction.

## Sources consulted

The sandbox could not resolve financialdataexchange.org, rfc-editor.org, stuff.mit.edu,
docs.numeral.io or bankrec.westpac.com.au (WebFetch: `getaddrinfo ENOTFOUND`; curl through the
proxy: `CONNECT tunnel failed, response 403`). Facts from those sites come from search-result
text only and are marked as such. raw.githubusercontent.com was reachable.

| # | Source | Accessed | Kind | What it says |
|---|---|---|---|---|
| S1 | https://financialdataexchange.org/wp-content/uploads/2025/12/OFX-2.2.pdf (OFX 2.2, Nov 2017) — search result only, fetch failed (DNS) | 2026-10-24 | primary (not opened) | the current OFX specification; its data-types chapter defines the date format |
| S2 | https://raw.githubusercontent.com/libofx/libofx/master/doc/ofx_sample_files/ofx_spec201_stmtrs_example.xml (the OFX 2.0.1 spec's own STMTRS example, shipped by libofx) | 2026-10-24 | primary (spec example) | XML form: `<STMTRS><CURDEF>USD</CURDEF><BANKACCTFROM>…<ACCTID>999988</ACCTID>…<BANKTRANLIST><DTSTART>19991001</DTSTART><DTEND>19991028</DTEND><STMTTRN><TRNTYPE>CHECK</TRNTYPE><DTPOSTED>19991004</DTPOSTED><TRNAMT>-200.00</TRNAMT><FITID>00002</FITID><CHECKNUM>1000</CHECKNUM></STMTTRN>…<LEDGERBAL><BALAMT>200.29</BALAMT><DTASOF>19991029112000</DTASOF>`; every element closed |
| S3 | https://raw.githubusercontent.com/libofx/libofx/master/doc/ofx_sample_files/ofx_spec160_stmtrs_example.sgml (OFX 1.6 spec example) | 2026-10-24 | primary (spec example) | same aggregates in SGML: leaf elements have **no closing tag** (`<TRNAMT>-200.00` to end of line); aggregates (`STMTTRN`, `STATUS`, `LEDGERBAL`) are closed |
| S4 | https://raw.githubusercontent.com/csingley/ofxtools/master/ofxtools/header.py | 2026-10-24 | source code | v1 header is `KEY:VALUE` lines (`OFXHEADER:100`, `DATA:OFXSGML`, `VERSION`, `SECURITY`, `ENCODING`, `CHARSET`, `COMPRESSION`, `OLDFILEUID`, `NEWFILEUID`) before `<OFX>`; v2 is `<?xml …?>` then `<?OFX OFXHEADER="200" VERSION="…" …?>`; v2 versions 200, 201, 202, 203, 210, 211, 220 |
| S5 | https://raw.githubusercontent.com/csingley/ofxtools/master/ofxtools/Types.py | 2026-10-24 | source code | DateTime regex `YYYYMMDD` then optional `HHMMSS`, optional `.XXX`, optional `[±hh[.mm][:TZNAME]]`; missing offset ⇒ offset 0 (GMT); decimal retried with `,`→`.` for Euro-style amounts |
| S6 | https://raw.githubusercontent.com/jseutter/ofxparse/master/ofxparse/ofxparse.py | 2026-10-24 | source code | offset regex `\[(?P<tz>[-+]?\d+\.?\d*)\:\w*\]$`; SGML pre-processing "close all tags that don't have closing tags"; amounts via `decimal.Decimal`, `10000,50` → `10000.50` |
| S7 | WebSearch "OFX specification 2.1.1 STMTTRN FITID…" — result text from libofx implementation notes, gnucash-user list (2022-01 TD Bank thread), forum.kde.org, code.gnucash.org IRC 2016-10-04 | 2026-10-24 | secondary | spec 1.6 and 2.02: a date without a time means 0h00 GMT; banks sending `…020000[-5:EST]` caused GnuCash to land transactions a day early; TRNAMT negative = money out, positive = money in; a Brazilian bank reused a FITID for two transactions and the importer dropped one |
| S8 | https://raw.githubusercontent.com/OCA/bank-statement-import/16.0/account_statement_import_camt/models/parser.py | 2026-10-24 | source code | namespace check `urn:iso:std:iso:20022:tech:xsd:camt.053.`; sign from `CdtDbtInd` (`DBIT` ⇒ −1); amount `Ntry/Amt` (fallback `AmtDtls/TxAmt/Amt`); date `BookgDt/Dt` or `BookgDt/DtTm`; refs from `TxDtls/Refs/EndToEndId`, `AcctSvcrRef`; text from `RmtInf/Ustrd`, `AddtlTxInf`, `AddtlNtryInf`; balances `OPBD`/`PRCD` = start, `CLBD` = end |
| S9 | https://raw.githubusercontent.com/OCA/bank-statement-import/16.0/account_statement_import_camt/test_files/test-camt053 | 2026-10-24 | primary-ish (bank sample) | `<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><GrpHdr>…<Stmt><Acct><Id><IBAN>…`; `Bal/Tp/CdOrPrtry/Cd` OPBD, `Bal/Amt Ccy="EUR"` always positive with `CdtDbtInd`, `Bal/Dt/Dt` `YYYY-MM-DD`; `Ntry/Amt Ccy`, `CdtDbtInd` DBIT, `Sts` BOOK (v02: text), `BookgDt/Dt`, `NtryDtls/TxDtls/Refs/EndToEndId`, `RmtInf/Ustrd` |
| S10 | WebSearch "camt.053.001.08 <Sts><Cd>BOOK</Cd></Sts>…" — result text from developer.gs.com (CBPR+), developers.circle.com, asnbank.nl, mnb.hu (camt.053.001.08 description) | 2026-10-24 | secondary (bank guides) | in .001.08 the status is `Ntry/Sts/Cd` (mandatory); codes BOOK (booked), PDNG (pending), plus others; statements carry booked entries |
| S11 | WebSearch "camt.053 Ntry BookgDt …" — result text from docs.numeral.io (camt.053.001.08 business logic), sepaforcorporates.com | 2026-10-24 | secondary | balance amounts are positive with `CdtDbtInd`; OPBD + credits − debits = CLBD |
| S12 | WebSearch "CommBank NetBank CSV export format…" — result text from Westpac NZ Business Online file-format guide, Westpac QuickStream CSV report, FreeAgent CSV guide | 2026-10-24 | secondary | no standard bank CSV layout: column order, header row and date format (dd/mm/yyyy common in AU/NZ) differ per bank and per export option; importers ask the user to map columns |
| S13 | RFC 4180 (https://www.rfc-editor.org/rfc/rfc4180) — fetch failed (DNS); rules from the RFC as widely implemented | 2026-10-24 | primary (not opened) | CSV: records by line break, optional header, fields may be enclosed in `"`, a `"` inside a quoted field is doubled, quoted fields may contain commas and line breaks |

## Findings

1. **OFX 1.x vs 2.x** (S2, S3, S4). 1.x: a plain-text `KEY:VALUE` header, then SGML where leaf
   elements are not closed and aggregates are. 2.x: an XML declaration and an `<?OFX …?>`
   processing instruction, then well-formed XML. The element names inside `<OFX>` are the same,
   so one tokenizer that treats "an unclosed leaf ends at the next tag" handles both.
2. **OFX statement transaction** (S2, S7). `STMTTRN` holds `TRNTYPE`, `DTPOSTED`, optional
   `DTUSER`, `TRNAMT` (signed: negative = money out of the account, positive = money in),
   `FITID` (the FI's transaction id, meant for duplicate detection), optional `CHECKNUM`,
   `REFNUM`, `NAME` (or a `PAYEE` aggregate), `MEMO`. The account is in `BANKACCTFROM/ACCTID`,
   the currency in `CURDEF`, the period in `BANKTRANLIST/DTSTART`/`DTEND`, the closing balance in
   `LEDGERBAL/BALAMT`. OFX gives no opening balance.
3. **OFX dates** (S5, S6, S7). `YYYYMMDD[HHMMSS[.XXX]][[±h[.mm]][:TZ]]`. A missing offset means
   GMT. Converting to UTC and then to a calendar date shifts transactions by a day when a bank
   writes local midnight with an offset (S7, GnuCash/KMyMoney reports). *Inference:* the bank's
   posting date is the date written in the file, in the bank's own offset. We keep the first 8
   digits as the posting date and never convert through UTC.
4. **OFX character set and amounts** (S4, S5, S6). 1.x declares `CHARSET` (often 1252); 2.x is
   XML (UTF-8 by default). Amounts are decimal strings; some FIs use a decimal comma.
5. **FITID reliability** (S7). FITIDs are meant to be unique per account, but at least one bank
   reused them. *Inference:* a FITID-based key alone can drop a genuine line; scoping the key to
   the bank account limits the blast radius, and the import must report how many lines were
   skipped as duplicates so the user can see it (UC-08 A1: "the user is told").
6. **CAMT.053** (S8, S9, S10, S11). Root `Document` in namespace
   `urn:iso:std:iso:20022:tech:xsd:camt.053.001.NN`; `BkToCstmrStmt/Stmt` (one or more) with
   `Acct/Id/IBAN` or `Acct/Id/Othr/Id`, `Acct/Ccy`, `Bal` (OPBD/PRCD opening, CLBD closing; amount
   positive, sign in `CdtDbtInd`), and `Ntry` with `Amt@Ccy`, `CdtDbtInd` (CRDT money in, DBIT
   money out), `Sts` (v02: text `BOOK`; v08: `Sts/Cd`), `BookgDt/Dt` or `BookgDt/DtTm`,
   `AcctSvcrRef` (the bank's reference for the entry), and `NtryDtls/TxDtls` with
   `Refs/EndToEndId`, `RmtInf/Ustrd`, `AddtlTxInf`, plus `Ntry/AddtlNtryInf`.
   OPBD + credits − debits = CLBD (S11).
7. **CSV** (S12, S13). There is no bank-neutral layout. A mapping (delimiter, header row or not,
   which column is date / amount or debit+credit / description / reference / id, date order) is
   configuration, and design principle 3 ("configuration over code") says it belongs in data.
   Quoting follows RFC 4180.

## Conclusion / decision

- **One normalised line** (the SS-UC08-01 contract), produced by every parser:
  `{ postedOn: 'YYYY-MM-DD', amount: Money (signed: + money in, − money out), description,
  reference | null, bankTxnId | null }`.
  - OFX: `postedOn` = first 8 digits of `DTPOSTED`; `amount` = `TRNAMT`; `description` =
    `NAME` (or `PAYEE/NAME`) and `MEMO` joined by a space when both are present and differ;
    `reference` = `REFNUM` ?? `CHECKNUM`; `bankTxnId` = `FITID`.
  - CAMT.053: only `BOOK` entries; `postedOn` = date part of `BookgDt/Dt` / `BookgDt/DtTm` as
    written; `amount` = `Amt` signed by `CdtDbtInd`; `description` = `RmtInf/Ustrd` ??
    `AddtlTxInf` ?? `AddtlNtryInf`; `reference` = `EndToEndId` unless `NOTPROVIDED`;
    `bankTxnId` = `Ntry/AcctSvcrRef` ?? `TxDtls/Refs/AcctSvcrRef`. Entries with several
    `TxDtls` (batches) stay one line (the booked amount); T-0060 can split them if needed.
  - CSV: a stored or supplied mapping; amounts either one signed column or debit/credit columns;
    `(1.00)`, `1,234.56`, `$` and `CR`/`DR` suffixes understood; date orders `YYYY-MM-DD`,
    `DD/MM/YYYY`, `MM/DD/YYYY`, `YYYYMMDD`.
  - Descriptions are whitespace-collapsed and trimmed; amounts never pass through a JS number.
- **Write our own parsers** (no runtime dependency, no ADR): a ~150-line OFX/XML tokenizer that
  accepts unclosed SGML leaves serves OFX 1.x, OFX 2.x and CAMT.053, plus an RFC 4180 CSV reader.
  Root AGENTS.md §0.5 ("build the module yourself") and design §10.6 (a runtime dependency needs
  an ADR).
- **Duplicate detection**, two levels:
  1. *File:* SHA-256 of the file bytes, unique per bank account. Re-importing the same file
     creates nothing and returns `duplicate_file` with the original statement id.
  2. *Line* (overlapping statements, a re-export with a different header or date range): a
     `dedupe_key` unique per bank account — `id:<bankTxnId>` when the file gives one, else
     `h:<sha256(postedOn | amount | description | n)>`, where `n` is the occurrence number of
     that exact (date, amount, description) inside the file. Two identical coffees on one day
     are both kept; importing the file again keys them identically. Duplicate lines are
     skipped with `INSERT … ON CONFLICT DO NOTHING`, and the result reports created and
     duplicate counts.
- **Balances:** when a file gives both an opening and a closing balance (CAMT.053), opening +
  Σ lines must equal closing, else the import is refused (a truncated or mis-parsed file).
- **Account check:** when the file names the account (OFX `ACCTID`, CAMT `Acct/Id`), its last 3
  alphanumerics must match the bank account's stored last 3, else the import is refused (wrong
  file for this account). The full number is never decrypted for this.

## Confidence

`high` for the OFX and CAMT field paths (spec examples S2/S3, a bank sample S9, and two
independent parsers S5/S6/S8). `medium` for the date rule (spec text not opened; consistent
secondary sources and parser code) — the fixtures cover offsets on both sides of midnight.
`medium` for CSV (no standard exists; mapping is configuration by design).

## Follow-ups

- T-0059 (CAMT.053 in the card list) may extend CAMT: batches split into `TxDtls`, `camt.052`.
- Re-check the OFX 2.2 date-format section (S1) when the site is reachable.
- Voiding an imported statement (status) and re-importing the same file is not in T-0058; the
  file-hash rule blocks it until a void flow exists (note on the card).

- 2026-10-25: the batch rule ("stay one line") and the one-statement-per-file rule are
  replaced by [RQ-0028](RQ-0028-camt-batches-multi-statement-052-054.md) (T-0059); the rest stands.

**Affects:** packages/modules/bank, migration 0013, T-0059, T-0060, T-0061.
