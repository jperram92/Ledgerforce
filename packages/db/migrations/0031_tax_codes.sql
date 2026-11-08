-- 0031 — tax: effective-dated tax codes and the company GST rounding setting (T-0034,
-- design §3.4, §3.6, RQ-0094, DL-0244). Owner: packages/modules/tax.
--
-- * app.company.tax_rounding: 'per_line' (AU default) or 'per_document'. Additive column with a
--   default, so existing companies keep the design default.
-- * app.tax_code: one row per version of a tax code per company. A version is valid from
--   valid_from to valid_to inclusive (NULL = open-ended). A rate change is a new row with a later
--   valid_from after closing the previous one; versions of one code never overlap (trigger,
--   serialised per company+code with a transaction advisory lock).
-- * Rate and kind agree: taxable, imports and capital carry a positive rate and at least one GST
--   account role; GST-free, input taxed and BAS excluded carry rate 0 and no account role.
--   Imports and capital acquisitions are purchase-only (no collected role).
-- * Account bindings go through the T-0018 system roles: collected_role / paid_role reference
--   app.account_system_role (tenant, company, role), so a code can only name a bound role and
--   the account is resolved at use time (a role is never unbound, migration 0005).
-- * Only valid_to and name may change after insert (rate/kind/code/roles/valid_from are history
--   that posted journal lines point at). DELETE is never granted (directive 6). The guard skips
--   rows whose tenant is not the session tenant, so RLS WITH CHECK refuses them with 42501
--   (as 0029); lf_app always runs with the tenant set (withTenant).
-- * app.journal_line.tax_code_id (0007) is left without a foreign key here: adding one to the
--   ledger table is a separate, ledger-owned change.

ALTER TABLE app.company
  ADD COLUMN tax_rounding text NOT NULL DEFAULT 'per_line'
    CONSTRAINT company_tax_rounding_check CHECK (tax_rounding IN ('per_line', 'per_document'));
COMMENT ON COLUMN app.company.tax_rounding IS
  'GST rounding: per_line (AU default) or per_document; per-document residue posts to ROUNDING (design 3.4, RQ-0094).';

CREATE TABLE app.tax_code (
  id              uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id       uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                REFERENCES app.tenant (id),
  company_id      uuid          NOT NULL,
  code            text          NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9-]{0,11}$'),
  name            text          NOT NULL CHECK (length(btrim(name)) > 0),
  kind            text          NOT NULL CHECK (kind IN (
                    'taxable', 'gst_free', 'input_taxed', 'bas_excluded', 'imports', 'capital')),
  rate            numeric(18,8) NOT NULL CHECK (rate >= 0 AND rate < 1),
  collected_role  text          CHECK (collected_role IS NULL OR collected_role = 'GST_COLLECTED'),
  paid_role       text          CHECK (paid_role IS NULL OR paid_role = 'GST_PAID'),
  valid_from      date          NOT NULL,
  valid_to        date,
  created_at      timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, company_id, id),
  UNIQUE (tenant_id, company_id, code, valid_from),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, collected_role)
    REFERENCES app.account_system_role (tenant_id, company_id, role),
  FOREIGN KEY (tenant_id, company_id, paid_role)
    REFERENCES app.account_system_role (tenant_id, company_id, role),
  CONSTRAINT tax_code_valid_range CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT tax_code_rate_kind CHECK (
    (kind IN ('taxable', 'imports', 'capital')) = (rate > 0)),
  CONSTRAINT tax_code_roles_kind CHECK (
    CASE WHEN rate > 0 THEN collected_role IS NOT NULL OR paid_role IS NOT NULL
         ELSE collected_role IS NULL AND paid_role IS NULL END),
  CONSTRAINT tax_code_purchase_only CHECK (
    kind NOT IN ('imports', 'capital') OR collected_role IS NULL)
);
COMMENT ON TABLE app.tax_code IS
  'Effective-dated tax code versions (design 3.6). Rate change = new row; only valid_to/name change.';
COMMENT ON COLUMN app.tax_code.valid_to IS 'Last day this version applies (inclusive); NULL = open-ended.';
COMMENT ON COLUMN app.tax_code.collected_role IS 'System role for GST on sales (GST_COLLECTED), resolved via account_system_role.';
COMMENT ON COLUMN app.tax_code.paid_role IS 'System role for GST on purchases (GST_PAID), resolved via account_system_role.';

ALTER TABLE app.tax_code ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tax_code FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.tax_code
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.tax_code TO lf_app;

CREATE FUNCTION app.tax_code_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  -- A row of (or moved to) another tenant is refused by RLS WITH CHECK (42501); don't pre-empt it.
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND (
       NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.code IS DISTINCT FROM OLD.code
    OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.rate IS DISTINCT FROM OLD.rate
    OR NEW.collected_role IS DISTINCT FROM OLD.collected_role
    OR NEW.paid_role IS DISTINCT FROM OLD.paid_role
    OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
    OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION 'tax code %: only valid_to and name can change; add a new version instead', OLD.code
      USING ERRCODE = 'check_violation';
  END IF;
  -- Serialise versions of one code so two concurrent inserts cannot both pass the overlap check.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'app.tax_code:' || NEW.tenant_id::text || ':' || NEW.company_id::text || ':' || NEW.code, 0));
  IF EXISTS (
    SELECT 1 FROM app.tax_code t
     WHERE t.tenant_id = NEW.tenant_id AND t.company_id = NEW.company_id AND t.code = NEW.code
       AND t.id <> NEW.id
       AND daterange(t.valid_from, t.valid_to, '[]') && daterange(NEW.valid_from, NEW.valid_to, '[]')
  ) THEN
    RAISE EXCEPTION 'tax code % overlaps an existing version (valid % to %)', NEW.code,
      NEW.valid_from, coalesce(NEW.valid_to::text, 'open') USING ERRCODE = 'exclusion_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER tax_code_guard BEFORE INSERT OR UPDATE ON app.tax_code
  FOR EACH ROW EXECUTE FUNCTION app.tax_code_guard();
