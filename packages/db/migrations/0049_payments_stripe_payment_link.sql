-- 0049 — Stripe payment links on invoices (T-0073, design §5.7, RQ-0115, ADR-0048, DL-0297).
-- Owner: packages/connectors/stripe. (Reserved as 0049; numbered 0048 on this branch because the
-- runner forbids gaps — renumber before merge if another 0048 lands first; never after merge.)
--
-- * app.stripe_payment_link: one Stripe Payment Link per invoice and amount due. At most one is
--   active per invoice; when the amount due changes (part payment, credit note) the old link is
--   deactivated in Stripe and marked 'deactivated' here, and a new one is created. Rows are never
--   deleted. The URL and Stripe id are not secrets (the URL is printed on the invoice).
-- * Tenant-owned: RLS ENABLE + FORCE, tenant_isolation, explicit lf_app grants (no DELETE).

CREATE TABLE app.stripe_payment_link (
  id              uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id       uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                REFERENCES app.tenant (id),
  company_id      uuid          NOT NULL,
  invoice_id      uuid          NOT NULL,
  amount_due      numeric(19,4) NOT NULL CHECK (amount_due > 0 AND amount_due = round(amount_due, 2)),
  currency        char(3)       NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  stripe_id       text          NOT NULL CHECK (stripe_id ~ '^plink_[A-Za-z0-9]+$' AND length(stripe_id) <= 255),
  url             text          NOT NULL CHECK (url ~ '^https://[^[:space:]"<>]+$' AND length(url) <= 2000),
  livemode        boolean       NOT NULL,
  idempotency_key text          NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  status          text          NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deactivated')),
  created_at      timestamptz   NOT NULL DEFAULT clock_timestamp(),
  deactivated_at  timestamptz,
  CHECK ((status = 'deactivated') = (deactivated_at IS NOT NULL)),
  UNIQUE (tenant_id, stripe_id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, invoice_id) REFERENCES app.sales_invoice (tenant_id, company_id, id)
);
CREATE UNIQUE INDEX stripe_payment_link_one_active
  ON app.stripe_payment_link (tenant_id, invoice_id) WHERE status = 'active';
COMMENT ON TABLE app.stripe_payment_link IS 'Stripe Payment Link per invoice and amount due (T-0073, RQ-0115); deactivated, never deleted.';

ALTER TABLE app.stripe_payment_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.stripe_payment_link FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.stripe_payment_link
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.stripe_payment_link TO lf_app;
