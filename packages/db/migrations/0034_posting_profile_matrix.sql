-- 0034 — Posting-profile matrix overrides (T-0039, design §4.4, DL-0267). Owner: packages/modules/products.
--
-- * app.posting_profile_override: party profile × product profile → accounts and tax code that
--   differ from the product profile's defaults. Only differing combinations have a row, so a
--   tenant with 3 × 5 profiles keeps a handful of overrides rather than 15 rows. A NULL column
--   means "use the default". Accounts are the company's own (composite foreign keys); the account
--   type rules are checked by packages/modules/products when an override is set.
-- * Resolution and the gap check (combinations with no usable account or tax code) live in
--   packages/modules/products/src/matrix.ts.
-- * Tenant-owned: RLS ENABLE + FORCE, tenant_isolation, explicit lf_app grants; never deleted
--   (an override is cleared by setting its columns to NULL).

CREATE TABLE app.posting_profile_override (
  id                  uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id           uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                  REFERENCES app.tenant (id),
  company_id          uuid        NOT NULL,
  party_profile_id    uuid        NOT NULL,
  product_profile_id  uuid        NOT NULL,
  revenue_account_id  uuid,
  expense_account_id  uuid,
  cogs_account_id     uuid,
  discount_account_id uuid,
  tax_code            text        CHECK (tax_code ~ '^[A-Z][A-Z0-9-]*$'),
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, company_id, party_profile_id, product_profile_id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, party_profile_id)
    REFERENCES app.party_posting_profile (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, product_profile_id)
    REFERENCES app.product_posting_profile (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, revenue_account_id) REFERENCES app.account (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, expense_account_id) REFERENCES app.account (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, cogs_account_id) REFERENCES app.account (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, discount_account_id) REFERENCES app.account (tenant_id, company_id, id)
);
COMMENT ON TABLE app.posting_profile_override IS
  'Posting-profile matrix (design 4.4): party profile x product profile overrides of the product defaults.';

ALTER TABLE app.posting_profile_override ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.posting_profile_override FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.posting_profile_override
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.posting_profile_override TO lf_app;
GRANT UPDATE (revenue_account_id, expense_account_id, cogs_account_id, discount_account_id, tax_code,
              updated_at) ON app.posting_profile_override TO lf_app;
