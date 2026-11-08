-- 0005 — general ledger: chart of accounts and system-role bindings (T-0018, design §3.2).
-- Owner: packages/modules/gl.
--
-- * app.account: one row per account per company, with the §3.2 fields. Accounts are never
--   deleted; status 'archived' retires one (directive 6).
-- * app.account_system_role: binds each system role (AR_CONTROL, GST_COLLECTED, ...) to one account
--   of the company. The posting engine resolves accounts through these roles, never by code.
-- * The database refuses changes that would break a bound account. A bound account cannot be
--   archived, cannot become non-postable (CURRENT_YEAR_EARNINGS must stay non-postable instead),
--   cannot change to a type its role does not allow, and must carry is_control exactly when its
--   role is a control role. Both tables are guarded, and the binding trigger locks the account
--   row (FOR SHARE), so a concurrent change to the account and its binding serialises.
-- * app.system_role_allows(role, type) is the single source of the role→type rule. It is an
--   IMMUTABLE function rather than a global table, so no table without tenant_id is added.
--   packages/modules/gl/src/system-roles.ts mirrors it, and chart.db.test.ts proves they agree.

CREATE FUNCTION app.system_role_allows(role text, account_type text) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT CASE role
    WHEN 'AR_CONTROL'            THEN account_type = 'asset'
    WHEN 'UNDEPOSITED_FUNDS'     THEN account_type = 'asset'
    WHEN 'GST_PAID'              THEN account_type = 'asset'
    WHEN 'AP_CONTROL'            THEN account_type = 'liability'
    WHEN 'GST_COLLECTED'         THEN account_type = 'liability'
    WHEN 'PAYROLL_CLEARING'      THEN account_type = 'liability'
    WHEN 'WAGES_PAYABLE'         THEN account_type = 'liability'
    WHEN 'PAYG_WITHHOLDING'      THEN account_type = 'liability'
    WHEN 'SUPER_PAYABLE'         THEN account_type = 'liability'
    WHEN 'DEFERRED_REVENUE'      THEN account_type = 'liability'
    WHEN 'CUSTOMER_PREPAYMENTS'  THEN account_type = 'liability'
    WHEN 'RETAINED_EARNINGS'     THEN account_type = 'equity'
    WHEN 'CURRENT_YEAR_EARNINGS' THEN account_type = 'equity'
    WHEN 'ROUNDING'              THEN account_type IN ('expense', 'revenue')
    WHEN 'FX_REALISED'           THEN account_type IN ('expense', 'revenue')
    WHEN 'FX_UNREALISED'         THEN account_type IN ('expense', 'revenue')
    WHEN 'SUSPENSE'              THEN account_type IN ('asset', 'liability')
    ELSE false
  END
$$;
COMMENT ON FUNCTION app.system_role_allows(text, text) IS
  'Which account types a system role may bind to (design 3.2). Mirrored in modules/gl system-roles.ts.';

CREATE FUNCTION app.system_role_is_control(role text) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$ SELECT role IN ('AR_CONTROL', 'AP_CONTROL', 'PAYROLL_CLEARING') $$;
COMMENT ON FUNCTION app.system_role_is_control(text) IS
  'Control accounts (design 3.2): only their subledger posts to them.';

GRANT EXECUTE ON FUNCTION app.system_role_allows(text, text) TO lf_app;
GRANT EXECUTE ON FUNCTION app.system_role_is_control(text) TO lf_app;

CREATE TABLE app.account (
  id                   uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id            uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                   REFERENCES app.tenant (id),
  company_id           uuid        NOT NULL,
  code                 text        NOT NULL CHECK (code ~ '^[0-9]{3,10}$'),
  name                 text        NOT NULL CHECK (length(btrim(name)) > 0),
  type                 text        NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
  subtype              text        NOT NULL CHECK (subtype ~ '^[a-z][a-z0-9_]*$'),
  normal_balance       text        NOT NULL CHECK (normal_balance IN ('debit', 'credit')),
  currency             char(3)     CHECK (currency ~ '^[A-Z]{3}$'),
  postable             boolean     NOT NULL DEFAULT true,
  is_control           boolean     NOT NULL DEFAULT false,
  status               text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  default_tax_code     text,
  required_dimensions  text[]      NOT NULL DEFAULT '{}',
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, company_id, code),
  UNIQUE (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id)
);
COMMENT ON TABLE app.account IS 'Chart of accounts (design 3.2). Never deleted: archive instead.';
COMMENT ON COLUMN app.account.currency IS 'NULL = any currency; set = account restricted to that currency.';
COMMENT ON COLUMN app.account.is_control IS 'Control account: posted only by its subledger (design 3.2).';
COMMENT ON COLUMN app.account.default_tax_code IS 'Tax code key; becomes a FK when the tax module (T-0040s) lands.';

ALTER TABLE app.account ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.account FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.account
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.account TO lf_app;

CREATE TABLE app.account_system_role (
  tenant_id   uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                          REFERENCES app.tenant (id),
  company_id  uuid        NOT NULL,
  role        text        NOT NULL CHECK (role IN (
                'AR_CONTROL', 'AP_CONTROL', 'GST_COLLECTED', 'GST_PAID', 'RETAINED_EARNINGS',
                'CURRENT_YEAR_EARNINGS', 'ROUNDING', 'FX_REALISED', 'FX_UNREALISED', 'SUSPENSE',
                'UNDEPOSITED_FUNDS', 'PAYROLL_CLEARING', 'WAGES_PAYABLE', 'PAYG_WITHHOLDING',
                'SUPER_PAYABLE', 'DEFERRED_REVENUE', 'CUSTOMER_PREPAYMENTS')),
  account_id  uuid        NOT NULL,
  bound_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, company_id, role),
  FOREIGN KEY (tenant_id, company_id, account_id) REFERENCES app.account (tenant_id, company_id, id)
);
COMMENT ON TABLE app.account_system_role IS
  'System role → account per company (design 3.2). Re-bind by UPDATE; a role is never unbound.';
CREATE INDEX account_system_role_account_idx ON app.account_system_role (tenant_id, account_id);

ALTER TABLE app.account_system_role ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.account_system_role FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.account_system_role
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.account_system_role TO lf_app;

-- Shared rule: may this account carry this role? Raises with a message naming both.
CREATE FUNCTION app.assert_account_fits_role(acct app.account, role text) RETURNS void
  LANGUAGE plpgsql
AS $$
BEGIN
  IF acct.status <> 'active' THEN
    RAISE EXCEPTION 'account % is bound to system role %: it must stay active', acct.code, role
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT app.system_role_allows(role, acct.type) THEN
    RAISE EXCEPTION 'account % is bound to system role %: type % is not allowed for that role',
      acct.code, role, acct.type USING ERRCODE = 'check_violation';
  END IF;
  IF acct.postable <> (role <> 'CURRENT_YEAR_EARNINGS') THEN
    RAISE EXCEPTION 'account % is bound to system role %: it must be %', acct.code, role,
      CASE WHEN role = 'CURRENT_YEAR_EARNINGS' THEN 'non-postable' ELSE 'postable' END
      USING ERRCODE = 'check_violation';
  END IF;
  IF acct.is_control <> app.system_role_is_control(role) THEN
    RAISE EXCEPTION 'account % is bound to system role %: is_control must be %', acct.code, role,
      app.system_role_is_control(role) USING ERRCODE = 'check_violation';
  END IF;
END
$$;

CREATE FUNCTION app.account_guard_bound() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  r text;
BEGIN
  FOR r IN
    SELECT b.role FROM app.account_system_role b
     WHERE b.tenant_id = OLD.tenant_id AND b.company_id = OLD.company_id AND b.account_id = OLD.id
  LOOP
    PERFORM app.assert_account_fits_role(NEW, r);
  END LOOP;
  RETURN NEW;
END
$$;
CREATE TRIGGER account_guard_bound BEFORE UPDATE ON app.account
  FOR EACH ROW EXECUTE FUNCTION app.account_guard_bound();

CREATE FUNCTION app.account_system_role_check() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  acct app.account;
BEGIN
  SELECT a.* INTO acct FROM app.account a
   WHERE a.tenant_id = NEW.tenant_id AND a.company_id = NEW.company_id AND a.id = NEW.account_id
   FOR SHARE;
  IF FOUND THEN
    PERFORM app.assert_account_fits_role(acct, NEW.role);
  END IF; -- not found: the foreign key reports it
  IF TG_OP = 'UPDATE' AND (NEW.role <> OLD.role OR NEW.company_id <> OLD.company_id) THEN
    RAISE EXCEPTION 'system role binding %: role and company cannot change, re-bind account_id instead',
      OLD.role USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER account_system_role_check BEFORE INSERT OR UPDATE ON app.account_system_role
  FOR EACH ROW EXECUTE FUNCTION app.account_system_role_check();
