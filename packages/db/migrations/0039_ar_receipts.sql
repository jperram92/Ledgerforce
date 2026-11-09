-- 0039 — ar: customer receipts (T-0046, design §3.8 row 2, §3.2 allocation, UC-03 A1/A2;
-- RQ-0112; golden posting GP-002). Owner: packages/modules/ar.
--
-- * app.ar_receipt: one row per customer receipt recorded by bank transfer, cheque, cash or
--   other non-card means (card receipts are Stripe, GP-003). The receipt posts at once through
--   the posting engine (source type ar_receipt, source_id = the receipt id, idempotency key
--   ar_receipt:<id>: Dr the bank account's GL account or UNDEPOSITED_FUNDS / Cr AR control); the
--   row is written after that entry, in the same transaction, and never changes (SELECT/INSERT
--   only, like a ledger table). Allocations to invoices are app.allocation rows written by the
--   ledger's allocate(); unallocating is a reversing allocation. The receipt's unallocated credit
--   and the invoices' payment status are derived from the AR open items, never stored here.
-- * Guard: the row must name the engine's posted ar_receipt entry of this receipt (same company,
--   source_id = receipt id) whose credit total equals the amount; a bank receipt names an active
--   company bank account in the receipt currency, an undeposited-funds receipt names none.
-- * DELETE and UPDATE are never granted (directive 6); a trigger refuses them for any role. The
--   insert trigger skips rows of another tenant, so RLS WITH CHECK refuses those with 42501.

CREATE TABLE app.ar_receipt (
  id                uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id         uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                  REFERENCES app.tenant (id),
  company_id        uuid          NOT NULL,
  party_id          uuid          NOT NULL,
  receipt_date      date          NOT NULL,
  amount            numeric(19,4) NOT NULL CHECK (amount > 0),
  currency          char(3)       NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  method            text          NOT NULL CHECK (method IN ('eft', 'cheque', 'cash', 'other')),
  deposit_to        text          NOT NULL CHECK (deposit_to IN ('bank', 'undeposited_funds')),
  bank_account_id   uuid,
  reference         text          CHECK (reference IS NULL OR length(reference) BETWEEN 1 AND 200),
  memo              text          CHECK (memo IS NULL OR length(memo) <= 2000),
  idempotency_key   text          NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  journal_entry_id  uuid          NOT NULL,
  created_by        uuid,
  created_at        timestamptz   NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ar_receipt_deposit_target CHECK ((deposit_to = 'bank') = (bank_account_id IS NOT NULL)),
  UNIQUE (tenant_id, company_id, id),
  UNIQUE (tenant_id, company_id, idempotency_key),
  UNIQUE (tenant_id, journal_entry_id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, party_id) REFERENCES app.party (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, bank_account_id) REFERENCES app.bank_account (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, journal_entry_id) REFERENCES app.journal_entry (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.ar_receipt IS
  'Customer receipts (design 3.8 row 2, UC-03). Posted by the engine as ar_receipt before the row is written; immutable. Allocations live in app.allocation.';
COMMENT ON COLUMN app.ar_receipt.deposit_to IS
  'bank = Dr the GL account of bank_account_id; undeposited_funds = Dr the UNDEPOSITED_FUNDS role (GP-002 variant).';
CREATE INDEX ar_receipt_party_idx ON app.ar_receipt (tenant_id, company_id, party_id, receipt_date);

ALTER TABLE app.ar_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ar_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.ar_receipt
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.ar_receipt TO lf_app;

CREATE FUNCTION app.ar_receipt_insert_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  e record;
  b record;
  credited numeric;
BEGIN
  IF NOT app.sod_is_superuser() THEN
    NEW.created_at := clock_timestamp();
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW;
  END IF;
  SELECT je.source_type, je.source_id, je.status INTO e
    FROM app.journal_entry je
   WHERE je.tenant_id = NEW.tenant_id AND je.company_id = NEW.company_id AND je.id = NEW.journal_entry_id;
  IF NOT FOUND OR e.source_type <> 'ar_receipt' OR e.source_id IS DISTINCT FROM NEW.id::text
     OR e.status <> 'posted' THEN
    RAISE EXCEPTION 'receipt %: journal entry % is not the engine''s ar_receipt posting of this receipt',
      NEW.id, NEW.journal_entry_id USING ERRCODE = 'check_violation';
  END IF;
  SELECT sum(l.credit) INTO credited FROM app.journal_line l
   WHERE l.tenant_id = NEW.tenant_id AND l.entry_id = NEW.journal_entry_id;
  IF credited IS DISTINCT FROM NEW.amount THEN
    RAISE EXCEPTION 'receipt %: amount % differs from its entry''s total %', NEW.id, NEW.amount, credited
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.bank_account_id IS NOT NULL THEN
    SELECT ba.status, ba.currency INTO b FROM app.bank_account ba
     WHERE ba.tenant_id = NEW.tenant_id AND ba.company_id = NEW.company_id AND ba.id = NEW.bank_account_id;
    IF NOT FOUND OR b.status <> 'active' OR b.currency <> NEW.currency THEN
      RAISE EXCEPTION 'receipt %: bank account % is not an active % account of the company',
        NEW.id, NEW.bank_account_id, NEW.currency USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER ar_receipt_insert_guard BEFORE INSERT ON app.ar_receipt
  FOR EACH ROW EXECUTE FUNCTION app.ar_receipt_insert_guard();

CREATE FUNCTION app.ar_receipt_never_changes() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'app.ar_receipt rows never change and are never deleted; unallocate by a reversing allocation, void by reversing the entry'
    USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER ar_receipt_never_changes BEFORE UPDATE OR DELETE ON app.ar_receipt
  FOR EACH ROW EXECUTE FUNCTION app.ar_receipt_never_changes();
