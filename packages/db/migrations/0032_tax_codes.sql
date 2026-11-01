-- 0032 — Tax codes per company, effective-dated; company tax rounding rule (T-0118, design §3.4
-- and §3.6, postings.md Q8, GP-023, DL-0261). Owner: packages/modules/tax (catalogue and seed),
-- packages/ledger (validates journal_line.tax_code_id).
--
-- * app.tax_code: one row per (company, code, effective range). A rate change is a new row whose
--   range follows the old one (closed by effective_to), never an edit of the rate, so posted lines
--   keep pointing at the rate they were taxed at. Ranges of one code never overlap (trigger below,
--   serialised by an advisory lock on the code). Collected/paid accounts are optional (NULL = the
--   GST_COLLECTED / GST_PAID system role). lf_app may change only name, effective_to, status and
--   the two accounts; code, kind, rate, labels and effective_from are fixed once inserted.
-- * app.company.tax_rounding: the GST rounding rule, 'total_invoice' (ATO total invoice rule,
--   AU default, Q8) or 'per_line_2dp' (taxable supply rule, opt-in).
-- * app.journal_line.tax_code_id now references the company's tax code (same tenant and company).
-- * Tenant-owned: RLS ENABLE + FORCE, tenant_isolation, explicit lf_app grants.

CREATE TABLE app.tax_code (
  id               uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id        uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                               REFERENCES app.tenant (id),
  company_id       uuid        NOT NULL,
  code             text        NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9-]*$' AND length(code) <= 40),
  name             text        NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  kind             text        NOT NULL CHECK (kind IN ('taxable', 'gst_free', 'input_taxed',
                                                     'bas_excluded', 'import', 'capital', 'adjustment')),
  rate             numeric(18,8) NOT NULL CHECK (rate >= 0 AND rate < 1),
  effective_from   date        NOT NULL,
  effective_to     date        CHECK (effective_to >= effective_from),
  sales_labels     text[]      NOT NULL DEFAULT '{}',
  purchase_labels  text[]      NOT NULL DEFAULT '{}',
  collected_account_id uuid,
  paid_account_id  uuid,
  verify           boolean     NOT NULL DEFAULT false,
  status           text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, company_id, id),
  UNIQUE (tenant_id, company_id, code, effective_from),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, collected_account_id) REFERENCES app.account (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, paid_account_id) REFERENCES app.account (tenant_id, company_id, id)
);
COMMENT ON TABLE app.tax_code IS
  'Tax code per company, effective-dated (design 3.6). A rate change is a new row; ranges of a code never overlap.';
COMMENT ON COLUMN app.tax_code.collected_account_id IS
  'Account for tax on sales; NULL = the company GST_COLLECTED system role.';
COMMENT ON COLUMN app.tax_code.paid_account_id IS
  'Account for tax on purchases; NULL = the company GST_PAID system role.';
COMMENT ON COLUMN app.tax_code.verify IS
  'True while a BAS label mapping still needs checking against the ATO BAS instructions (RQ-0096).';

-- No two ranges of the same code overlap. Runs for every role; the advisory lock serialises
-- concurrent writers of one code so two transactions cannot each insert an overlapping range.
CREATE FUNCTION app.tax_code_no_overlap() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'lf.tax_code:' || NEW.tenant_id::text || ':' || NEW.company_id::text || ':' || NEW.code, 0));
  IF EXISTS (
    SELECT 1 FROM app.tax_code t
     WHERE t.tenant_id = NEW.tenant_id AND t.company_id = NEW.company_id AND t.code = NEW.code
       AND t.id <> NEW.id
       AND daterange(t.effective_from, t.effective_to, '[]')
           && daterange(NEW.effective_from, NEW.effective_to, '[]')
  ) THEN
    RAISE EXCEPTION 'tax code % effective ranges overlap (from %)', NEW.code, NEW.effective_from
      USING ERRCODE = 'exclusion_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tax_code_no_overlap BEFORE INSERT OR UPDATE ON app.tax_code
  FOR EACH ROW EXECUTE FUNCTION app.tax_code_no_overlap();

CREATE INDEX tax_code_lookup_idx ON app.tax_code (tenant_id, company_id, code, effective_from);

ALTER TABLE app.tax_code ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tax_code FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.tax_code
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.tax_code TO lf_app;
GRANT UPDATE (name, effective_to, status, collected_account_id, paid_account_id) ON app.tax_code TO lf_app;

-- ---------------------------------------------------------------------------------------------
-- Company GST rounding rule (Q8)

ALTER TABLE app.company
  ADD COLUMN tax_rounding text NOT NULL DEFAULT 'total_invoice'
    CONSTRAINT company_tax_rounding_check CHECK (tax_rounding IN ('total_invoice', 'per_line_2dp'));
COMMENT ON COLUMN app.company.tax_rounding IS
  'GST rounding: total_invoice (ATO total invoice rule, default) or per_line_2dp (taxable supply rule).';
-- lf_app already holds UPDATE on app.company (0002).

-- ---------------------------------------------------------------------------------------------
-- Journal lines reference the company's tax code

ALTER TABLE app.journal_line
  ADD CONSTRAINT journal_line_tax_code_fk
  FOREIGN KEY (tenant_id, company_id, tax_code_id) REFERENCES app.tax_code (tenant_id, company_id, id);
CREATE INDEX journal_line_tax_code_idx ON app.journal_line (tenant_id, company_id, tax_code_id)
  WHERE tax_code_id IS NOT NULL;
