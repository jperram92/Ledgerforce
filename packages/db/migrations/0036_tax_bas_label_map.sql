-- 0036 — tax: BAS label mapping as effective-dated data, two refined tax-code kinds and the
-- company GST basis (T-0035, design §3.6, RQ-0102, RQ-0095 Q3, DL-0257). Owner: packages/modules/tax.
--
-- * app.tax_code.subkind refines kind for two kinds 0031 does not list. A forward-only migration
--   cannot widen 0031's kind CHECK (the runner refuses DROP CONSTRAINT), so:
--     adjustment_decreasing (ADJ-BD, bad debt written off) is stored with kind 'taxable':
--       positive rate, GST_COLLECTED only — every 0031 rate/role check still holds;
--     payg_withholding (BAS-W1 / BAS-W2, PAYG labels) is stored with kind 'bas_excluded':
--       rate 0, no GST roles (it is not a GST code).
--   The effective kind is coalesce(subkind, kind). Like the other history columns, subkind is
--   fixed after insert (second guard trigger; 0031's guard is left as it is).
-- * app.company.gst_basis: 'accruals' (default) or 'cash' (design §3.6: the engine records both,
--   the report picks one).
-- * app.bas_label_map: per company, which BAS label a tax code feeds, effective-dated like
--   app.tax_code. Columns: flow (sales = a line on a revenue or liability account, purchases =
--   asset, expense or equity, any = either), amount (gross = net + GST, net = line amount,
--   tax = the line's GST), positive_side (the side that adds to the label; fixed by the flow for
--   sales/purchases), basis (both | accruals | cash). The tax code is named by code, because its
--   versions have different ids; the guard refuses a code the company has never had (23503).
--   Versions of one (code, flow, label) never overlap on an intersecting basis (serialised by an
--   advisory lock). Only valid_to may change; DELETE is never granted (directive 6).
-- * The guards skip rows whose tenant is not the session tenant, so RLS WITH CHECK refuses them
--   with 42501 (as 0029/0031).

ALTER TABLE app.tax_code
  ADD COLUMN subkind text
    CONSTRAINT tax_code_subkind_check CHECK (subkind IN ('adjustment_decreasing', 'payg_withholding'));
ALTER TABLE app.tax_code
  ADD CONSTRAINT tax_code_subkind_kind CHECK (
    subkind IS NULL
    OR (subkind = 'adjustment_decreasing' AND kind = 'taxable'
        AND collected_role IS NOT NULL AND paid_role IS NULL)
    OR (subkind = 'payg_withholding' AND kind = 'bas_excluded'));
COMMENT ON COLUMN app.tax_code.subkind IS
  'Refines kind (0036): adjustment_decreasing (stored kind taxable) or payg_withholding (stored kind bas_excluded). Effective kind = coalesce(subkind, kind). Fixed after insert.';

CREATE FUNCTION app.tax_code_subkind_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW;
  END IF;
  IF NEW.subkind IS DISTINCT FROM OLD.subkind THEN
    RAISE EXCEPTION 'tax code %: only valid_to and name can change; add a new version instead', OLD.code
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER tax_code_subkind_guard BEFORE UPDATE ON app.tax_code
  FOR EACH ROW EXECUTE FUNCTION app.tax_code_subkind_guard();

ALTER TABLE app.company
  ADD COLUMN gst_basis text NOT NULL DEFAULT 'accruals'
    CONSTRAINT company_gst_basis_check CHECK (gst_basis IN ('accruals', 'cash'));
COMMENT ON COLUMN app.company.gst_basis IS
  'GST accounting basis: accruals (default) or cash; the BAS report picks it (design 3.6, RQ-0102).';

CREATE TABLE app.bas_label_map (
  id             uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id      uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                             REFERENCES app.tenant (id),
  company_id     uuid        NOT NULL,
  tax_code       text        NOT NULL CHECK (tax_code ~ '^[A-Z][A-Z0-9-]{0,11}$'),
  flow           text        NOT NULL CHECK (flow IN ('sales', 'purchases', 'any')),
  label          text        NOT NULL CHECK (label IN ('G1', 'G2', 'G3', 'G10', 'G11', '1A', '1B', 'W1', 'W2')),
  amount         text        NOT NULL CHECK (amount IN ('gross', 'net', 'tax')),
  positive_side  text        NOT NULL CHECK (positive_side IN ('debit', 'credit')),
  basis          text        NOT NULL CHECK (basis IN ('both', 'accruals', 'cash')),
  valid_from     date        NOT NULL,
  valid_to       date,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, company_id, tax_code, flow, label, basis, valid_from),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  CONSTRAINT bas_label_map_valid_range CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT bas_label_map_flow_side CHECK (
    (flow <> 'sales' OR positive_side = 'credit') AND (flow <> 'purchases' OR positive_side = 'debit'))
);
COMMENT ON TABLE app.bas_label_map IS
  'Tax code -> BAS label, effective-dated per company (design 3.6, RQ-0102). Mapping change = new row; only valid_to changes.';
COMMENT ON COLUMN app.bas_label_map.flow IS
  'sales: line on a revenue or liability account; purchases: asset, expense or equity; any: either.';
COMMENT ON COLUMN app.bas_label_map.amount IS 'gross = line amount + its GST; net = line amount; tax = the line''s GST.';
COMMENT ON COLUMN app.bas_label_map.positive_side IS 'The journal side that adds to the label; the other side subtracts.';
CREATE INDEX bas_label_map_code_idx ON app.bas_label_map (tenant_id, company_id, tax_code);

ALTER TABLE app.bas_label_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bas_label_map FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.bas_label_map
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.bas_label_map TO lf_app;

CREATE FUNCTION app.bas_label_map_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND (
       NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.tax_code IS DISTINCT FROM OLD.tax_code
    OR NEW.flow IS DISTINCT FROM OLD.flow OR NEW.label IS DISTINCT FROM OLD.label
    OR NEW.amount IS DISTINCT FROM OLD.amount OR NEW.positive_side IS DISTINCT FROM OLD.positive_side
    OR NEW.basis IS DISTINCT FROM OLD.basis OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
    OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION 'BAS map row: only valid_to can change; add a new version instead'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND NOT EXISTS (
    SELECT 1 FROM app.tax_code t
     WHERE t.tenant_id = NEW.tenant_id AND t.company_id = NEW.company_id AND t.code = NEW.tax_code
  ) THEN
    RAISE EXCEPTION 'tax code % does not exist in company %', NEW.tax_code, NEW.company_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'app.bas_label_map:' || NEW.tenant_id::text || ':' || NEW.company_id::text || ':'
      || NEW.tax_code || ':' || NEW.flow || ':' || NEW.label, 0));
  IF EXISTS (
    SELECT 1 FROM app.bas_label_map m
     WHERE m.tenant_id = NEW.tenant_id AND m.company_id = NEW.company_id
       AND m.tax_code = NEW.tax_code AND m.flow = NEW.flow AND m.label = NEW.label
       AND m.id <> NEW.id
       AND (m.basis = NEW.basis OR m.basis = 'both' OR NEW.basis = 'both')
       AND daterange(m.valid_from, m.valid_to, '[]') && daterange(NEW.valid_from, NEW.valid_to, '[]')
  ) THEN
    RAISE EXCEPTION 'BAS map % % % overlaps an existing version (valid % to %)', NEW.tax_code,
      NEW.flow, NEW.label, NEW.valid_from, coalesce(NEW.valid_to::text, 'open')
      USING ERRCODE = 'exclusion_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER bas_label_map_guard BEFORE INSERT OR UPDATE ON app.bas_label_map
  FOR EACH ROW EXECUTE FUNCTION app.bas_label_map_guard();
