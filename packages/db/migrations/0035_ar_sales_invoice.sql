-- 0035 — Sales invoices: draft → approve → post (T-0040, design §3.8 row 1, §4.2, UC-01, DL-0268).
-- Owner: packages/modules/ar.
--
-- * app.sales_invoice: the document. A draft is freely edited; approval posts it through the
--   posting engine in the same transaction (status 'posted', invoice_no from the company's
--   ar_invoice_document series, entry_id = the journal entry). From then on the header is frozen:
--   only a later status change to 'void' (by a reversal, a later task) is allowed.
-- * app.sales_invoice_line: lines may be inserted or changed only while the invoice is a draft.
--   amount = quantity × unit price rounded to cents (computed by the module); net/tax/gross per
--   line are set at approval from the GST calculator (company tax_rounding, pricing).
-- * app.ar_settings: per company — auto-approve on/off and its threshold (gross, base currency).
-- * warnings (jsonb): what blocks approval right now (e.g. PROFILE_GAP), for the draft screen
--   and the Closed Won flow (T-0069).
-- * Tenant-owned: RLS ENABLE + FORCE, tenant_isolation, explicit lf_app grants; nothing deleted.

CREATE TABLE app.sales_invoice (
  id            uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id     uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                              REFERENCES app.tenant (id),
  company_id    uuid          NOT NULL,
  party_id      uuid          NOT NULL,
  status        text          NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'void')),
  invoice_no    text          CHECK (length(invoice_no) BETWEEN 1 AND 40),
  issue_date    date          NOT NULL,
  due_date      date          NOT NULL,
  pricing       text          NOT NULL DEFAULT 'exclusive' CHECK (pricing IN ('exclusive', 'inclusive')),
  currency      char(3)       NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  reference     text          CHECK (length(reference) <= 200),
  source_key    text          CHECK (length(source_key) BETWEEN 1 AND 200),
  net_total     numeric(19,4),
  tax_total     numeric(19,4),
  gross_total   numeric(19,4),
  warnings      jsonb         NOT NULL DEFAULT '[]',
  created_by    uuid,
  approved_by   uuid,
  approved_at   timestamptz,
  entry_id      uuid,
  created_at    timestamptz   NOT NULL DEFAULT clock_timestamp(),
  updated_at    timestamptz   NOT NULL DEFAULT clock_timestamp(),
  CHECK (due_date >= issue_date),
  CHECK (status = 'draft' OR (invoice_no IS NOT NULL AND entry_id IS NOT NULL AND gross_total IS NOT NULL)),
  UNIQUE (tenant_id, company_id, invoice_no),
  UNIQUE (tenant_id, company_id, source_key),
  UNIQUE (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, party_id) REFERENCES app.party (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, entry_id) REFERENCES app.journal_entry (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.sales_invoice IS 'Sales invoice (design 3.8 row 1): draft, then posted through the engine; frozen once posted.';
CREATE INDEX sales_invoice_party_idx ON app.sales_invoice (tenant_id, company_id, party_id, status);

CREATE TABLE app.sales_invoice_line (
  tenant_id          uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                   REFERENCES app.tenant (id),
  company_id         uuid          NOT NULL,
  invoice_id         uuid          NOT NULL,
  line_no            integer       NOT NULL CHECK (line_no BETWEEN 1 AND 1000),
  product_id         uuid,
  product_profile_id uuid          NOT NULL,
  description        text          NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 1000),
  quantity           numeric(18,4) NOT NULL CHECK (quantity > 0),
  unit_price         numeric(19,4) NOT NULL CHECK (unit_price >= 0),
  amount             numeric(19,4) NOT NULL CHECK (amount >= 0),
  tax_code           text          CHECK (tax_code ~ '^[A-Z][A-Z0-9-]*$'),
  net                numeric(19,4),
  tax                numeric(19,4),
  gross              numeric(19,4),
  PRIMARY KEY (tenant_id, invoice_id, line_no),
  FOREIGN KEY (tenant_id, company_id, invoice_id) REFERENCES app.sales_invoice (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, product_id) REFERENCES app.product (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, product_profile_id)
    REFERENCES app.product_posting_profile (tenant_id, company_id, id)
);
COMMENT ON TABLE app.sales_invoice_line IS 'Sales invoice line; changeable only while the invoice is a draft.';

-- A posted (or void) invoice is frozen; the only change allowed is posted → void.
CREATE FUNCTION app.sales_invoice_guard() RETURNS trigger
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
  RAISE EXCEPTION 'posted invoice % cannot be changed (status %)', OLD.invoice_no, OLD.status
    USING ERRCODE = 'check_violation';
END;
$$;
CREATE TRIGGER sales_invoice_guard BEFORE UPDATE ON app.sales_invoice
  FOR EACH ROW EXECUTE FUNCTION app.sales_invoice_guard();

CREATE FUNCTION app.sales_invoice_line_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  s text;
BEGIN
  SELECT status INTO s FROM app.sales_invoice WHERE tenant_id = NEW.tenant_id AND id = NEW.invoice_id;
  -- An invoice this transaction cannot see (another tenant's) is refused by RLS and the foreign
  -- key, not here.
  IF s IS NOT NULL AND s <> 'draft' THEN
    RAISE EXCEPTION 'lines of a posted invoice cannot be changed (invoice %, status %)', NEW.invoice_id, s
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sales_invoice_line_guard BEFORE INSERT OR UPDATE ON app.sales_invoice_line
  FOR EACH ROW EXECUTE FUNCTION app.sales_invoice_line_guard();

CREATE TABLE app.ar_settings (
  tenant_id              uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                       REFERENCES app.tenant (id),
  company_id             uuid          NOT NULL,
  auto_approve           boolean       NOT NULL DEFAULT false,
  auto_approve_threshold numeric(19,4) CHECK (auto_approve_threshold >= 0),
  updated_at             timestamptz   NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, company_id),
  CHECK (NOT auto_approve OR auto_approve_threshold IS NOT NULL),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id)
);
COMMENT ON TABLE app.ar_settings IS 'AR settings per company: invoice auto-approve and its gross threshold (UC-01).';

ALTER TABLE app.sales_invoice ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.sales_invoice FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.sales_invoice
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.sales_invoice TO lf_app;

ALTER TABLE app.sales_invoice_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.sales_invoice_line FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.sales_invoice_line
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.sales_invoice_line TO lf_app;

ALTER TABLE app.ar_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ar_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.ar_settings
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.ar_settings TO lf_app;
