-- 0040 — Customer credit notes (T-0045, design §3.8 row 4, UC-11, GP-005/GP-029, DL-0273).
-- Owner: packages/modules/ar.
--
-- * app.sales_invoice_line gains account_id and tax_code_id: the revenue account and tax code the
--   line posted to, set at approval, so a credit note reverses exactly what the invoice posted
--   even if profiles change later.
-- * app.credit_note (+ lines): against one posted invoice; reason code (GP-029: price_concession,
--   return, scope_reduction, billing_error, goodwill — credit_loss is a write-off, GP-024);
--   draft → posted through the posting engine; frozen once posted like invoices. Lines name the
--   invoice line they credit; GST is proportional at that line's rate.
-- * Tenant-owned: RLS ENABLE + FORCE, tenant_isolation, explicit lf_app grants; nothing deleted.

ALTER TABLE app.sales_invoice_line
  ADD COLUMN account_id uuid,
  ADD COLUMN tax_code_id uuid,
  ADD CONSTRAINT sales_invoice_line_account_fk FOREIGN KEY (tenant_id, company_id, account_id)
    REFERENCES app.account (tenant_id, company_id, id),
  ADD CONSTRAINT sales_invoice_line_tax_code_fk FOREIGN KEY (tenant_id, company_id, tax_code_id)
    REFERENCES app.tax_code (tenant_id, company_id, id);

CREATE TABLE app.credit_note (
  id              uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id       uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                REFERENCES app.tenant (id),
  company_id      uuid          NOT NULL,
  party_id        uuid          NOT NULL,
  invoice_id      uuid          NOT NULL,
  status          text          NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'void')),
  credit_note_no  text          CHECK (length(credit_note_no) BETWEEN 1 AND 40),
  issue_date      date          NOT NULL,
  reason_code     text          NOT NULL CHECK (reason_code IN ('price_concession', 'return', 'scope_reduction',
                                                               'billing_error', 'goodwill')),
  memo            text          CHECK (length(memo) <= 1000),
  net_total       numeric(19,4) NOT NULL CHECK (net_total >= 0),
  tax_total       numeric(19,4) NOT NULL CHECK (tax_total >= 0),
  gross_total     numeric(19,4) NOT NULL CHECK (gross_total > 0),
  created_by      uuid,
  approved_by     uuid,
  approved_at     timestamptz,
  entry_id        uuid,
  created_at      timestamptz   NOT NULL DEFAULT clock_timestamp(),
  updated_at      timestamptz   NOT NULL DEFAULT clock_timestamp(),
  CHECK (status = 'draft' OR (credit_note_no IS NOT NULL AND entry_id IS NOT NULL)),
  UNIQUE (tenant_id, company_id, credit_note_no),
  UNIQUE (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, party_id) REFERENCES app.party (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, invoice_id) REFERENCES app.sales_invoice (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, entry_id) REFERENCES app.journal_entry (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.credit_note IS 'Customer credit (adjustment) note against an invoice (GP-005, GP-029); frozen once posted.';
CREATE INDEX credit_note_invoice_idx ON app.credit_note (tenant_id, company_id, invoice_id, status);

CREATE TABLE app.credit_note_line (
  tenant_id       uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                REFERENCES app.tenant (id),
  company_id      uuid          NOT NULL,
  credit_note_id  uuid          NOT NULL,
  line_no         integer       NOT NULL CHECK (line_no BETWEEN 1 AND 1000),
  invoice_line_no integer       NOT NULL CHECK (invoice_line_no >= 1),
  description     text          NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 1000),
  account_id      uuid          NOT NULL,
  tax_code_id     uuid,
  net             numeric(19,4) NOT NULL CHECK (net >= 0),
  tax             numeric(19,4) NOT NULL CHECK (tax >= 0),
  gross           numeric(19,4) NOT NULL CHECK (gross >= 0),
  PRIMARY KEY (tenant_id, credit_note_id, line_no),
  FOREIGN KEY (tenant_id, company_id, credit_note_id) REFERENCES app.credit_note (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, account_id) REFERENCES app.account (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, tax_code_id) REFERENCES app.tax_code (tenant_id, company_id, id)
);

CREATE FUNCTION app.credit_note_guard() RETURNS trigger
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
  RAISE EXCEPTION 'posted credit note % cannot be changed (status %)', OLD.credit_note_no, OLD.status
    USING ERRCODE = 'check_violation';
END;
$$;
CREATE TRIGGER credit_note_guard BEFORE UPDATE ON app.credit_note
  FOR EACH ROW EXECUTE FUNCTION app.credit_note_guard();

CREATE FUNCTION app.credit_note_line_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  s text;
BEGIN
  SELECT status INTO s FROM app.credit_note WHERE tenant_id = NEW.tenant_id AND id = NEW.credit_note_id;
  -- A credit note this transaction cannot see is refused by RLS and the foreign key.
  IF s IS NOT NULL AND s <> 'draft' THEN
    RAISE EXCEPTION 'lines of a posted credit note cannot be changed (status %)', s
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER credit_note_line_guard BEFORE INSERT OR UPDATE ON app.credit_note_line
  FOR EACH ROW EXECUTE FUNCTION app.credit_note_line_guard();

ALTER TABLE app.credit_note ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.credit_note FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.credit_note
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.credit_note TO lf_app;

ALTER TABLE app.credit_note_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.credit_note_line FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.credit_note_line
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.credit_note_line TO lf_app;
