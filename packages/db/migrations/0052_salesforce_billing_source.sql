-- 0052 — Salesforce billing source: Opportunity / Order and their line items mirrored from the
-- inbound path, the invoice trigger setting, and the invoice note (T-0069, UC-01, design §4.3,
-- §5.5, §5.6, §11.2; RQ-0106; DL-0300). Owner: packages/connectors/salesforce (billing).
-- Applies after 0048–0051.
--
-- * app.salesforce_billing_settings: per company — which Salesforce object triggers the invoice
--   (`opportunity` Closed Won | `order` activated; §11.2 is open, default opportunity), the stage
--   values that mean "won" when IsWon is not in a change (data, RQ-0106 finding 2), and the billing
--   format to issue under (NULL = the active format whose line source matches, STANDARD first).
-- * app.salesforce_billing_source: the latest known state of an Opportunity or Order, built from
--   CDC changes and polled snapshots through app.salesforce_inbound_change (0050) — Salesforce owns
--   every column but invoice_id. invoice_id is set once, when the invoice is drafted; it never
--   changes (one invoice per source; sales_invoice.source_key is unique as well).
-- * app.salesforce_billing_source_line: the latest known state of an OpportunityLineItem or
--   OrderItem. A Salesforce delete archives the row. Money and quantity are NUMERIC from the
--   boundary conversion of RQ-0106 finding 5 (no floating point is stored).
-- * app.sales_invoice.note: a document note, e.g. "dated … posted on the first open date …" when
--   the lock-date policy moved the date (design §2, §5.6 rule 5). Additive; frozen with the invoice.
-- * Tenant-owned: RLS ENABLE + FORCE, tenant_isolation, explicit lf_app grants (UPDATE only on the
--   mutable columns, so identity and tenant never move). Nothing is deleted.

CREATE TABLE app.salesforce_billing_settings (
  tenant_id          uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                 REFERENCES app.tenant (id),
  company_id         uuid        NOT NULL,
  invoice_trigger    text        NOT NULL DEFAULT 'opportunity' CHECK (invoice_trigger IN ('opportunity', 'order')),
  won_stages         text[]      NOT NULL DEFAULT '{Closed Won}'
                                 CHECK (cardinality(won_stages) BETWEEN 1 AND 20),
  billing_format_id  uuid,
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, company_id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, billing_format_id) REFERENCES app.billing_format (tenant_id, company_id, id)
);
COMMENT ON TABLE app.salesforce_billing_settings IS
  'Salesforce invoice trigger per company (UC-01, design 11.2 open: opportunity | order), won stage values and billing format.';

CREATE TABLE app.salesforce_billing_source (
  id                 uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id          uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                   REFERENCES app.tenant (id),
  company_id         uuid          NOT NULL,
  entity_name        text          NOT NULL CHECK (entity_name IN ('Opportunity', 'Order')),
  record_id          text          NOT NULL CHECK (record_id ~ '^[a-zA-Z0-9]{18}$'),
  account_record_id  text          CHECK (account_record_id ~ '^[a-zA-Z0-9]{18}$'),
  name               text          CHECK (length(name) <= 255),
  stage_name         text          CHECK (length(stage_name) <= 255),
  is_won             boolean,
  status             text          CHECK (length(status) <= 255),
  status_code        text          CHECK (length(status_code) <= 40),
  source_date        date,
  amount             numeric(19,4),
  currency           char(3)       CHECK (currency ~ '^[A-Z]{3}$'),
  archived           boolean       NOT NULL DEFAULT false,
  invoice_id         uuid,
  created_at         timestamptz   NOT NULL DEFAULT clock_timestamp(),
  updated_at         timestamptz   NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, company_id, entity_name, record_id),
  UNIQUE (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, invoice_id) REFERENCES app.sales_invoice (tenant_id, company_id, id)
);
COMMENT ON TABLE app.salesforce_billing_source IS
  'Latest known state of a Salesforce Opportunity / Order (Salesforce-owned), and the one invoice drafted from it.';

CREATE TABLE app.salesforce_billing_source_line (
  id                  uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id           uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                    REFERENCES app.tenant (id),
  company_id          uuid          NOT NULL,
  entity_name         text          NOT NULL CHECK (entity_name IN ('OpportunityLineItem', 'OrderItem')),
  record_id           text          NOT NULL CHECK (record_id ~ '^[a-zA-Z0-9]{18}$'),
  parent_record_id    text          CHECK (parent_record_id ~ '^[a-zA-Z0-9]{18}$'),
  product2_record_id  text          CHECK (product2_record_id ~ '^[a-zA-Z0-9]{18}$'),
  quantity            numeric(18,4),
  unit_price          numeric(19,4),
  total_price         numeric(19,4),
  description         text          CHECK (length(description) <= 4000),
  archived            boolean       NOT NULL DEFAULT false,
  created_at          timestamptz   NOT NULL DEFAULT clock_timestamp(),
  updated_at          timestamptz   NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, company_id, entity_name, record_id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id)
);
COMMENT ON TABLE app.salesforce_billing_source_line IS
  'Latest known state of a Salesforce OpportunityLineItem / OrderItem (Salesforce-owned); a delete archives it.';
CREATE INDEX salesforce_billing_source_line_parent_idx
  ON app.salesforce_billing_source_line (tenant_id, company_id, parent_record_id);

-- Identity never changes; the invoice link is set once and then frozen.
CREATE FUNCTION app.salesforce_billing_source_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.company_id, NEW.entity_name, NEW.record_id, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.company_id, OLD.entity_name, OLD.record_id, OLD.created_at) THEN
    RAISE EXCEPTION 'billing source % %: identity columns never change', OLD.entity_name, OLD.record_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.invoice_id IS NOT NULL AND NEW.invoice_id IS DISTINCT FROM OLD.invoice_id THEN
    RAISE EXCEPTION 'billing source % %: its invoice never changes', OLD.entity_name, OLD.record_id
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$$;
CREATE TRIGGER salesforce_billing_source_guard BEFORE UPDATE ON app.salesforce_billing_source
  FOR EACH ROW EXECUTE FUNCTION app.salesforce_billing_source_guard();
CREATE TRIGGER salesforce_billing_source_never_deleted BEFORE DELETE ON app.salesforce_billing_source
  FOR EACH ROW EXECUTE FUNCTION app.sod_never_changed();

CREATE FUNCTION app.salesforce_billing_source_line_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.company_id, NEW.entity_name, NEW.record_id, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.company_id, OLD.entity_name, OLD.record_id, OLD.created_at) THEN
    RAISE EXCEPTION 'billing source line % %: identity columns never change', OLD.entity_name, OLD.record_id
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$$;
CREATE TRIGGER salesforce_billing_source_line_guard BEFORE UPDATE ON app.salesforce_billing_source_line
  FOR EACH ROW EXECUTE FUNCTION app.salesforce_billing_source_line_guard();
CREATE TRIGGER salesforce_billing_source_line_never_deleted BEFORE DELETE ON app.salesforce_billing_source_line
  FOR EACH ROW EXECUTE FUNCTION app.sod_never_changed();

ALTER TABLE app.sales_invoice
  ADD COLUMN note text CHECK (length(note) BETWEEN 1 AND 1000);
COMMENT ON COLUMN app.sales_invoice.note IS
  'Document note (T-0069), e.g. the lock-date policy moved the issue date to the first open date.';

ALTER TABLE app.salesforce_billing_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.salesforce_billing_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.salesforce_billing_settings
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.salesforce_billing_settings TO lf_app;
GRANT UPDATE (invoice_trigger, won_stages, billing_format_id, updated_at)
  ON app.salesforce_billing_settings TO lf_app;

ALTER TABLE app.salesforce_billing_source ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.salesforce_billing_source FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.salesforce_billing_source
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.salesforce_billing_source TO lf_app;
GRANT UPDATE (account_record_id, name, stage_name, is_won, status, status_code, source_date, amount,
              currency, archived, invoice_id, updated_at)
  ON app.salesforce_billing_source TO lf_app;

ALTER TABLE app.salesforce_billing_source_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.salesforce_billing_source_line FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.salesforce_billing_source_line
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.salesforce_billing_source_line TO lf_app;
GRANT UPDATE (parent_record_id, product2_record_id, quantity, unit_price, total_price, description,
              archived, updated_at)
  ON app.salesforce_billing_source_line TO lf_app;
