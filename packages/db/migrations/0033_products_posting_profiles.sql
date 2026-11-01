-- 0033 — Products and posting profiles (T-0038, design §4.4, DL-0266). Owner: packages/modules/products.
--
-- * app.party_posting_profile (who): customer or supplier; its control account and default tax
--   code. app.product_posting_profile (what): revenue, expense, COGS and discount accounts and a
--   default tax code. Accounts are the company's own (composite foreign keys). That a customer
--   profile points at the AR control account, a supplier profile at AP control and a revenue
--   account is of type revenue is checked by packages/modules/products when a profile is created
--   (the posting engine refuses control-account misuse at posting time regardless).
-- * app.product: a sellable item with its product profile; SKU and Salesforce Product2 Id are
--   unique per company.
-- * app.party gains customer_profile_id and supplier_profile_id (a party can be both).
-- * app.salesforce_profile_mapping: the mapping hooks — Product2.Family → product profile,
--   Account.Type → party profile — data per company, not code.
-- * The party × product override matrix and the gap check are T-0039.
-- * Default tax codes are catalogue codes (tax_code is effective-dated, so they are not foreign
--   keys); they are resolved to a tax_code row by date when a document is built.
-- * Tenant-owned: RLS ENABLE + FORCE, tenant_isolation, explicit lf_app grants; nothing deleted
--   (status instead).

CREATE TABLE app.party_posting_profile (
  id                 uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id          uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                 REFERENCES app.tenant (id),
  company_id         uuid        NOT NULL,
  code               text        NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  name               text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  kind               text        NOT NULL CHECK (kind IN ('customer', 'supplier')),
  control_account_id uuid        NOT NULL,
  default_tax_code   text        NOT NULL CHECK (default_tax_code ~ '^[A-Z][A-Z0-9-]*$'),
  status             text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, company_id, code),
  UNIQUE (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, control_account_id) REFERENCES app.account (tenant_id, company_id, id)
);
COMMENT ON TABLE app.party_posting_profile IS
  'Party posting profile (design 4.4, who): control account and default tax code.';

CREATE TABLE app.product_posting_profile (
  id                  uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id           uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                  REFERENCES app.tenant (id),
  company_id          uuid        NOT NULL,
  code                text        NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  name                text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  revenue_account_id  uuid        NOT NULL,
  expense_account_id  uuid,
  cogs_account_id     uuid,
  discount_account_id uuid,
  default_tax_code    text        NOT NULL CHECK (default_tax_code ~ '^[A-Z][A-Z0-9-]*$'),
  status              text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, company_id, code),
  UNIQUE (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, revenue_account_id) REFERENCES app.account (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, expense_account_id) REFERENCES app.account (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, cogs_account_id) REFERENCES app.account (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, discount_account_id) REFERENCES app.account (tenant_id, company_id, id)
);
COMMENT ON TABLE app.product_posting_profile IS
  'Product posting profile (design 4.4, what): revenue, expense, COGS and discount accounts.';

CREATE TABLE app.product (
  id                     uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id              uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                       REFERENCES app.tenant (id),
  company_id             uuid          NOT NULL,
  sku                    text          NOT NULL CHECK (sku ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$'),
  name                   text          NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 255),
  description            text          CHECK (length(description) <= 4000),
  product_profile_id     uuid          NOT NULL,
  unit_price             numeric(19,4) CHECK (unit_price >= 0),
  currency               char(3)       CHECK (currency ~ '^[A-Z]{3}$'),
  tax_code               text          CHECK (tax_code ~ '^[A-Z][A-Z0-9-]*$'),
  salesforce_product2_id text          CHECK (salesforce_product2_id ~ '^[a-zA-Z0-9]{18}$'),
  status                 text          NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at             timestamptz   NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, company_id, sku),
  UNIQUE (tenant_id, company_id, salesforce_product2_id),
  UNIQUE (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, product_profile_id)
    REFERENCES app.product_posting_profile (tenant_id, company_id, id)
);
COMMENT ON TABLE app.product IS 'Product (design 4.4): sellable item with its product posting profile.';

ALTER TABLE app.party
  ADD COLUMN customer_profile_id uuid,
  ADD COLUMN supplier_profile_id uuid,
  ADD CONSTRAINT party_customer_profile_fk FOREIGN KEY (tenant_id, company_id, customer_profile_id)
    REFERENCES app.party_posting_profile (tenant_id, company_id, id),
  ADD CONSTRAINT party_supplier_profile_fk FOREIGN KEY (tenant_id, company_id, supplier_profile_id)
    REFERENCES app.party_posting_profile (tenant_id, company_id, id);
COMMENT ON COLUMN app.party.customer_profile_id IS 'Party posting profile used when the party buys (kind customer).';
COMMENT ON COLUMN app.party.supplier_profile_id IS 'Party posting profile used when the party sells to us (kind supplier).';

CREATE TABLE app.salesforce_profile_mapping (
  id                 uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id          uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                 REFERENCES app.tenant (id),
  company_id         uuid        NOT NULL,
  kind               text        NOT NULL CHECK (kind IN ('product_family', 'account_type')),
  source_value       text        NOT NULL CHECK (length(source_value) BETWEEN 1 AND 255),
  product_profile_id uuid,
  party_profile_id   uuid,
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT salesforce_profile_mapping_target CHECK (
    (kind = 'product_family' AND product_profile_id IS NOT NULL AND party_profile_id IS NULL)
    OR (kind = 'account_type' AND party_profile_id IS NOT NULL AND product_profile_id IS NULL)),
  UNIQUE (tenant_id, company_id, kind, source_value),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, product_profile_id)
    REFERENCES app.product_posting_profile (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, party_profile_id)
    REFERENCES app.party_posting_profile (tenant_id, company_id, id)
);
COMMENT ON TABLE app.salesforce_profile_mapping IS
  'Salesforce mapping hooks (design 4.4): Product2.Family → product profile, Account.Type → party profile.';

ALTER TABLE app.party_posting_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.party_posting_profile FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.party_posting_profile
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.party_posting_profile TO lf_app;

ALTER TABLE app.product_posting_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.product_posting_profile FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.product_posting_profile
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.product_posting_profile TO lf_app;

ALTER TABLE app.product ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.product FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.product
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.product TO lf_app;

ALTER TABLE app.salesforce_profile_mapping ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.salesforce_profile_mapping FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.salesforce_profile_mapping
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.salesforce_profile_mapping TO lf_app;
