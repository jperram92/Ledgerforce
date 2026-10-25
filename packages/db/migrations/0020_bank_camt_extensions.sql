-- 0020 — bank: statement lines split from a CAMT batch entry keep the entry they came from
-- (T-0059, RQ-0028, design §5.7, UC-08). Owner: packages/modules/bank.
--
-- A booked camt.053 entry with several NtryDtls/TxDtls (a BPAY or merchant settlement) is stored
-- as one line per TxDtls; the parts add up exactly to the booked amount (checked on import).
-- * entry_ref: the entry's bank reference (Ntry/AcctSvcrRef, else Ntry/NtryRef), or NULL when the
--   bank gives none or the line was not split.
-- * entry_tx_no: the part's position inside its entry (1..n); NULL for a line that was not split.
-- Additive only: both columns are nullable, existing lines keep NULL. lf_app already has
-- table-level SELECT and INSERT on app.bank_statement_line (0013) and UPDATE on status only, so
-- no grant changes.

ALTER TABLE app.bank_statement_line
  ADD COLUMN entry_ref text CHECK (length(entry_ref) BETWEEN 1 AND 255),
  ADD COLUMN entry_tx_no integer CHECK (entry_tx_no >= 1),
  ADD CONSTRAINT bank_statement_line_entry_ref_needs_tx_no
    CHECK (entry_ref IS NULL OR entry_tx_no IS NOT NULL);

COMMENT ON COLUMN app.bank_statement_line.entry_ref IS
  'For a line split from a CAMT batch entry: the entry''s AcctSvcrRef (else NtryRef); NULL otherwise (RQ-0028).';
COMMENT ON COLUMN app.bank_statement_line.entry_tx_no IS
  'For a line split from a CAMT batch entry: position of its TxDtls inside the entry (1..n); NULL otherwise.';
