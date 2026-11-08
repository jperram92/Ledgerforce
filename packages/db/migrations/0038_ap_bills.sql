-- 0038 — supplier bills: header and lines (T-0050, design §3.8 row 6, UC-05, RQ-0106, DL-0290).
-- Owner: packages/modules/ap.
--
-- * app.bill: one supplier invoice as captured by the AP Clerk. bill_no is the company's gapless
--   number from series 'bill' (app.next_document_number, never a sequence). supplier_ref is the
--   supplier's own invoice number; supplier_ref_key is its normalised form (upper case, ASCII
--   letters and digits only), so "INV-0045" and "inv 0045" are the same invoice (RQ-0106 F1).
-- * Duplicates: entry only warns (the module lists matching bills); a second POSTED bill with the
--   same (company, supplier, supplier_ref_key) is refused by bill_posted_supplier_ref_uq. A void
--   bill leaves the index.
-- * Lifecycle: draft → awaiting_approval → approved → posted → void. Approval and SoD are T-0052;
--   until then the module posts draft or approved bills (DL-0292). 'posted' needs the posted
--   journal entry the posting engine wrote for this bill (source ap_bill, source_id = bill id), so
--   no UPDATE can mark a bill posted without a ledger entry. A posted bill is immutable except
--   posted → void (a reversal, later task); a void bill is immutable.
-- * Header fields and lines change only while the bill is draft. Lines are coded by an account
--   chosen on the line or by a product (posting profile, purchase direction, slot expense|asset);
--   the tax code is a code key resolved by the bill date (app.tax_code, migration 0031).
--   coding_source records whether the clerk accepted a suggestion (DL-0291).
-- * Money NUMERIC(19,4); a line amount is > 0 (a supplier credit is its own document, RQ-0106 F3).
-- * Tenant tables: tenant_id, RLS ENABLE + FORCE, tenant_isolation policy; lf_app SELECT, INSERT,
--   UPDATE (nothing is deleted). Guards skip rows whose tenant is not the session tenant, so RLS
--   WITH CHECK refuses them with 42501 (as 0029, 0031, 0032).

CREATE TABLE app.bill (
  id                uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id         uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                  REFERENCES app.tenant (id),
  company_id        uuid          NOT NULL,
  bill_no           text          NOT NULL CHECK (length(btrim(bill_no)) > 0),
  supplier_id       uuid          NOT NULL,
  supplier_ref      text          NOT NULL CHECK (length(btrim(supplier_ref)) BETWEEN 1 AND 100),
  supplier_ref_key  text          GENERATED ALWAYS AS (upper(regexp_replace(supplier_ref, '[^A-Za-z0-9]', '', 'g'))) STORED,
  bill_date         date          NOT NULL,
  due_date          date          NOT NULL,
  currency          char(3)       NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amounts_are       text          NOT NULL DEFAULT 'exclusive' CHECK (amounts_are IN ('exclusive', 'inclusive')),
  status            text          NOT NULL DEFAULT 'draft'
                                  CHECK (status IN ('draft', 'awaiting_approval', 'approved', 'posted', 'void')),
  memo              text,
  entered_by        uuid          REFERENCES app.app_user (id),
  approved_by       uuid          REFERENCES app.app_user (id),
  journal_entry_id  uuid,
  posted_at         timestamptz,
  created_at        timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT bill_due_after_date CHECK (due_date >= bill_date),
  CONSTRAINT bill_ref_key_present CHECK (length(supplier_ref_key) > 0),
  CONSTRAINT bill_posted_has_entry CHECK (
    (status IN ('posted', 'void')) = (journal_entry_id IS NOT NULL AND posted_at IS NOT NULL)),
  UNIQUE (tenant_id, company_id, bill_no),
  UNIQUE (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, supplier_id) REFERENCES app.party (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, journal_entry_id) REFERENCES app.journal_entry (tenant_id, company_id, id)
);
COMMENT ON TABLE app.bill IS
  'Supplier bill (UC-05). Posts only through the posting engine (GP-008); posted = immutable; never deleted.';
COMMENT ON COLUMN app.bill.supplier_ref_key IS
  'Normalised supplier invoice number (RQ-0106 F1): duplicate detection key.';
CREATE UNIQUE INDEX bill_posted_supplier_ref_uq ON app.bill (tenant_id, company_id, supplier_id, supplier_ref_key)
  WHERE status = 'posted';
CREATE INDEX bill_supplier_idx ON app.bill (tenant_id, company_id, supplier_id, bill_date DESC, bill_no DESC);

ALTER TABLE app.bill ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bill FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.bill
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.bill TO lf_app;

CREATE FUNCTION app.bill_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW; -- RLS WITH CHECK refuses it (42501)
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.journal_entry_id IS NOT NULL OR NEW.posted_at IS NOT NULL THEN
      RAISE EXCEPTION 'bill %: a bill is created as draft, without a journal entry', NEW.bill_no
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.bill_no IS DISTINCT FROM OLD.bill_no OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.entered_by IS DISTINCT FROM OLD.entered_by THEN
    RAISE EXCEPTION 'bill %: id, company, bill_no, entered_by and created_at never change', OLD.bill_no
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status IN ('posted', 'void') THEN
    IF OLD.status = 'posted' AND NEW.status = 'void'
       AND (NEW.supplier_id, NEW.supplier_ref, NEW.bill_date, NEW.due_date, NEW.currency,
            NEW.amounts_are, NEW.memo, NEW.approved_by, NEW.journal_entry_id, NEW.posted_at)
           IS NOT DISTINCT FROM
           (OLD.supplier_id, OLD.supplier_ref, OLD.bill_date, OLD.due_date, OLD.currency,
            OLD.amounts_are, OLD.memo, OLD.approved_by, OLD.journal_entry_id, OLD.posted_at) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'bill % is %: it is immutable (corrections are reversals)', OLD.bill_no, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status <> 'draft'
     AND (NEW.supplier_id, NEW.supplier_ref, NEW.bill_date, NEW.due_date, NEW.currency,
          NEW.amounts_are, NEW.memo)
         IS DISTINCT FROM
         (OLD.supplier_id, OLD.supplier_ref, OLD.bill_date, OLD.due_date, OLD.currency,
          OLD.amounts_are, OLD.memo) THEN
    RAISE EXCEPTION 'bill % is %: only a draft bill can be edited', OLD.bill_no, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status = 'void' THEN
    RAISE EXCEPTION 'bill %: only a posted bill is voided (by reversal)', OLD.bill_no
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status = 'posted' THEN
    IF NOT EXISTS (
         SELECT 1 FROM app.journal_entry j
          WHERE j.tenant_id = NEW.tenant_id AND j.company_id = NEW.company_id
            AND j.id = NEW.journal_entry_id AND j.status = 'posted'
            AND j.source_type = 'ap_bill' AND j.source_id = NEW.id::text) THEN
      RAISE EXCEPTION 'bill %: posted needs the posted ap_bill journal entry of this bill', OLD.bill_no
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER bill_guard BEFORE INSERT OR UPDATE ON app.bill
  FOR EACH ROW EXECUTE FUNCTION app.bill_guard();

CREATE TABLE app.bill_line (
  id              uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id       uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                REFERENCES app.tenant (id),
  company_id      uuid          NOT NULL,
  bill_id         uuid          NOT NULL,
  line_no         integer       NOT NULL CHECK (line_no >= 1),
  description     text          NOT NULL CHECK (length(btrim(description)) > 0),
  amount          numeric(19,4) NOT NULL CHECK (amount > 0),
  account_id      uuid,
  product_id      uuid,
  posting_slot    text          NOT NULL DEFAULT 'expense' CHECK (posting_slot IN ('expense', 'asset')),
  tax_code        text,
  coding_source   text          CHECK (coding_source IN ('manual', 'supplier_history', 'product_profile')),
  created_at      timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, bill_id, line_no),
  FOREIGN KEY (tenant_id, company_id, bill_id) REFERENCES app.bill (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, account_id) REFERENCES app.account (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, product_id) REFERENCES app.product (tenant_id, company_id, id)
);
COMMENT ON TABLE app.bill_line IS
  'Supplier bill line (UC-05): amount ex or inc tax per bill.amounts_are; coded by account or product. Draft-only edits.';
CREATE INDEX bill_line_bill_idx ON app.bill_line (tenant_id, bill_id);

ALTER TABLE app.bill_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bill_line FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.bill_line
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.bill_line TO lf_app;

CREATE FUNCTION app.bill_line_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  st text;
  no text;
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.bill_id IS DISTINCT FROM OLD.bill_id
       OR NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION 'bill line: id, bill, company and created_at never change'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT b.status, b.bill_no INTO st, no FROM app.bill b
   WHERE b.tenant_id = NEW.tenant_id AND b.company_id = NEW.company_id AND b.id = NEW.bill_id
   FOR SHARE;
  IF FOUND AND st <> 'draft' THEN
    RAISE EXCEPTION 'bill % is %: lines change only while it is draft', no, st
      USING ERRCODE = 'check_violation';
  END IF;
  PERFORM app.assert_tax_code_exists(NEW.tenant_id, NEW.company_id, NEW.tax_code);
  RETURN NEW;
END
$$;
CREATE TRIGGER bill_line_guard BEFORE INSERT OR UPDATE ON app.bill_line
  FOR EACH ROW EXECUTE FUNCTION app.bill_line_guard();
