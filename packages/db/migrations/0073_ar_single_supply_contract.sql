-- 0073 — Single-supply GST attribution: the GST_ATTRIBUTED_UNBILLED role and the contract,
-- attribution, receipt and status records (T-0203, ADR-0089 R1–R5, R8, R11, RQ-0171, DL-0760..).
-- Owners: packages/modules/gl (the role) and packages/modules/ar (the contract tables).
--
-- * app.system_role_is_extended / app.system_role_allows are WIDENED by CREATE OR REPLACE
--   (ADR-0061 pattern; stored rows stay valid): GST_ATTRIBUTED_UNBILLED is an extended role bound
--   in app.account_system_role_ext, allowed on an asset account only, not control, postable. Every
--   earlier rule is repeated unchanged. packages/modules/gl system-roles.ts mirrors both.
-- * app.single_supply_contract: a single (non-Div 156) supply with a known GST-exclusive total,
--   one taxable tax code and the GST basis in force on the contract date. The person who
--   confirmed the legal classification and when (ADR-0089 R1). dimension_value_id is the
--   contract's value of the company's `supply_contract` dimension: every contract line on
--   CUSTOMER_PREPAYMENTS and GST_ATTRIBUTED_UNBILLED carries it, so balances are kept per contract
--   (review MINOR-1/MINOR-3, T-0203 AC-7, DL-0762).
-- * app.single_supply_attribution: the one attribution of a contract's whole GST (GP-040a), at most
--   one row per contract (UNIQUE contract_id) — the database backstop for "exactly one first
--   receipt" under concurrency. Accruals only; a cash-basis contract never has one (R8).
-- * app.single_supply_receipt: each receipt on a contract (GP-040a/b on accruals, GP-020 on cash)
--   with its GST part. The 0042 customer_prepayment.supply_type CHECK is not widened (that would
--   need a DROP); single-supply receipts live here instead.
-- * app.single_supply_contract_status: successor rows (finalised / cancelled, at most one per
--   contract) — no row means open. Written by T-0204; read by every receipt.
-- * All four are immutable (UPDATE/DELETE raise; lf_app SELECT/INSERT only), tenant-owned with
--   RLS ENABLE + FORCE and the tenant_isolation policy. Money NUMERIC(19,4), whole cents.

CREATE OR REPLACE FUNCTION app.system_role_is_extended(role text) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT role IN ('AR_ECL_ALLOWANCE', 'PREPAYMENTS', 'ACCUM_DEPRECIATION', 'DEPRECIATION_EXPENSE',
                  'ACCRUED_EXPENSES', 'SGC_PAYABLE', 'PRIOR_PERIOD_ADJUSTMENTS',
                  'GST_ATTRIBUTED_UNBILLED')
$$;

CREATE OR REPLACE FUNCTION app.system_role_allows(role text, account_type text) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT CASE role
    WHEN 'AR_CONTROL'               THEN account_type = 'asset'
    WHEN 'UNDEPOSITED_FUNDS'        THEN account_type = 'asset'
    WHEN 'GST_PAID'                 THEN account_type = 'asset'
    WHEN 'AP_CONTROL'               THEN account_type = 'liability'
    WHEN 'GST_COLLECTED'            THEN account_type = 'liability'
    WHEN 'PAYROLL_CLEARING'         THEN account_type = 'liability'
    WHEN 'WAGES_PAYABLE'            THEN account_type = 'liability'
    WHEN 'PAYG_WITHHOLDING'         THEN account_type = 'liability'
    WHEN 'SUPER_PAYABLE'            THEN account_type = 'liability'
    WHEN 'DEFERRED_REVENUE'         THEN account_type = 'liability'
    WHEN 'CUSTOMER_PREPAYMENTS'     THEN account_type = 'liability'
    WHEN 'RETAINED_EARNINGS'        THEN account_type = 'equity'
    WHEN 'CURRENT_YEAR_EARNINGS'    THEN account_type = 'equity'
    WHEN 'ROUNDING'                 THEN account_type IN ('expense', 'revenue')
    WHEN 'FX_REALISED'              THEN account_type IN ('expense', 'revenue')
    WHEN 'FX_UNREALISED'            THEN account_type IN ('expense', 'revenue')
    WHEN 'SUSPENSE'                 THEN account_type IN ('asset', 'liability')
    -- Period-end roles (0062, ADR-0061, RQ-0143).
    WHEN 'AR_ECL_ALLOWANCE'         THEN account_type = 'asset'
    WHEN 'PREPAYMENTS'              THEN account_type = 'asset'
    WHEN 'ACCUM_DEPRECIATION'       THEN account_type = 'asset'
    WHEN 'DEPRECIATION_EXPENSE'     THEN account_type = 'expense'
    WHEN 'ACCRUED_EXPENSES'         THEN account_type = 'liability'
    WHEN 'SGC_PAYABLE'              THEN account_type = 'liability'
    WHEN 'PRIOR_PERIOD_ADJUSTMENTS' THEN account_type = 'equity'
    -- Single-supply GST attribution (0073, ADR-0089 R3, RQ-0171).
    WHEN 'GST_ATTRIBUTED_UNBILLED'  THEN account_type = 'asset'
    ELSE false
  END
$$;
COMMENT ON FUNCTION app.system_role_allows(text, text) IS
  'Which account types a system role may bind to (design 3.2; 0062 period-end roles; 0073 GST_ATTRIBUTED_UNBILLED). Mirrored in modules/gl system-roles.ts.';

CREATE TABLE app.single_supply_contract (
  id                  uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id           uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                    REFERENCES app.tenant (id),
  company_id          uuid          NOT NULL,
  party_id            uuid          NOT NULL,
  reference           text          NOT NULL CHECK (length(btrim(reference)) BETWEEN 1 AND 100),
  contract_date       date          NOT NULL,
  known_net           numeric(19,4) NOT NULL CHECK (known_net > 0 AND known_net = round(known_net, 2)),
  tax_code_id         uuid          NOT NULL,
  gst_basis           text          NOT NULL CHECK (gst_basis IN ('cash', 'accrual')),
  dimension_value_id  uuid          NOT NULL,
  confirmed_by        uuid          NOT NULL,
  confirmed_at        timestamptz   NOT NULL DEFAULT clock_timestamp(),
  idempotency_key     text          NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  UNIQUE (tenant_id, company_id, idempotency_key),
  UNIQUE (tenant_id, company_id, id),
  UNIQUE (tenant_id, company_id, dimension_value_id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, party_id) REFERENCES app.party (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, tax_code_id) REFERENCES app.tax_code (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, dimension_value_id) REFERENCES app.dimension_value (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, confirmed_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.single_supply_contract IS
  'Single supply with a known total (ADR-0089 R1/R2): party, GST-exclusive total, one taxable code, GST basis, classification confirmed by/at. Immutable; status by successor rows.';

CREATE TABLE app.single_supply_attribution (
  tenant_id         uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                  REFERENCES app.tenant (id),
  company_id        uuid          NOT NULL,
  contract_id       uuid          NOT NULL,
  attribution_date  date          NOT NULL,
  attributed_tax    numeric(19,4) NOT NULL CHECK (attributed_tax >= 0 AND attributed_tax = round(attributed_tax, 2)),
  entry_id          uuid          NOT NULL,
  created_at        timestamptz   NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, contract_id),
  FOREIGN KEY (tenant_id, company_id, contract_id) REFERENCES app.single_supply_contract (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, entry_id) REFERENCES app.journal_entry (tenant_id, company_id, id)
);
COMMENT ON TABLE app.single_supply_attribution IS
  'The one accruals attribution of a contract''s whole GST (GP-040a, s 29-5(1)); one row per contract.';

CREATE TABLE app.single_supply_receipt (
  id               uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id        uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                 REFERENCES app.tenant (id),
  company_id       uuid          NOT NULL,
  contract_id      uuid          NOT NULL,
  receipt_date     date          NOT NULL,
  gross            numeric(19,4) NOT NULL CHECK (gross > 0 AND gross = round(gross, 2)),
  net              numeric(19,4) NOT NULL CHECK (net = round(net, 2)),
  tax              numeric(19,4) NOT NULL CHECK (tax = round(tax, 2)),
  account_id       uuid          NOT NULL,
  entry_id         uuid          NOT NULL,
  idempotency_key  text          NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  created_by       uuid,
  created_at       timestamptz   NOT NULL DEFAULT clock_timestamp(),
  CHECK (gross = net + tax),
  UNIQUE (tenant_id, company_id, idempotency_key),
  UNIQUE (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, contract_id) REFERENCES app.single_supply_contract (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, account_id) REFERENCES app.account (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, entry_id) REFERENCES app.journal_entry (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.single_supply_receipt IS
  'A receipt on a single-supply contract (GP-040a/b accruals, GP-020 cash) with its GST part; tax may be the clearing residual of the last receipt (AC-8).';
CREATE INDEX single_supply_receipt_contract_idx ON app.single_supply_receipt (tenant_id, contract_id);

CREATE TABLE app.single_supply_contract_status (
  tenant_id    uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                           REFERENCES app.tenant (id),
  company_id   uuid        NOT NULL,
  contract_id  uuid        NOT NULL,
  status       text        NOT NULL CHECK (status IN ('finalised', 'cancelled')),
  status_date  date        NOT NULL,
  entry_id     uuid,
  set_by       uuid,
  set_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, contract_id),
  FOREIGN KEY (tenant_id, company_id, contract_id) REFERENCES app.single_supply_contract (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, entry_id) REFERENCES app.journal_entry (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, set_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.single_supply_contract_status IS
  'Successor status of a single-supply contract (finalised / cancelled, ADR-0089 R2); no row = open. Written by T-0204.';

CREATE TRIGGER single_supply_contract_immutable BEFORE UPDATE OR DELETE ON app.single_supply_contract
  FOR EACH ROW EXECUTE FUNCTION app.sod_never_changed();
CREATE TRIGGER single_supply_attribution_immutable BEFORE UPDATE OR DELETE ON app.single_supply_attribution
  FOR EACH ROW EXECUTE FUNCTION app.sod_never_changed();
CREATE TRIGGER single_supply_receipt_immutable BEFORE UPDATE OR DELETE ON app.single_supply_receipt
  FOR EACH ROW EXECUTE FUNCTION app.sod_never_changed();
CREATE TRIGGER single_supply_contract_status_immutable BEFORE UPDATE OR DELETE ON app.single_supply_contract_status
  FOR EACH ROW EXECUTE FUNCTION app.sod_never_changed();

ALTER TABLE app.single_supply_contract ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.single_supply_contract FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.single_supply_contract
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.single_supply_contract TO lf_app;

ALTER TABLE app.single_supply_attribution ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.single_supply_attribution FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.single_supply_attribution
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.single_supply_attribution TO lf_app;

ALTER TABLE app.single_supply_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.single_supply_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.single_supply_receipt
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.single_supply_receipt TO lf_app;

ALTER TABLE app.single_supply_contract_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.single_supply_contract_status FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.single_supply_contract_status
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.single_supply_contract_status TO lf_app;
