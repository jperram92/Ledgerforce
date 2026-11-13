-- 0062 — period-end system roles in an additive binding table (T-0117, ADR-0061, RQ-0143,
-- design §3.2 AASB note and §3.10). Owner: packages/modules/gl.
--
-- The 0005 CHECK on app.account_system_role.role lists 17 roles and cannot be widened without
-- DROP CONSTRAINT (forbidden: forward-only). So the seven period-end roles get their own table
-- of identical shape, and readers use one view over both:
--
-- * app.system_role_is_extended(role): the roles of app.account_system_role_ext. It may only
--   ever be WIDENED by CREATE OR REPLACE (stored rows stay valid), and must never return true
--   for a role the 0005 CHECK accepts, so each role lives in exactly one table. A later role is
--   added by widening this function and app.system_role_allows (pattern of source_type_class).
-- * app.system_role_allows(role, type) keeps its signature and every existing rule and adds:
--   AR_ECL_ALLOWANCE, PREPAYMENTS, ACCUM_DEPRECIATION → asset (the two allowances are
--   contra-assets with a credit normal balance); DEPRECIATION_EXPENSE → expense;
--   ACCRUED_EXPENSES, SGC_PAYABLE → liability; PRIOR_PERIOD_ADJUSTMENTS → equity.
--   None is a control role and all are postable, so system_role_is_control and
--   assert_account_fits_role are unchanged.
-- * app.account_system_role_ext: same columns, keys, foreign key, index, RLS (ENABLE + FORCE,
--   tenant_isolation) and lf_app grants (SELECT, INSERT, UPDATE; never DELETE) as
--   app.account_system_role. Its trigger reuses app.account_system_role_check() unchanged
--   (account locked FOR SHARE, fits-role assert, role and company immutable on re-bind).
-- * app.account_role_binding: security_invoker view (PostgreSQL 15+, so 16 and 17) over both
--   tables; RLS of the caller applies to each base table. Every generic role reader uses it.
-- * app.account_guard_bound() is replaced to guard an account against the roles bound in
--   either table.
-- packages/modules/gl/src/system-roles.ts mirrors both functions; chart.db.test.ts and
-- period-end-roles.db.test.ts prove they agree.

CREATE FUNCTION app.system_role_is_extended(role text) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT role IN ('AR_ECL_ALLOWANCE', 'PREPAYMENTS', 'ACCUM_DEPRECIATION', 'DEPRECIATION_EXPENSE',
                  'ACCRUED_EXPENSES', 'SGC_PAYABLE', 'PRIOR_PERIOD_ADJUSTMENTS')
$$;
COMMENT ON FUNCTION app.system_role_is_extended(text) IS
  'System roles bound in app.account_system_role_ext (ADR-0061). Widen only; never a 0005 role. Mirrored in modules/gl system-roles.ts.';
GRANT EXECUTE ON FUNCTION app.system_role_is_extended(text) TO lf_app;

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
    ELSE false
  END
$$;
COMMENT ON FUNCTION app.system_role_allows(text, text) IS
  'Which account types a system role may bind to (design 3.2; 0062 adds the period-end roles). Mirrored in modules/gl system-roles.ts.';

CREATE TABLE app.account_system_role_ext (
  tenant_id   uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                          REFERENCES app.tenant (id),
  company_id  uuid        NOT NULL,
  role        text        NOT NULL CHECK (app.system_role_is_extended(role)),
  account_id  uuid        NOT NULL,
  bound_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, company_id, role),
  FOREIGN KEY (tenant_id, company_id, account_id) REFERENCES app.account (tenant_id, company_id, id)
);
COMMENT ON TABLE app.account_system_role_ext IS
  'Period-end system role → account per company (ADR-0061; same rules as account_system_role). Re-bind by UPDATE; never unbound.';
CREATE INDEX account_system_role_ext_account_idx ON app.account_system_role_ext (tenant_id, account_id);

ALTER TABLE app.account_system_role_ext ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.account_system_role_ext FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.account_system_role_ext
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.account_system_role_ext TO lf_app;

CREATE TRIGGER account_system_role_check BEFORE INSERT OR UPDATE ON app.account_system_role_ext
  FOR EACH ROW EXECUTE FUNCTION app.account_system_role_check();

CREATE VIEW app.account_role_binding WITH (security_invoker = true) AS
  SELECT tenant_id, company_id, role, account_id, bound_at FROM app.account_system_role
  UNION ALL
  SELECT tenant_id, company_id, role, account_id, bound_at FROM app.account_system_role_ext;
COMMENT ON VIEW app.account_role_binding IS
  'Every system role binding (core 0005 + period-end 0062, ADR-0061). security_invoker: the caller''s RLS applies.';
GRANT SELECT ON app.account_role_binding TO lf_app;

CREATE OR REPLACE FUNCTION app.account_guard_bound() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  r text;
BEGIN
  FOR r IN
    SELECT b.role FROM app.account_role_binding b
     WHERE b.tenant_id = OLD.tenant_id AND b.company_id = OLD.company_id AND b.account_id = OLD.id
  LOOP
    PERFORM app.assert_account_fits_role(NEW, r);
  END LOOP;
  RETURN NEW;
END
$$;
