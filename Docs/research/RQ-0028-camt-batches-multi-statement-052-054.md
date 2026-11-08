---
id: RQ-0028
title: CAMT extensions — batch entries (TxDtls), several statements per file, camt.052/054 at AU banks
status: resolved
opened: 2026-10-25
resolved: 2026-10-25
opened_by: claude
linked_tasks: [T-0059]
linked_adrs: []
superseded_by:
---

# RQ-0028 — CAMT batch entries, multi-statement files and camt.052/054

Extends [RQ-0019](RQ-0019-bank-statement-formats.md) and replaces two of its conclusions:
"entries with several `TxDtls` (batches) stay one line" and (via DL-0085) "a camt.053 file must
hold exactly one `Stmt`". Everything else in RQ-0019 stands.

## Question

1. Q1 — Which camt messages and versions do the four AU majors (CBA, Westpac, NAB, ANZ) deliver
   to business customers?
2. Q2 — How is a batch (bulk) entry written in camt.053, where are the per-transaction amounts,
   which sign do they take, and how do they reconcile to the entry's booked amount?
3. Q3 — How are several statements carried in one file, and how does each name its account?
4. Q4 — Should LedgerForce import camt.052 (intraday report) and/or camt.054 (debit/credit
   notification)?

## Why it matters

UC-08 / design §5.7: reconciliation (T-0060) matches statement lines to receipts and payments.
A BPAY or merchant settlement booked as one bulk entry cannot be matched to the individual
invoices it pays unless it is split; splitting wrongly (amounts not adding up, each part given
the full entry amount) creates or loses cash. A multi-account file imported against one account
puts another account's money in the wrong ledger. An intraday report imported as a statement
books provisional entries.

## Sources consulted

The sandbox again could not resolve bankrec.westpac.com.au, www.swift.com, docs.infor.com,
help.online.anz.com and www.sepaforcorporates.com (WebFetch: `getaddrinfo ENOTFOUND`, 2026-10-25);
www.iso20022.org and api.github.com through curl: `CONNECT tunnel failed, response 403`. Facts from
those sites come from **search-result text only** and are marked so. raw.githubusercontent.com
was reachable.

| # | Source | Accessed | Kind | What it says |
|---|---|---|---|---|
| S1 | https://bankrec.westpac.com.au/docs/statements/iso/cash-management — search result text only (fetch: DNS) | 2026-10-25 | primary (not opened) | Westpac BankRec cash-management statements are camt.053.001.02 under the CGI profile; "one file can contain many accounts"; most transactions are "single amounts or a bulked amount of other composite transactions, such as a total BPAY settlement"; "debulked transactions … will also contain the bulked settlement amount" |
| S2 | https://bankrec.westpac.com.au/docs/enrichment — search result text only (fetch: DNS) | 2026-10-25 | primary (not opened) | debulking adds transaction-level detail to bulk settlements; depending on the format "each TxDtls element that previously represented a bulk settlement will be replaced with multiple TxDtls elements" |
| S3 | https://www.swift.com/…/national-australia-bank-limited and …/westpac-banking-corporation (SWIFT Bank Readiness Portal) — search result text only (fetch: DNS) | 2026-10-25 | primary (not opened) | NAB lists camt.053 (with MT940/MT942) and camt.052, camt.054 under Cash Management (ISO 20022); Westpac lists camt.052 and camt.054. The portal tracks SWIFT/CBPR+ (correspondent / corporate-to-bank over SWIFT) readiness, not SMB online banking |
| S4 | https://docs.infor.com/ifsm/2026.x/…/yfk1643606213033.html (Infor ERP guide) — search result text only (fetch: DNS) | 2026-10-25 | secondary | ANZ: MT940, CAMT.053, CAMT.054; Westpac: MT940, CAMT.053; Australian proprietary "NAI" format also common |
| S5 | https://help.online.anz.com/hc/en-au/articles/52290095573145 (ANZ FAQ for corporate customers) — search result text only (fetch: DNS) | 2026-10-25 | primary (not opened) | "ANZ Transactive – Global does not currently support ISO 20022 (MX) message formats", support planned; MT9xx continues "for the foreseeable future"; ANZ Fileactive is named for ISO 20022 files (pain.00x, camt.052, camt.053) |
| S6 | WebSearch "CommBank CommBiz ISO 20022 camt.053 …" | 2026-10-25 | search | no CBA / CommBiz document found; results were other banks (Commerzbank, AKB) |
| S7 | WebSearch "NAB Connect ISO 20022 camt.053 …" | 2026-10-25 | search | no NAB Connect format document found |
| S8 | https://raw.githubusercontent.com/OCA/bank-statement-import/16.0/account_statement_import_camt/models/parser.py | 2026-10-25 | source code | one bank line per `NtryDtls/TxDtls`; per-transaction amount `TxDtls/Amt`, else `TxDtls/AmtDtls/TxAmt/Amt`; sign `TxDtls/CdtDbtInd`, else the entry's (`../../CdtDbtInd`); a TxDtls without an amount **keeps the entry amount** (so k such TxDtls give k lines of the full amount — no sum check); statements = every child of the root after `GrpHdr` (`Stmt`, `Rpt` or `Ntfctn`), each with `Acct/Id/IBAN` or `Acct/Id/Othr/Id` and `Acct/Ccy`; accepts camt.052, .053 and .054 namespaces |
| S9 | https://raw.githubusercontent.com/OCA/bank-statement-import/16.0/account_statement_import_camt/test_files/test-camt053 | 2026-10-25 | primary-ish (bank sample, camt.053.001.02) | a booked DBIT entry `Amt 664.05` with `NtryDtls/Btch` (`NbOfTxs 2`, `TtlAmt 664.05`, `CdtDbtInd DBIT`) and two `TxDtls` whose amounts are `AmtDtls/TxAmt/Amt` 564.05 and 100.00 (no own `CdtDbtInd` in .02) — they add up exactly to the entry |
| S10 | https://raw.githubusercontent.com/OCA/bank-statement-import/16.0/account_statement_import_camt/test_files/test-camt054 | 2026-10-25 | primary-ish (bank sample, camt.054.001.04) | root `BkToCstmrDbtCdtNtfctn/Ntfctn` with `Acct`, `Ntry` (same structure as camt.053, `Sts BOOK`), **no `Bal` element** |
| S11 | WebSearch "camt.053 TxDtls batch … NbOfTxs … TtlAmt" — result text from sepaforcorporates.com, ING Czech annex, docs.numeral.io | 2026-10-25 | secondary | `Btch` holds `MsgId`, `PmtInfId`, `NbOfTxs`, `TtlAmt`, `CdtDbtInd`; transaction details are "optional in case of a batch booking"; balances follow entry amounts (`Ntry/Amt`) |
| S12 | WebSearch "CommBank … camt.052 intraday" — result text from AKB (akb.ch) camt guide, Commerzbank ISO 20022 conversion guide | 2026-10-25 | secondary (bank guides) | camt.052/.053/.054 replace MT942/MT940/MT900-910; a camt.052 report "is not necessarily identical" to the camt.053 statement and should not be used for booking, since some credits are booked definitively only later |

## Findings

1. **AU availability (Q1).** Westpac (S1, S3, S4) and NAB (S3) deliver camt.053, Westpac BankRec
   as **camt.053.001.02**. ANZ lists camt.053 (and .054) via a vendor guide (S4) and ANZ Fileactive
   (S5), while ANZ Transactive – Global does not support ISO 20022 yet (S5). For CBA no source was
   found (S6). camt.052/054 appear only in SWIFT readiness listings (NAB, Westpac — S3) and one
   vendor table (ANZ — S4), i.e. in corporate host-to-host / SWIFT channels. No source shows any of
   the four offering camt.052/054 as a download to SMB customers. *All AU facts are from search
   text, not opened pages* — confidence medium at best.
2. **Batch entries (Q2).** A batch entry is one `Ntry` whose `NtryDtls` holds an optional `Btch`
   summary and one `TxDtls` per underlying transaction (S9, S11). The per-transaction amount is
   `TxDtls/Amt` (from .001.03) or `TxDtls/AmtDtls/TxAmt/Amt` (.001.02, S9); the sign is
   `TxDtls/CdtDbtInd` when present, else the entry's (S8). In the bank sample the parts add up
   exactly to the entry (S9). TxDtls are optional for a batch (S11), and a bank's enrichment may
   change their number (S2), so `Btch/NbOfTxs` is not a reliable cross-check; the amounts are.
3. **Known parser pitfall (Q2).** OCA gives every TxDtls without its own amount the full entry
   amount and never checks the sum (S8): a 3-part batch without part amounts becomes 3× the cash.
4. **Several statements (Q3).** `BkToCstmrStmt` carries 1..n `Stmt`; Westpac states one file can
   hold many accounts (S1). Each `Stmt` names its account (`Acct/Id/IBAN` or `Acct/Id/Othr/Id`) and
   currency (`Acct/Ccy`) and has its own balances (S8, S9). AU banks use `Othr/Id`, typically
   BSB + account number (RQ-0019 fixture; no primary AU layout reachable).
5. **camt.052 (Q4).** Intraday, provisional: it may hold not-yet-final bookings and should not be
   booked from (S12). The end-of-day camt.053 carries the same booked entries.
6. **camt.054 (Q4).** Per-movement notifications, same `Ntry` structure, but **no balances** (S10),
   so the opening + lines = closing check (RQ-0019) cannot protect an import; the movements are
   also reported in the day's camt.053. *Inference:* importing both would rely on line-level
   dedupe across two message types whose references a bank may populate differently.
7. **Schema fact (repo).** `app.bank_statement.format` has `CHECK (format IN ('csv','ofx','camt053'))`
   (migration 0013). Widening a CHECK needs `DROP CONSTRAINT`, which the forward-only runner
   rejects (packages/db/AGENTS.md); a new format would need a new column or table.

## Conclusion / decision

- **Split batches.** For a booked entry with **two or more** `TxDtls`:
  - if every `TxDtls` has an amount (`Amt`, else `AmtDtls/TxAmt/Amt`), make one normalised line per
    `TxDtls`, in file order, signed by its own `CdtDbtInd` or else the entry's, in the bank
    account's currency; the signed parts must add up **exactly** (Money) to the entry's signed
    amount, otherwise refuse the whole file naming the entry;
  - if no `TxDtls` has an amount, keep one line with the entry amount (as T-0058) — never copy
    the entry amount onto each part (finding 3);
  - if only some have an amount, refuse the file (it cannot be split safely).
  - One or no `TxDtls`: one line with the entry amount, exactly as T-0058.
  - `Btch/NbOfTxs` and `TtlAmt` are not checked (finding 2).
- **Per split line:** `description`/`reference` from its own `TxDtls` (Ustrd ?? AddtlTxInf ??
  entry AddtlNtryInf; EndToEndId unless NOTPROVIDED); `bankTxnId` = the part's own
  `TxDtls/Refs/AcctSvcrRef` or null — never the shared entry reference, which would make the
  parts' keys depend on order and collide with an unsplit line. Keep the entry's
  `AcctSvcrRef` (else `NtryRef`) and the part's position as **traceability** on the line
  (stored: migration 0020 `entry_ref`, `entry_tx_no`).
- **Dedupe of split lines without their own id:** `h:` + SHA-256 of date, amount, currency,
  description, entry reference and position, plus the occurrence number — deterministic, distinct
  from an unsplit line's key, stable on re-import.
- **Several statements per file:** read every `Stmt`. A file-level import for a company resolves
  each statement's account from its `Acct` (BSB and last 3 of the number, the currency; the
  stored number is never decrypted, DL-0084) and refuses the file when a statement's account is
  unknown, ambiguous, archived, or appears twice. The import is **atomic**: everything is
  checked before anything is written, in one transaction. The single-account import keeps
  refusing a multi-statement file, pointing to the file-level import.
- **camt.052 and camt.054: not imported.** Recognise their namespaces and refuse them with a
  message that says why and asks for the end-of-day camt.053 (findings 1, 5, 6, 7). Revisit when a
  customer's bank delivers only camt.054 (new card).
- No new dependency: the in-house tag reader suffices.

## Confidence

`medium` overall. High for the message structure (bank samples S9/S10, parser source S8).
Medium-to-low for which AU banks offer what: every AU fact is search-result text from pages the
sandbox could not open (S1–S5); CBA is unknown. The refusal of camt.052/054 is safe under that
uncertainty (fails loudly, loses nothing); the split rule is safe by the exact-sum check.

## Follow-ups

- Re-check S1/S2 (Westpac BankRec layout of debulked TxDtls and `Othr/Id`) and S3/S5 when
  reachable; ask CBA for CommBiz camt support.
- Statements imported before T-0059 kept batches as one line; an overlapping file imported after
  T-0059 would add the parts beside that line. No production data exists yet (MVP not released);
  if it does before release, T-0060 should flag it.
- camt.054-only customers → new card (needs a format column change, finding 7).

**Affects:** packages/modules/bank, migration 0020, T-0059, T-0060.
