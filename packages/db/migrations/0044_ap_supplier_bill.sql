-- 0044 — Supplier bills (T-0050, design §3.8 row 6, UC-05, GP-008, DL-0288). Owner: packages/modules/ap.
--
-- * app.supplier_bill: a supplier's tax invoice entered for payment. The supplier's own invoice
--   number (supplier_ref) is unique per supplier, so the same bill cannot be entered twice.
--   Draft → posted on approval through the posting engine (Dr expense/asset per line, Dr GST paid,
--   Cr AP control); frozen once posted (only posted → void later), like sales invoices.
-- * app.supplier_bill_line: account (expense or asset) chosen per line — suggested from the
--   supplier's past bills — amount ex GST and tax code; net/tax/gross set at approval.
-- * Approval with segregation of duties and the approval workflow are T-0052.
-- * Tenant-owned: RLS ENABLE + FORCE, tenant_isolation, explicit lf_app grants; nothing deleted.

CREATE TABLE app.supplier_bill (
  id            uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id     uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                              REFERENCES app.tenant (id),
  company_id    uuid          NOT NULL,
  party_id      uuid          NOT NULL,
  status        text          NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'void')),
  bill_no       text          CHECK (length(bill_no) BETWEEN 1 AND 40),
  supplier_ref  text          NOT NULL CHECK (length(btrim(supplier_ref)) BETWEEN 1 AND 100),
  bill_date     date          NOT NULL,
  due_date      date          NOT NULL,
  currency      char(3)       NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  net_total     numeric(19,4) NOT NULL CHECK (net_total >= 0),
  tax_total     numeric(19,4) NOT NULL CHECK (tax_total >= 0),
  gross_total   numeric(19,4) NOT NULL CHECK (gross_total > 0),
  created_by    uuid,
  approved_by   uuid,
  approved_at   timestamptz,
  entry_id      uuid,
  created_at    timestamptz   NOT NULL DEFAULT clock_timestamp(),
  updated_at    timestamptz   NOT NULL DEFAULT clock_timestamp(),
  CHECK (due_date >= bill_date),
  CHECK (status = 'draft' OR (bill_no IS NOT NULL AND entry_id IS NOT NULL)),
  UNIQUE (tenant_id, company_id, party_id, supplier_ref),
  UNIQUE (tenant_id, company_id, bill_no),
  UNIQUE (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, party_id) REFERENCES app.party (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, entry_id) REFERENCES app.journal_entry (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.supplier_bill IS 'Supplier bill (GP-008); supplier_ref unique per supplier; frozen once posted.';

CREATE TABLE app.supplier_bill_line (
  tenant_id    uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                             REFERENCES app.tenant (id),
  company_id   uuid          NOT NULL,
  bill_id      uuid          NOT NULL,
  line_no      integer       NOT NULL CHECK (line_no BETWEEN 1 AND 1000),
  account_id   uuid          NOT NULL,
  description  text          NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 1000),
  amount       numeric(19,4) NOT NULL CHECK (amount >= 0),
  tax_code     text          NOT NULL CHECK (tax_code ~ '^[A-Z][A-Z0-9-]*$'),
  tax_code_id  uuid,
  net          numeric(19,4),
  tax          numeric(19,4),
  gross        numeric(19,4),
  PRIMARY KEY (tenant_id, bill_id, line_no),
  FOREIGN KEY (tenant_id, company_id, bill_id) REFERENCES app.supplier_bill (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, account_id) REFERENCES app.account (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, tax_code_id) REFERENCES app.tax_code (tenant_id, company_id, id)
);

CREATE FUNCTION app.supplier_bill_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'posted' AND NEW.status = 'void'
     AND (to_jsonb(NEW) - ARRAY['status', 'updated_at']) = (to_jsonb(OLD) - ARRAY['status', 'updated_at']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'posted bill % cannot be changed (status %)', OLD.bill_no, OLD.status
    USING ERRCODE = 'check_violation';
END;
$$;
CREATE TRIGGER supplier_bill_guard BEFORE UPDATE ON app.supplier_bill
  FOR EACH ROW EXECUTE FUNCTION app.supplier_bill_guard();

CREATE FUNCTION app.supplier_bill_line_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  s text;
BEGIN
  SELECT status INTO s FROM app.supplier_bill WHERE tenant_id = NEW.tenant_id AND id = NEW.bill_id;
  IF s IS NOT NULL AND s <> 'draft' THEN
    RAISE EXCEPTION 'lines of a posted bill cannot be changed (status %)', s USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER supplier_bill_line_guard BEFORE INSERT OR UPDATE ON app.supplier_bill_line
  FOR EACH ROW EXECUTE FUNCTION app.supplier_bill_line_guard();

ALTER TABLE app.supplier_bill ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.supplier_bill FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.supplier_bill
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.supplier_bill TO lf_app;

ALTER TABLE app.supplier_bill_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.supplier_bill_line FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.supplier_bill_line
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.supplier_bill_line TO lf_app;
