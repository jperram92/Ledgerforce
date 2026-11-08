-- 0037 — ar: sales invoice documents draft → approved → posted, and the auto-approve setting
-- (T-0040, design §3.8 row 1, §4.2, §4.3, UC-01; RQ-0104; golden postings GP-001, GP-018).
-- Owner: packages/modules/ar.
--
-- * app.sales_invoice: the document. Its journal is written only by the posting engine (source
--   type ar_invoice, source_id = the invoice id, idempotency key ar_invoice:<id>); this is not a
--   ledger table, so lf_app may UPDATE it, but only along draft → approved → posted.
-- * app.sales_invoice_line: product, amount (tax-exclusive or -inclusive per the header) and an
--   optional explicit tax code (needed when the posting-profile defaults conflict, DL-0260).
--   Lines change only while their invoice is a draft.
-- * Guards: posted invoices never change (corrections are credit notes/reversals); id, tenant,
--   company, key and creator never change; content changes only in draft; the approval facts
--   (totals, approver) are frozen once approved; workflow timestamps come from the database
--   clock; a posted invoice must name the ar_invoice entry the engine wrote for it (same company,
--   source_id = invoice id, approved_by = the invoice's approver) and an invoice number.
-- * Approval needs an active Billing To contact with an email (design §4.2, SS-UC01-05):
--   checked by the module and again here (NO_BILLING_TO).
-- * app.ar_invoice_settings: auto-approve on/off and threshold per company as an insert-only
--   history (latest row wins; set_by and reason), like app.sod_settings. Who may set it
--   (Finance Admin) is enforced at the API (T-0116).
-- * DELETE is never granted (directive 6). Triggers skip rows of another tenant, so RLS WITH
--   CHECK refuses them with 42501.

CREATE TABLE app.sales_invoice (
  id                uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id         uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                  REFERENCES app.tenant (id),
  company_id        uuid          NOT NULL,
  party_id          uuid          NOT NULL,
  status            text          NOT NULL DEFAULT 'draft'
                                  CHECK (status IN ('draft', 'approved', 'posted')),
  invoice_no        text          CHECK (invoice_no IS NULL OR length(invoice_no) BETWEEN 1 AND 60),
  invoice_date      date          NOT NULL,
  due_date          date          NOT NULL,
  amounts_are       text          NOT NULL DEFAULT 'exclusive'
                                  CHECK (amounts_are IN ('exclusive', 'inclusive')),
  currency          char(3)       NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  memo              text          CHECK (memo IS NULL OR length(memo) <= 2000),
  idempotency_key   text          NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  created_by        uuid,
  created_at        timestamptz   NOT NULL DEFAULT clock_timestamp(),
  approval_kind     text          CHECK (approval_kind IS NULL OR approval_kind IN ('user', 'auto')),
  approved_by       uuid,
  approved_at       timestamptz,
  net_total         numeric(19,4) CHECK (net_total IS NULL OR net_total >= 0),
  tax_total         numeric(19,4) CHECK (tax_total IS NULL OR tax_total >= 0),
  total             numeric(19,4) CHECK (total IS NULL OR total > 0),
  posted_by         uuid,
  posted_at         timestamptz,
  journal_entry_id  uuid,
  CONSTRAINT sales_invoice_due_after_date CHECK (due_date >= invoice_date),
  CONSTRAINT sales_invoice_approval_facts CHECK (
    (status = 'draft') = (approval_kind IS NULL)
    AND (approval_kind IS NULL) = (approved_at IS NULL)
    AND (approval_kind IS NULL) = (total IS NULL)
    AND (total IS NULL) = (net_total IS NULL) AND (total IS NULL) = (tax_total IS NULL)
    AND (approval_kind IS DISTINCT FROM 'user' OR approved_by IS NOT NULL)
    AND (approval_kind IS DISTINCT FROM 'auto' OR approved_by IS NULL)
    AND (approval_kind IS NOT NULL OR approved_by IS NULL)),
  CONSTRAINT sales_invoice_posting_facts CHECK (
    (status = 'posted') = (journal_entry_id IS NOT NULL)
    AND (journal_entry_id IS NULL) = (posted_at IS NULL)
    AND (journal_entry_id IS NULL) = (invoice_no IS NULL)
    AND (journal_entry_id IS NOT NULL OR posted_by IS NULL)),
  UNIQUE (tenant_id, company_id, id),
  UNIQUE (tenant_id, company_id, idempotency_key),
  UNIQUE (tenant_id, company_id, invoice_no),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, party_id) REFERENCES app.party (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, journal_entry_id) REFERENCES app.journal_entry (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES app.app_user (tenant_id, id),
  FOREIGN KEY (tenant_id, posted_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.sales_invoice IS
  'Sales invoices (design 3.8, 4.3). Posted only through the posting engine (ar_invoice); posted rows never change.';
COMMENT ON COLUMN app.sales_invoice.invoice_no IS
  'Document number from series ar_invoice, taken inside the posting transaction (design 3.4).';
COMMENT ON COLUMN app.sales_invoice.approval_kind IS
  'user = approved by approved_by; auto = auto-approved under the company threshold (UC-01).';
CREATE INDEX sales_invoice_status_idx ON app.sales_invoice (tenant_id, company_id, status, invoice_date);
CREATE INDEX sales_invoice_party_idx ON app.sales_invoice (tenant_id, company_id, party_id);
CREATE UNIQUE INDEX sales_invoice_entry_uq ON app.sales_invoice (tenant_id, journal_entry_id)
  WHERE journal_entry_id IS NOT NULL;

ALTER TABLE app.sales_invoice ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.sales_invoice FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.sales_invoice
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.sales_invoice TO lf_app;

CREATE TABLE app.sales_invoice_line (
  id           uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id    uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                             REFERENCES app.tenant (id),
  company_id   uuid          NOT NULL,
  invoice_id   uuid          NOT NULL,
  line_no      integer       NOT NULL CHECK (line_no BETWEEN 1 AND 10000),
  product_id   uuid          NOT NULL,
  description  text          CHECK (description IS NULL OR length(description) <= 2000),
  amount       numeric(19,4) NOT NULL CHECK (amount > 0),
  tax_code     text          CHECK (tax_code IS NULL OR tax_code ~ '^[A-Z][A-Z0-9-]{0,11}$'),
  UNIQUE (tenant_id, invoice_id, line_no),
  FOREIGN KEY (tenant_id, company_id, invoice_id) REFERENCES app.sales_invoice (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, product_id) REFERENCES app.product (tenant_id, company_id, id)
);
COMMENT ON TABLE app.sales_invoice_line IS
  'Sales invoice lines; amount is tax-exclusive or tax-inclusive per sales_invoice.amounts_are. Change only while the invoice is a draft.';
COMMENT ON COLUMN app.sales_invoice_line.tax_code IS
  'Explicit tax code key (app.tax_code.code); wins over the posting-profile defaults (DL-0260).';

ALTER TABLE app.sales_invoice_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.sales_invoice_line FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.sales_invoice_line
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.sales_invoice_line TO lf_app;

-- Billing To rule (design §4.2): an active billing_to role on an active contact with an email.
CREATE FUNCTION app.party_has_billing_to(p_tenant uuid, p_company uuid, p_party uuid) RETURNS boolean
  LANGUAGE sql STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.party_contact_role r
      JOIN app.party_contact c ON c.tenant_id = r.tenant_id AND c.id = r.contact_id
     WHERE r.tenant_id = p_tenant AND r.company_id = p_company AND r.party_id = p_party
       AND r.role = 'billing_to' AND r.active AND c.status = 'active' AND c.email IS NOT NULL)
$$;
GRANT EXECUTE ON FUNCTION app.party_has_billing_to(uuid, uuid, uuid) TO lf_app;

CREATE FUNCTION app.sales_invoice_insert_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT app.sod_is_superuser() THEN
    NEW.created_at := clock_timestamp();
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW;
  END IF;
  IF NEW.status <> 'draft' OR NEW.approval_kind IS NOT NULL OR NEW.journal_entry_id IS NOT NULL
     OR NEW.invoice_no IS NOT NULL THEN
    RAISE EXCEPTION 'sales invoice %: a new invoice is a plain draft', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER sales_invoice_insert_guard BEFORE INSERT ON app.sales_invoice
  FOR EACH ROW EXECUTE FUNCTION app.sales_invoice_insert_guard();

CREATE FUNCTION app.sales_invoice_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  e record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'app.sales_invoice rows are never deleted (directive 6)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'posted' THEN
    RAISE EXCEPTION 'sales invoice % is posted and cannot change; correct it by a credit note or reversal', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.company_id <> OLD.company_id
     OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'sales invoice %: id, company, key and creator never change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'draft' AND (NEW.party_id <> OLD.party_id OR NEW.invoice_date <> OLD.invoice_date
       OR NEW.due_date <> OLD.due_date OR NEW.amounts_are <> OLD.amounts_are
       OR NEW.currency <> OLD.currency OR NEW.memo IS DISTINCT FROM OLD.memo) THEN
    RAISE EXCEPTION 'sales invoice %: only a draft can be edited', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD.status, NEW.status) NOT IN (('draft', 'draft'), ('draft', 'approved'), ('approved', 'posted')) THEN
    RAISE EXCEPTION 'sales invoice %: % → % is not a workflow step', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'approved' AND (NEW.approval_kind IS DISTINCT FROM OLD.approval_kind
       OR NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.approved_at <> OLD.approved_at
       OR NEW.net_total <> OLD.net_total OR NEW.tax_total <> OLD.tax_total OR NEW.total <> OLD.total) THEN
    RAISE EXCEPTION 'sales invoice %: the approval is frozen', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'draft' AND NEW.status = 'approved'
     AND NOT app.party_has_billing_to(NEW.tenant_id, NEW.company_id, NEW.party_id) THEN
    RAISE EXCEPTION 'NO_BILLING_TO: sales invoice % cannot be approved: the customer has no active Billing To contact with an email (design 4.2)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT app.sod_is_superuser() THEN
    IF OLD.status = 'draft' AND NEW.status = 'approved' THEN
      NEW.approved_at := clock_timestamp();
    ELSIF NEW.status = 'posted' THEN
      NEW.posted_at := clock_timestamp();
    END IF;
  END IF;

  IF NEW.status = 'posted' THEN
    SELECT je.source_type, je.source_id, je.approved_by, je.status INTO e
      FROM app.journal_entry je
     WHERE je.tenant_id = NEW.tenant_id AND je.company_id = NEW.company_id AND je.id = NEW.journal_entry_id;
    IF NOT FOUND OR e.source_type <> 'ar_invoice' OR e.source_id IS DISTINCT FROM NEW.id::text
       OR e.approved_by IS DISTINCT FROM NEW.approved_by OR e.status <> 'posted' THEN
      RAISE EXCEPTION 'sales invoice %: journal entry % is not the engine''s posting of this invoice',
        OLD.id, NEW.journal_entry_id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER sales_invoice_guard BEFORE UPDATE OR DELETE ON app.sales_invoice
  FOR EACH ROW EXECUTE FUNCTION app.sales_invoice_guard();

CREATE FUNCTION app.sales_invoice_line_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  st text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'app.sales_invoice_line rows are never deleted (directive 6)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id
       OR NEW.company_id <> OLD.company_id OR NEW.invoice_id <> OLD.invoice_id) THEN
    RAISE EXCEPTION 'sales invoice line %: id, company and invoice never change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT i.status INTO st FROM app.sales_invoice i
   WHERE i.tenant_id = NEW.tenant_id AND i.company_id = NEW.company_id AND i.id = NEW.invoice_id
     FOR SHARE;
  IF st IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'sales invoice %: only a draft can be edited (invoice is %)', NEW.invoice_id,
      coalesce(st, 'missing') USING ERRCODE = 'check_violation';
  END IF;
  PERFORM app.assert_tax_code_exists(NEW.tenant_id, NEW.company_id, NEW.tax_code);
  RETURN NEW;
END
$$;
CREATE TRIGGER sales_invoice_line_guard BEFORE INSERT OR UPDATE OR DELETE ON app.sales_invoice_line
  FOR EACH ROW EXECUTE FUNCTION app.sales_invoice_line_guard();

-- Auto-approve setting (UC-01 main flow 6; design §4.3) --------------------------------------------

CREATE TABLE app.ar_invoice_settings (
  id                      uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id               uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                        REFERENCES app.tenant (id),
  company_id              uuid          NOT NULL,
  auto_approve            boolean       NOT NULL DEFAULT false,
  auto_approve_threshold  numeric(19,4) NOT NULL DEFAULT 0 CHECK (auto_approve_threshold >= 0),
  set_by                  uuid          NOT NULL,
  reason                  text          NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  set_at                  timestamptz   NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, set_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.ar_invoice_settings IS
  'Sales-invoice auto-approve setting per company as history; the latest row wins (UC-01). Insert-only.';
CREATE INDEX ar_invoice_settings_latest_idx ON app.ar_invoice_settings (tenant_id, company_id, set_at DESC, id DESC);
CREATE TRIGGER ar_invoice_settings_immutable BEFORE UPDATE OR DELETE ON app.ar_invoice_settings
  FOR EACH ROW EXECUTE FUNCTION app.sod_never_changed();

ALTER TABLE app.ar_invoice_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ar_invoice_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.ar_invoice_settings
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.ar_invoice_settings TO lf_app;
