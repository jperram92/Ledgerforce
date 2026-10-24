-- 0013 — bank: company bank accounts, imported statements and statement lines
-- (T-0058, design §4.1 step 4, §5.7, UC-08, RQ-0019). Owner: packages/modules/bank.
--
-- * app.bank_account: the company's own bank account, bound to one GL account of type asset and
--   subtype bank (a trigger checks it; it skips rows of another tenant so RLS refuses those with
--   42501). BSB, account name and last 3 in clear; the account number envelope-encrypted exactly
--   like app.party_bank_account (ADR-0018). ABA fields for payment batches (RQ-0006): APCA user
--   id, user preferred name, FI mnemonic. csv_mapping is the bank's CSV layout, stored as data.
--   lf_app may change only name, status and csv_mapping; new payment details are a new row.
-- * app.bank_statement: one imported file. Its SHA-256 is unique per bank account, so the same
--   file is never imported twice. Its currency must be the bank account's (composite FK).
-- * app.bank_statement_line: imported data, not ledger rows; no journal table is touched.
--   dedupe_key is unique per bank account: 'id:<bank id>' ('id#n:<bank id>' for the n-th reuse
--   of a bank id inside one file) or 'h:' + SHA-256 of date|amount|description|occurrence.
--   line_no is the line's position in its file; lines found to be duplicates are not stored,
--   so lines_total - count(lines) is the number skipped. Amount: + money in, − money out.
--   lf_app may change only status (matching, T-0060). Nothing is ever removed.

CREATE TABLE app.bank_account (
  id                    uuid        PRIMARY KEY,
  tenant_id             uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                    REFERENCES app.tenant (id),
  company_id            uuid        NOT NULL,
  gl_account_id         uuid        NOT NULL,
  name                  text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  currency              char(3)     NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  bsb                   text        NOT NULL CHECK (bsb ~ '^[0-9]{3}-[0-9]{3}$'),
  account_name          text        NOT NULL CHECK (length(btrim(account_name)) > 0),
  account_number_last3  text        NOT NULL CHECK (account_number_last3 ~ '^[0-9A-Za-z-]{1,3}$'),
  account_number_ct     bytea       NOT NULL CHECK (octet_length(account_number_ct) BETWEEN 1 AND 64),
  account_number_iv     bytea       NOT NULL CHECK (octet_length(account_number_iv) = 12),
  account_number_tag    bytea       NOT NULL CHECK (octet_length(account_number_tag) = 16),
  dek_wrapped           bytea       NOT NULL CHECK (octet_length(dek_wrapped) = 60),
  kek_id                text        NOT NULL CHECK (kek_id ~ '^[A-Za-z0-9_.-]{1,64}$'),
  enc_version           smallint    NOT NULL CHECK (enc_version = 1),
  apca_user_id          text        CHECK (apca_user_id ~ '^[0-9]{6}$'),
  aba_user_name         text        CHECK (aba_user_name ~ '^[A-Za-z0-9 &''()*+,./:;=?@^_!$%#\[\]-]{1,26}$'),
  aba_fi_mnemonic       text        CHECK (aba_fi_mnemonic ~ '^[A-Z]{3}$'),
  csv_mapping           jsonb       CHECK (csv_mapping IS NULL OR jsonb_typeof(csv_mapping) = 'object'),
  status                text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by            uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, company_id, id),
  UNIQUE (tenant_id, company_id, id, currency),
  FOREIGN KEY (tenant_id, company_id, gl_account_id) REFERENCES app.account (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.bank_account IS
  'Company bank accounts (design 4.1 step 4), one per bank GL account. Number envelope-encrypted (ADR-0018).';
COMMENT ON COLUMN app.bank_account.dek_wrapped IS 'IV(12) || tag(16) || wrapped 32-byte data key, by KMS key kek_id.';
COMMENT ON COLUMN app.bank_account.apca_user_id IS 'APCA / Direct Entry user id, 6 digits (ABA type 0, pos 57-62; RQ-0006).';
COMMENT ON COLUMN app.bank_account.aba_user_name IS 'User preferred name registered with the bank, BECS character set (ABA type 0, pos 31-56).';
COMMENT ON COLUMN app.bank_account.aba_fi_mnemonic IS 'Bank mnemonic of the FI, e.g. CBA, WBC, NAB, ANZ (ABA type 0, pos 21-23).';
COMMENT ON COLUMN app.bank_account.csv_mapping IS 'This bank''s CSV export layout (validated by @ledgerforce/bank validateCsvMapping).';
CREATE UNIQUE INDEX bank_account_active_gl_uq ON app.bank_account (tenant_id, gl_account_id)
  WHERE status = 'active';

ALTER TABLE app.bank_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bank_account FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.bank_account
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.bank_account TO lf_app;
GRANT UPDATE (name, status, csv_mapping) ON app.bank_account TO lf_app;

CREATE FUNCTION app.bank_account_gl_check() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  acct app.account;
BEGIN
  -- A row for another tenant is refused by RLS WITH CHECK (42501); don't pre-empt it here.
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NOT (NEW.status = 'active' AND OLD.status <> 'active') THEN
    RETURN NEW;
  END IF;
  SELECT a.* INTO acct FROM app.account a
   WHERE a.tenant_id = NEW.tenant_id AND a.company_id = NEW.company_id AND a.id = NEW.gl_account_id
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key reports it
  END IF;
  IF acct.type <> 'asset' OR acct.subtype <> 'bank' OR acct.status <> 'active'
     OR NOT acct.postable OR acct.is_control THEN
    RAISE EXCEPTION 'a bank account needs an active, postable, non-control asset GL account of subtype bank; account % is % / %',
      acct.code, acct.type, acct.subtype USING ERRCODE = 'check_violation';
  END IF;
  IF acct.currency IS NOT NULL AND acct.currency <> NEW.currency THEN
    RAISE EXCEPTION 'bank account currency % does not match the currency % of GL account %',
      NEW.currency, acct.currency, acct.code USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER bank_account_gl_check BEFORE INSERT OR UPDATE OF status ON app.bank_account
  FOR EACH ROW EXECUTE FUNCTION app.bank_account_gl_check();

CREATE TABLE app.bank_statement (
  id               uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id        uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                 REFERENCES app.tenant (id),
  company_id       uuid          NOT NULL,
  bank_account_id  uuid          NOT NULL,
  currency         char(3)       NOT NULL,
  format           text          NOT NULL CHECK (format IN ('csv', 'ofx', 'camt053')),
  file_name        text          CHECK (length(file_name) <= 255),
  file_sha256      text          NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  account_ref      text          CHECK (length(account_ref) <= 70),
  period_start     date,
  period_end       date,
  opening_balance  numeric(19,4),
  closing_balance  numeric(19,4),
  lines_total      integer       NOT NULL CHECK (lines_total >= 0),
  status           text          NOT NULL DEFAULT 'imported' CHECK (status IN ('imported', 'voided')),
  imported_by      uuid,
  imported_at      timestamptz   NOT NULL DEFAULT now(),
  CHECK (period_start IS NULL OR period_end IS NULL OR period_start <= period_end),
  UNIQUE (tenant_id, bank_account_id, file_sha256),
  UNIQUE (tenant_id, company_id, bank_account_id, id),
  FOREIGN KEY (tenant_id, company_id, bank_account_id, currency)
    REFERENCES app.bank_account (tenant_id, company_id, id, currency),
  FOREIGN KEY (tenant_id, imported_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.bank_statement IS
  'One imported statement file (design 5.7). The same file (SHA-256) is imported once per bank account.';
COMMENT ON COLUMN app.bank_statement.lines_total IS
  'Lines in the file; lines already imported earlier are not stored again (RQ-0019).';

ALTER TABLE app.bank_statement ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bank_statement FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.bank_statement
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.bank_statement TO lf_app;
GRANT UPDATE (status) ON app.bank_statement TO lf_app;

CREATE TABLE app.bank_statement_line (
  id               uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id        uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                 REFERENCES app.tenant (id),
  company_id       uuid          NOT NULL,
  bank_account_id  uuid          NOT NULL,
  statement_id     uuid          NOT NULL,
  line_no          integer       NOT NULL CHECK (line_no >= 1),
  posted_on        date          NOT NULL,
  amount           numeric(19,4) NOT NULL,
  description      text          NOT NULL CHECK (length(description) <= 2000),
  reference        text          CHECK (length(reference) <= 255),
  bank_txn_id      text          CHECK (length(bank_txn_id) <= 255),
  dedupe_key       text          NOT NULL CHECK (dedupe_key ~ '^(id:|id#[0-9]+:|h:[0-9a-f]{64}$)'),
  status           text          NOT NULL DEFAULT 'unmatched'
                                 CHECK (status IN ('unmatched', 'matched', 'excluded')),
  created_at       timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, bank_account_id, dedupe_key),
  UNIQUE (tenant_id, statement_id, line_no),
  FOREIGN KEY (tenant_id, company_id, bank_account_id, statement_id)
    REFERENCES app.bank_statement (tenant_id, company_id, bank_account_id, id)
);
COMMENT ON TABLE app.bank_statement_line IS
  'Normalised imported statement line (RQ-0019). Imported data, not a ledger row. Amount: + in, - out.';
COMMENT ON COLUMN app.bank_statement_line.dedupe_key IS
  'Unique per bank account: id:<bank txn id> | id#n:<bank txn id> | h:<sha256 of date|amount|description|occurrence>.';
CREATE INDEX bank_statement_line_account_date_idx
  ON app.bank_statement_line (tenant_id, bank_account_id, posted_on);

ALTER TABLE app.bank_statement_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bank_statement_line FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.bank_statement_line
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.bank_statement_line TO lf_app;
GRANT UPDATE (status) ON app.bank_statement_line TO lf_app;
