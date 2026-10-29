-- 0011 — parties: party, roles, addresses, contacts and billing contact roles
-- (T-0036, design §4.2, RQ-0017). Owner: packages/modules/parties.
--
-- * A party is scoped to a company (like the chart): currency, payment terms, credit limit
--   and posting profile are per company, and MVP has one company per tenant (DL-0079).
-- * One party, many roles (customer, supplier, employee): a business that is both customer and
--   supplier is one record (design §4.2). Roles are deactivated, never deleted.
-- * ABN: 11 digits that pass the ABR mod-89 checksum (app.abn_is_valid; TS twin in
--   packages/modules/parties/src/identifiers.ts). Peppol delivery needs an ABN; the
--   participant ID 0151:<ABN> is derived, not stored.
-- * salesforce_account_id is stored only in 18-character form, unique per company, so a 15-
--   and an 18-character Id for the same Account can never create two parties.
-- * Contact roles: billing_to, billing_cc, statements, ap_contact need an active customer role;
--   remittance needs an active supplier role. A contact role always names a contact of the same
--   party (composite foreign key).
-- * Columns owned by later tasks: party posting profile (T-0038), payment terms (T-0039),
--   bank details with verification (T-0053). tax_status is free snake_case until the tax
--   engine (T-0034) defines its codes.
-- * lf_app: SELECT, INSERT, UPDATE; nothing is deleted (status / active instead).

CREATE FUNCTION app.abn_is_valid(abn text) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT CASE WHEN abn !~ '^[0-9]{11}$' THEN false
    ELSE (SELECT sum((substr(abn, i::int, 1)::int - CASE WHEN i = 1 THEN 1 ELSE 0 END) * w)
            FROM unnest(ARRAY[10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19]) WITH ORDINALITY AS t(w, i)) % 89 = 0
  END
$$;
COMMENT ON FUNCTION app.abn_is_valid(text) IS 'ABR ABN checksum (RQ-0017): first digit minus 1, weights 10,1,3..19, sum mod 89 = 0.';
GRANT EXECUTE ON FUNCTION app.abn_is_valid(text) TO lf_app;

CREATE TABLE app.party (
  id                        uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id                 uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                          REFERENCES app.tenant (id),
  company_id                uuid          NOT NULL,
  legal_name                text          NOT NULL CHECK (length(btrim(legal_name)) > 0),
  trading_name              text          CHECK (trading_name IS NULL OR length(btrim(trading_name)) > 0),
  abn                       text          CHECK (app.abn_is_valid(abn)),
  tax_id                    text,
  tax_status                text          CHECK (tax_status ~ '^[a-z][a-z0-9_]*$'),
  currency                  char(3)       CHECK (currency ~ '^[A-Z]{3}$'),
  credit_limit              numeric(19,4) CHECK (credit_limit >= 0),
  default_dimension_set_id  uuid,
  delivery_preference       text          NOT NULL DEFAULT 'email' CHECK (delivery_preference IN ('email', 'peppol', 'post')),
  salesforce_account_id     text          CHECK (salesforce_account_id ~ '^[a-zA-Z0-9]{18}$'),
  status                    text          NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at                timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT party_peppol_needs_abn CHECK (delivery_preference <> 'peppol' OR abn IS NOT NULL),
  UNIQUE (tenant_id, company_id, salesforce_account_id),
  UNIQUE (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, default_dimension_set_id) REFERENCES app.dimension_set (tenant_id, company_id, id)
);
COMMENT ON TABLE app.party IS 'Organisation or person with roles (design 4.2). Archive, never delete.';
COMMENT ON COLUMN app.party.currency IS 'NULL = the company base currency.';
CREATE INDEX party_name_idx ON app.party (tenant_id, company_id, lower(legal_name));

ALTER TABLE app.party ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.party FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.party
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.party TO lf_app;

CREATE TABLE app.party_role (
  tenant_id   uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                          REFERENCES app.tenant (id),
  company_id  uuid        NOT NULL,
  party_id    uuid        NOT NULL,
  role        text        NOT NULL CHECK (role IN ('customer', 'supplier', 'employee')),
  active      boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, party_id, role),
  FOREIGN KEY (tenant_id, company_id, party_id) REFERENCES app.party (tenant_id, company_id, id)
);
ALTER TABLE app.party_role ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.party_role FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.party_role
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.party_role TO lf_app;

CREATE TABLE app.party_address (
  id          uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id   uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                          REFERENCES app.tenant (id),
  company_id  uuid        NOT NULL,
  party_id    uuid        NOT NULL,
  kind        text        NOT NULL CHECK (kind IN ('billing', 'shipping')),
  line1       text        NOT NULL CHECK (length(btrim(line1)) > 0),
  line2       text,
  city        text,
  state       text,
  postcode    text,
  country     char(2)     NOT NULL DEFAULT 'AU' CHECK (country ~ '^[A-Z]{2}$'),
  UNIQUE (tenant_id, party_id, kind),
  FOREIGN KEY (tenant_id, company_id, party_id) REFERENCES app.party (tenant_id, company_id, id)
);
ALTER TABLE app.party_address ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.party_address FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.party_address
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.party_address TO lf_app;

CREATE TABLE app.party_contact (
  id                     uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id              uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                     REFERENCES app.tenant (id),
  company_id             uuid        NOT NULL,
  party_id               uuid        NOT NULL,
  name                   text        NOT NULL CHECK (length(btrim(name)) > 0),
  email                  text        CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  phone                  text,
  salesforce_contact_id  text        CHECK (salesforce_contact_id ~ '^[a-zA-Z0-9]{18}$'),
  status                 text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, company_id, salesforce_contact_id),
  UNIQUE (tenant_id, company_id, party_id, id),
  FOREIGN KEY (tenant_id, company_id, party_id) REFERENCES app.party (tenant_id, company_id, id)
);
ALTER TABLE app.party_contact ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.party_contact FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.party_contact
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.party_contact TO lf_app;

CREATE TABLE app.party_contact_role (
  tenant_id   uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                          REFERENCES app.tenant (id),
  company_id  uuid        NOT NULL,
  party_id    uuid        NOT NULL,
  contact_id  uuid        NOT NULL,
  role        text        NOT NULL CHECK (role IN ('billing_to', 'billing_cc', 'statements', 'remittance', 'ap_contact')),
  active      boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, contact_id, role),
  FOREIGN KEY (tenant_id, company_id, party_id, contact_id) REFERENCES app.party_contact (tenant_id, company_id, party_id, id)
);
CREATE INDEX party_contact_role_party_idx ON app.party_contact_role (tenant_id, party_id, role);
ALTER TABLE app.party_contact_role ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.party_contact_role FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.party_contact_role
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.party_contact_role TO lf_app;

-- An active contact role needs the matching active party role.
CREATE FUNCTION app.party_contact_role_check() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  needed text := CASE WHEN NEW.role = 'remittance' THEN 'supplier' ELSE 'customer' END;
BEGIN
  IF NEW.active AND NOT EXISTS (
       SELECT 1 FROM app.party_role r
        WHERE r.tenant_id = NEW.tenant_id AND r.party_id = NEW.party_id
          AND r.role = needed AND r.active) THEN
    RAISE EXCEPTION 'contact role % needs the party to have an active % role', NEW.role, needed
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER party_contact_role_check BEFORE INSERT OR UPDATE ON app.party_contact_role
  FOR EACH ROW EXECUTE FUNCTION app.party_contact_role_check();
