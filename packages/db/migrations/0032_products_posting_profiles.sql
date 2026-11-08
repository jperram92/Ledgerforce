-- 0032 — products, party posting profiles, product posting profiles, matrix overrides and the
-- Salesforce mapping hooks (T-0038, design §4.4, RQ-0095, DL-0247). Owner: packages/modules/products.
--
-- * Party posting profile (who): customer- or supplier-specific (party_kind); the control account
--   is a system role (AR_CONTROL for customers, AP_CONTROL for suppliers) resolved through
--   app.account_system_role at use time; optional default tax code (a code key, resolved by date
--   through app.tax_code, migration 0031 — it must exist in the company).
-- * Product posting profile (what): five optional account slots revenue, discount, expense, cogs,
--   asset. app.posting_slot_allows(slot, type) is the single source of the slot → type rule,
--   mirrored in packages/modules/products/src/posting-slots.ts (posting-profiles.db.test.ts proves
--   they agree). A slot account must be active, postable and not a control account (design §3.2:
--   control accounts are posted only by their subledger). An empty slot is a gap (T-0039).
-- * Matrix overrides: party profile × product profile × slot → account (design §4.4), same rules.
--   Resolution and the gap check are T-0039.
-- * An account used by an active profile slot or an override cannot be archived, made
--   non-postable, made a control account or retyped out of the slot (guard on app.account, as
--   0005 does for system roles).
-- * app.party gets customer_posting_profile_id and supplier_posting_profile_id (additive; one party
--   can be both customer and supplier, design §4.2); each must name a profile of that kind.
-- * app.product: Salesforce owns Product2 (design D1); the 18-character Product2 Id is unique per
--   company and the raw Family is kept for the mapping (data only; the connector is T-0065).
-- * Salesforce mapping hooks: (field API name, picklist value) → profile, per company, for
--   Account (default field Type) and Product2 (default field Family); a custom field may be used.
-- * Code and kind of a profile are history parties and documents point at: only name,
--   default_tax_code (party) / slots (product) and status change. Guards skip rows whose tenant is
--   not the session tenant, so RLS WITH CHECK refuses them with 42501 (as 0029, 0031).
-- * lf_app: SELECT, INSERT, UPDATE; nothing is deleted (status 'archived' instead).

CREATE FUNCTION app.posting_slot_allows(slot text, account_type text) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT CASE slot
    WHEN 'revenue'  THEN account_type = 'revenue'
    WHEN 'discount' THEN account_type IN ('revenue', 'expense')
    WHEN 'expense'  THEN account_type = 'expense'
    WHEN 'cogs'     THEN account_type = 'expense'
    WHEN 'asset'    THEN account_type = 'asset'
    ELSE false
  END
$$;
COMMENT ON FUNCTION app.posting_slot_allows(text, text) IS
  'Which account types a product posting-profile slot may hold (design 4.4). Mirrored in modules/products posting-slots.ts.';
GRANT EXECUTE ON FUNCTION app.posting_slot_allows(text, text) TO lf_app;

-- Why an account cannot sit in a slot, or NULL when it can.
CREATE FUNCTION app.posting_slot_problem(acct app.account, slot text) RETURNS text
  LANGUAGE sql STABLE
AS $$
  SELECT CASE
    WHEN acct.status <> 'active' THEN 'is not active'
    WHEN NOT app.posting_slot_allows(slot, acct.type)
      THEN format('has type %s, which slot %s does not allow', acct.type, slot)
    WHEN acct.is_control THEN 'is a control account (posted only by its subledger)'
    WHEN NOT acct.postable THEN 'is not postable'
  END
$$;

-- Raises unless the account may sit in the slot; `what` names the profile or override.
CREATE FUNCTION app.assert_posting_slot(tenant uuid, company uuid, account uuid, slot text, what text)
  RETURNS void
  LANGUAGE plpgsql
AS $$
DECLARE
  acct app.account;
  problem text;
BEGIN
  IF account IS NULL OR slot NOT IN ('revenue', 'discount', 'expense', 'cogs', 'asset') THEN
    RETURN; -- an unknown slot is reported by the table's CHECK constraint
  END IF;
  SELECT a.* INTO acct FROM app.account a
   WHERE a.tenant_id = tenant AND a.company_id = company AND a.id = account
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN; -- the foreign key reports it
  END IF;
  problem := app.posting_slot_problem(acct, slot);
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION '%, slot %: account % %', what, slot, acct.code, problem
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

CREATE FUNCTION app.assert_tax_code_exists(tenant uuid, company uuid, tax_code_key text) RETURNS void
  LANGUAGE plpgsql
AS $$
BEGIN
  IF tax_code_key IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM app.tax_code t
        WHERE t.tenant_id = tenant AND t.company_id = company AND t.code = tax_code_key) THEN
    RAISE EXCEPTION 'tax code % does not exist in this company', tax_code_key
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

-- Party posting profile ---------------------------------------------------------------------------

CREATE TABLE app.party_posting_profile (
  id                uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id         uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                REFERENCES app.tenant (id),
  company_id        uuid        NOT NULL,
  code              text        NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  name              text        NOT NULL CHECK (length(btrim(name)) > 0),
  party_kind        text        NOT NULL CHECK (party_kind IN ('customer', 'supplier')),
  control_role      text        NOT NULL,
  default_tax_code  text,
  status            text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT party_posting_profile_control_role CHECK (
    control_role = CASE party_kind WHEN 'customer' THEN 'AR_CONTROL' ELSE 'AP_CONTROL' END),
  UNIQUE (tenant_id, company_id, code),
  UNIQUE (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id)
);
COMMENT ON TABLE app.party_posting_profile IS
  'Who (design 4.4): control account via AR_CONTROL/AP_CONTROL and default tax code. Archive, never delete.';
COMMENT ON COLUMN app.party_posting_profile.default_tax_code IS
  'Tax code key (app.tax_code.code), resolved by date; must exist in the company.';

ALTER TABLE app.party_posting_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.party_posting_profile FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.party_posting_profile
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.party_posting_profile TO lf_app;

CREATE FUNCTION app.party_posting_profile_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND (
       NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.code IS DISTINCT FROM OLD.code
    OR NEW.party_kind IS DISTINCT FROM OLD.party_kind
    OR NEW.control_role IS DISTINCT FROM OLD.control_role
    OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION 'party posting profile %: only name, default_tax_code and status can change', OLD.code
      USING ERRCODE = 'check_violation';
  END IF;
  PERFORM app.assert_tax_code_exists(NEW.tenant_id, NEW.company_id, NEW.default_tax_code);
  RETURN NEW;
END
$$;
CREATE TRIGGER party_posting_profile_guard BEFORE INSERT OR UPDATE ON app.party_posting_profile
  FOR EACH ROW EXECUTE FUNCTION app.party_posting_profile_guard();

-- Product posting profile -------------------------------------------------------------------------

CREATE TABLE app.product_posting_profile (
  id                   uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id            uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                   REFERENCES app.tenant (id),
  company_id           uuid        NOT NULL,
  code                 text        NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  name                 text        NOT NULL CHECK (length(btrim(name)) > 0),
  revenue_account_id   uuid,
  discount_account_id  uuid,
  expense_account_id   uuid,
  cogs_account_id      uuid,
  asset_account_id     uuid,
  status               text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, company_id, code),
  UNIQUE (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, revenue_account_id) REFERENCES app.account (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, discount_account_id) REFERENCES app.account (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, expense_account_id) REFERENCES app.account (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, cogs_account_id) REFERENCES app.account (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, asset_account_id) REFERENCES app.account (tenant_id, company_id, id)
);
COMMENT ON TABLE app.product_posting_profile IS
  'What (design 4.4): revenue, discount, expense, COGS and asset accounts; empty slot = gap (T-0039). Archive, never delete.';

ALTER TABLE app.product_posting_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.product_posting_profile FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.product_posting_profile
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.product_posting_profile TO lf_app;

CREATE FUNCTION app.product_posting_profile_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  what text := 'product posting profile ' || NEW.code;
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND (
       NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.code IS DISTINCT FROM OLD.code
    OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION 'product posting profile %: code and company cannot change', OLD.code
      USING ERRCODE = 'check_violation';
  END IF;
  -- An archived profile is not resolved; its slots are re-checked when it is reactivated.
  IF NEW.status = 'active' THEN
    PERFORM app.assert_posting_slot(NEW.tenant_id, NEW.company_id, NEW.revenue_account_id, 'revenue', what);
    PERFORM app.assert_posting_slot(NEW.tenant_id, NEW.company_id, NEW.discount_account_id, 'discount', what);
    PERFORM app.assert_posting_slot(NEW.tenant_id, NEW.company_id, NEW.expense_account_id, 'expense', what);
    PERFORM app.assert_posting_slot(NEW.tenant_id, NEW.company_id, NEW.cogs_account_id, 'cogs', what);
    PERFORM app.assert_posting_slot(NEW.tenant_id, NEW.company_id, NEW.asset_account_id, 'asset', what);
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER product_posting_profile_guard BEFORE INSERT OR UPDATE ON app.product_posting_profile
  FOR EACH ROW EXECUTE FUNCTION app.product_posting_profile_guard();

-- Matrix overrides --------------------------------------------------------------------------------

CREATE TABLE app.posting_profile_override (
  id                          uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id                   uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                          REFERENCES app.tenant (id),
  company_id                  uuid        NOT NULL,
  party_posting_profile_id    uuid        NOT NULL,
  product_posting_profile_id  uuid        NOT NULL,
  slot                        text        NOT NULL CHECK (slot IN ('revenue', 'discount', 'expense', 'cogs', 'asset')),
  account_id                  uuid        NOT NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, company_id, party_posting_profile_id, product_posting_profile_id, slot),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, party_posting_profile_id)
    REFERENCES app.party_posting_profile (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, product_posting_profile_id)
    REFERENCES app.product_posting_profile (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, account_id) REFERENCES app.account (tenant_id, company_id, id)
);
COMMENT ON TABLE app.posting_profile_override IS
  'Party profile x product profile x slot -> account where it differs from the product default (design 4.4).';
CREATE INDEX posting_profile_override_account_idx ON app.posting_profile_override (tenant_id, account_id);

ALTER TABLE app.posting_profile_override ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.posting_profile_override FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.posting_profile_override
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.posting_profile_override TO lf_app;

CREATE FUNCTION app.posting_profile_override_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW;
  END IF;
  PERFORM app.assert_posting_slot(NEW.tenant_id, NEW.company_id, NEW.account_id, NEW.slot,
    'posting-profile override');
  RETURN NEW;
END
$$;
CREATE TRIGGER posting_profile_override_guard BEFORE INSERT OR UPDATE ON app.posting_profile_override
  FOR EACH ROW EXECUTE FUNCTION app.posting_profile_override_guard();

-- An account in use by a slot keeps fitting it (as 0005 guards system-role accounts).
CREATE FUNCTION app.account_guard_posting_slots() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  r record;
  problem text;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status AND NEW.type IS NOT DISTINCT FROM OLD.type
     AND NEW.postable IS NOT DISTINCT FROM OLD.postable
     AND NEW.is_control IS NOT DISTINCT FROM OLD.is_control THEN
    RETURN NEW;
  END IF;
  FOR r IN
    SELECT 'product posting profile ' || p.code AS what, s.slot
      FROM app.product_posting_profile p
      CROSS JOIN LATERAL (VALUES ('revenue', p.revenue_account_id), ('discount', p.discount_account_id),
                                 ('expense', p.expense_account_id), ('cogs', p.cogs_account_id),
                                 ('asset', p.asset_account_id)) AS s(slot, account_id)
     WHERE p.tenant_id = OLD.tenant_id AND p.company_id = OLD.company_id AND p.status = 'active'
       AND s.account_id = OLD.id
    UNION ALL
    SELECT format('posting-profile override %s × %s', pp.code, rp.code), o.slot
      FROM app.posting_profile_override o
      JOIN app.party_posting_profile pp
        ON pp.tenant_id = o.tenant_id AND pp.company_id = o.company_id AND pp.id = o.party_posting_profile_id
      JOIN app.product_posting_profile rp
        ON rp.tenant_id = o.tenant_id AND rp.company_id = o.company_id AND rp.id = o.product_posting_profile_id
     WHERE o.tenant_id = OLD.tenant_id AND o.company_id = OLD.company_id AND o.account_id = OLD.id
  LOOP
    problem := app.posting_slot_problem(NEW, r.slot);
    IF problem IS NOT NULL THEN
      RAISE EXCEPTION 'account % is used by % (%): it % — change the slot first', OLD.code, r.what, r.slot, problem
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;
CREATE TRIGGER account_guard_posting_slots BEFORE UPDATE ON app.account
  FOR EACH ROW EXECUTE FUNCTION app.account_guard_posting_slots();

-- Party links -------------------------------------------------------------------------------------

ALTER TABLE app.party ADD COLUMN customer_posting_profile_id uuid;
ALTER TABLE app.party ADD COLUMN supplier_posting_profile_id uuid;
ALTER TABLE app.party ADD CONSTRAINT party_customer_posting_profile_fk
  FOREIGN KEY (tenant_id, company_id, customer_posting_profile_id)
  REFERENCES app.party_posting_profile (tenant_id, company_id, id);
ALTER TABLE app.party ADD CONSTRAINT party_supplier_posting_profile_fk
  FOREIGN KEY (tenant_id, company_id, supplier_posting_profile_id)
  REFERENCES app.party_posting_profile (tenant_id, company_id, id);
COMMENT ON COLUMN app.party.customer_posting_profile_id IS
  'Party posting profile used when the party acts as customer (kind customer; design 4.4, DL-0247).';
COMMENT ON COLUMN app.party.supplier_posting_profile_id IS
  'Party posting profile used when the party acts as supplier (kind supplier; design 4.4, DL-0247).';

CREATE FUNCTION app.party_posting_profile_link_check() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW;
  END IF;
  IF NEW.customer_posting_profile_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM app.party_posting_profile p
        WHERE p.tenant_id = NEW.tenant_id AND p.company_id = NEW.company_id
          AND p.id = NEW.customer_posting_profile_id AND p.party_kind = 'customer') THEN
    RAISE EXCEPTION 'party %: customer_posting_profile_id must name a customer profile', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.supplier_posting_profile_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM app.party_posting_profile p
        WHERE p.tenant_id = NEW.tenant_id AND p.company_id = NEW.company_id
          AND p.id = NEW.supplier_posting_profile_id AND p.party_kind = 'supplier') THEN
    RAISE EXCEPTION 'party %: supplier_posting_profile_id must name a supplier profile', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER party_posting_profile_link_check
  BEFORE INSERT OR UPDATE OF customer_posting_profile_id, supplier_posting_profile_id ON app.party
  FOR EACH ROW EXECUTE FUNCTION app.party_posting_profile_link_check();

-- Products ----------------------------------------------------------------------------------------

CREATE TABLE app.product (
  id                          uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id                   uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                          REFERENCES app.tenant (id),
  company_id                  uuid        NOT NULL,
  code                        text        CHECK (code IS NULL OR (length(btrim(code)) > 0 AND length(code) <= 64)),
  name                        text        NOT NULL CHECK (length(btrim(name)) > 0),
  description                 text,
  product_posting_profile_id  uuid,
  default_tax_code            text,
  salesforce_product_id       text        CHECK (salesforce_product_id ~ '^[a-zA-Z0-9]{18}$'),
  salesforce_family           text,
  status                      text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, company_id, code),
  UNIQUE (tenant_id, company_id, salesforce_product_id),
  UNIQUE (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, product_posting_profile_id)
    REFERENCES app.product_posting_profile (tenant_id, company_id, id)
);
COMMENT ON TABLE app.product IS 'Product (design 4.2/5: Salesforce Product2 owns it). Archive, never delete.';
COMMENT ON COLUMN app.product.default_tax_code IS
  'Optional tax code key (app.tax_code.code), resolved by date; must exist in the company.';
COMMENT ON COLUMN app.product.salesforce_family IS
  'Raw Product2.Family as imported; mapped to a profile through app.product_profile_mapping (T-0065).';
CREATE INDEX product_name_idx ON app.product (tenant_id, company_id, lower(name));

ALTER TABLE app.product ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.product FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.product
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.product TO lf_app;

CREATE FUNCTION app.product_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW;
  END IF;
  PERFORM app.assert_tax_code_exists(NEW.tenant_id, NEW.company_id, NEW.default_tax_code);
  RETURN NEW;
END
$$;
CREATE TRIGGER product_guard BEFORE INSERT OR UPDATE ON app.product
  FOR EACH ROW EXECUTE FUNCTION app.product_guard();

-- Salesforce mapping hooks (data only; the connector is T-0065) ------------------------------------

CREATE TABLE app.party_profile_mapping (
  id                        uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id                 uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                        REFERENCES app.tenant (id),
  company_id                uuid        NOT NULL,
  sf_field                  text        NOT NULL DEFAULT 'Type' CHECK (sf_field ~ '^[A-Za-z][A-Za-z0-9_]{0,79}$'),
  sf_value                  text        NOT NULL CHECK (length(btrim(sf_value)) > 0 AND length(sf_value) <= 255),
  party_posting_profile_id  uuid        NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, company_id, sf_field, sf_value),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, party_posting_profile_id)
    REFERENCES app.party_posting_profile (tenant_id, company_id, id)
);
COMMENT ON TABLE app.party_profile_mapping IS
  'Salesforce Account field value (Type or a custom field, exact picklist API value) -> party posting profile (design 4.4).';

ALTER TABLE app.party_profile_mapping ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.party_profile_mapping FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.party_profile_mapping
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.party_profile_mapping TO lf_app;

CREATE TABLE app.product_profile_mapping (
  id                          uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id                   uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                          REFERENCES app.tenant (id),
  company_id                  uuid        NOT NULL,
  sf_field                    text        NOT NULL DEFAULT 'Family' CHECK (sf_field ~ '^[A-Za-z][A-Za-z0-9_]{0,79}$'),
  sf_value                    text        NOT NULL CHECK (length(btrim(sf_value)) > 0 AND length(sf_value) <= 255),
  product_posting_profile_id  uuid        NOT NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, company_id, sf_field, sf_value),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, product_posting_profile_id)
    REFERENCES app.product_posting_profile (tenant_id, company_id, id)
);
COMMENT ON TABLE app.product_profile_mapping IS
  'Salesforce Product2 field value (Family or a custom field, exact picklist API value) -> product posting profile (design 4.4).';

ALTER TABLE app.product_profile_mapping ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.product_profile_mapping FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.product_profile_mapping
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.product_profile_mapping TO lf_app;
