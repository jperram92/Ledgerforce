-- 0012 — parties: bank accounts with envelope-encrypted account numbers
-- (T-0037, design §4.2, §6.6, RQ-0018, ADR-0018). Owner: packages/modules/parties.
--
-- * Only the account number is secret. It is stored as AES-256-GCM ciphertext + IV + tag, with
--   its data key wrapped by a KMS key (kek_id) and a format version. The application seals it
--   with AAD bound to tenant/company/party/row/field, so a ciphertext moved to another row fails
--   to decrypt. The key never reaches the database.
-- * BSB (public branch id) and account name stay in clear for ABA files (RQ-0006);
--   account_number_last3 is kept for masked display without decryption.
-- * Bank details are never sourced from Salesforce: source is ui | api | import (design §4.2).
-- * Only parties with an active supplier or employee role hold bank details.
-- * lf_app: SELECT, INSERT, and UPDATE of status only. A change of bank details is a new row;
--   the verification workflow (requester ≠ verifier, cooling-off) is T-0053. Nothing is deleted.

CREATE TABLE app.party_bank_account (
  id                    uuid        PRIMARY KEY,
  tenant_id             uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                    REFERENCES app.tenant (id),
  company_id            uuid        NOT NULL,
  party_id              uuid        NOT NULL,
  bsb                   text        NOT NULL CHECK (bsb ~ '^[0-9]{3}-[0-9]{3}$'),
  account_name          text        NOT NULL CHECK (length(btrim(account_name)) > 0),
  account_number_last3  text        NOT NULL CHECK (account_number_last3 ~ '^[0-9A-Za-z-]{1,3}$'),
  account_number_ct     bytea       NOT NULL CHECK (octet_length(account_number_ct) BETWEEN 1 AND 64),
  account_number_iv     bytea       NOT NULL CHECK (octet_length(account_number_iv) = 12),
  account_number_tag    bytea       NOT NULL CHECK (octet_length(account_number_tag) = 16),
  dek_wrapped           bytea       NOT NULL CHECK (octet_length(dek_wrapped) = 60),
  kek_id                text        NOT NULL CHECK (kek_id ~ '^[A-Za-z0-9_.-]{1,64}$'),
  enc_version           smallint    NOT NULL CHECK (enc_version = 1),
  source                text        NOT NULL CHECK (source IN ('ui', 'api', 'import')),
  status                text        NOT NULL DEFAULT 'pending_verification'
                                    CHECK (status IN ('pending_verification', 'active', 'superseded', 'archived')),
  created_by            uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, company_id, party_id) REFERENCES app.party (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.party_bank_account IS
  'Supplier/employee bank details (design 4.2). Account number envelope-encrypted (ADR-0018); masked on read.';
COMMENT ON COLUMN app.party_bank_account.dek_wrapped IS 'IV(12) || tag(16) || wrapped 32-byte data key, by KMS key kek_id.';
CREATE INDEX party_bank_account_party_idx ON app.party_bank_account (tenant_id, party_id);

ALTER TABLE app.party_bank_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.party_bank_account FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.party_bank_account
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.party_bank_account TO lf_app;
GRANT UPDATE (status) ON app.party_bank_account TO lf_app;

CREATE FUNCTION app.party_bank_account_holder_check() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  -- A row for another tenant is refused by RLS WITH CHECK (42501); don't pre-empt it here.
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM app.party_role r
        WHERE r.tenant_id = NEW.tenant_id AND r.party_id = NEW.party_id
          AND r.role IN ('supplier', 'employee') AND r.active) THEN
    RAISE EXCEPTION 'bank details need the party to be an active supplier or employee'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER party_bank_account_holder_check BEFORE INSERT ON app.party_bank_account
  FOR EACH ROW EXECUTE FUNCTION app.party_bank_account_holder_check();
