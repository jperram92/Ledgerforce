-- 0067 — Settings for setup wizard steps 3 and 8 (T-0158, design §3.6, §4.1, RQ-0153, ADR-0071,
-- DL-0550..0553). Owners: packages/modules/tax (app.tax_settings) and packages/modules/ar
-- (the new app.ar_settings columns). The wizard stores none of them (ADR-0067).
--
-- * app.tax_settings: GST accounting basis (cash | accrual) and BAS reporting frequency
--   (monthly | quarterly | annual) per company, effective-dated from the 1st of a month. The
--   setting in force on a date is the row with the latest effective_from on or before it. Every
--   basis/frequency pair is lawful for some business; eligibility depends on turnover and ATO
--   facts LedgerForce does not hold, so no pair is refused (RQ-0153 conclusion 1).
-- * app.ar_settings gains invoice branding (brand colour, accent colour, an optional PNG/JPEG
--   logo up to 512 KiB, never SVG), default payment terms (net days after the invoice date,
--   0–365) and accepted payment methods (non-empty subset of bank_transfer, stripe, no duplicates).
--   All nullable: NULL = not set yet, which the step 8 validator lists.
-- * Tenant-owned: RLS ENABLE + FORCE, tenant_isolation, lf_app SELECT/INSERT/UPDATE; nothing is
--   deleted.

CREATE TABLE app.tax_settings (
  id              uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id       uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                              REFERENCES app.tenant (id),
  company_id      uuid        NOT NULL,
  effective_from  date        NOT NULL CHECK (extract(day FROM effective_from) = 1),
  gst_basis       text        NOT NULL CHECK (gst_basis IN ('cash', 'accrual')),
  bas_frequency   text        NOT NULL CHECK (bas_frequency IN ('monthly', 'quarterly', 'annual')),
  set_by          uuid,
  set_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, company_id, effective_from),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, set_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.tax_settings IS
  'GST basis and BAS frequency per company, effective-dated from the 1st of a month; the latest row on or before a date is in force (ADR-0071).';

ALTER TABLE app.tax_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tax_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.tax_settings
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.tax_settings TO lf_app;

ALTER TABLE app.ar_settings
  ADD COLUMN brand_colour                text
    CONSTRAINT ar_settings_brand_colour_chk CHECK (brand_colour ~ '^#[0-9A-F]{6}$'),
  ADD COLUMN brand_accent_colour         text
    CONSTRAINT ar_settings_brand_accent_colour_chk CHECK (brand_accent_colour ~ '^#[0-9A-F]{6}$'),
  ADD COLUMN logo                        bytea,
  ADD COLUMN logo_content_type           text
    CONSTRAINT ar_settings_logo_content_type_chk CHECK (logo_content_type IN ('image/png', 'image/jpeg')),
  ADD COLUMN default_payment_terms_days  integer
    CONSTRAINT ar_settings_payment_terms_chk CHECK (default_payment_terms_days BETWEEN 0 AND 365),
  ADD COLUMN accepted_payment_methods    text[]
    CONSTRAINT ar_settings_payment_methods_chk CHECK (
      array_ndims(accepted_payment_methods) = 1 AND array_lower(accepted_payment_methods, 1) = 1
      AND cardinality(accepted_payment_methods) BETWEEN 1 AND 2
      AND accepted_payment_methods <@ ARRAY['bank_transfer', 'stripe']::text[]
      AND (cardinality(accepted_payment_methods) = 1
           OR accepted_payment_methods[1] <> accepted_payment_methods[2])),
  ADD CONSTRAINT ar_settings_logo_chk CHECK (
    (logo IS NULL AND logo_content_type IS NULL)
    OR (octet_length(logo) BETWEEN 1 AND 524288
        AND ((logo_content_type = 'image/png'
              AND substring(logo FROM 1 FOR 8) = '\x89504e470d0a1a0a'::bytea)
          OR (logo_content_type = 'image/jpeg'
              AND substring(logo FROM 1 FOR 3) = '\xffd8ff'::bytea))));

COMMENT ON COLUMN app.ar_settings.brand_colour IS 'Invoice brand colour #RRGGBB; NULL = branding not set (wizard step 8, ADR-0071).';
COMMENT ON COLUMN app.ar_settings.logo IS 'Optional invoice logo, PNG or JPEG, at most 512 KiB; select it only when rendering.';
COMMENT ON COLUMN app.ar_settings.default_payment_terms_days IS 'Default net payment terms in days after the invoice date; a party''s own terms win (design 4.2).';
COMMENT ON COLUMN app.ar_settings.accepted_payment_methods IS 'Payment methods shown on invoices: bank_transfer, stripe (design 4.1 step 8).';
