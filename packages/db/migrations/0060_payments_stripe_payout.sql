-- 0060 — Stripe payouts → GP-027 (T-0075, design §3.8 row 3, RQ-0107, DL-0403).
-- Owner: packages/connectors/stripe.
--
-- * app.stripe_settings gains the accounts GP-027 needs, all nullable so existing rows stay valid
--   (additive): fee_account_id (Stripe fees expense), payout_account_id (the bank account's GL account
--   payouts arrive in) and stripe_party_id (the Stripe supplier party named on the fee line). The
--   connector refuses a payout while any of them is missing.
-- * app.stripe_payout: one row per Stripe payout (UNIQUE per tenant = idempotency), the entry it
--   posted and its figures: amount (net paid out), gross (charges credited out of clearing), fee
--   (excluding GST) and fee_gst. gst_evidence is 'pending_tax_invoice' until the monthly Stripe tax
--   invoice is reconciled (GP-028, a later card records that as its own row). Insert-only for lf_app.
-- * Tenant-owned: RLS ENABLE + FORCE, tenant_isolation, explicit lf_app grants; nothing dropped.

ALTER TABLE app.stripe_settings
  ADD COLUMN fee_account_id    uuid,
  ADD COLUMN payout_account_id uuid,
  ADD COLUMN stripe_party_id   uuid,
  ADD CONSTRAINT stripe_settings_fee_account_fk
    FOREIGN KEY (tenant_id, company_id, fee_account_id) REFERENCES app.account (tenant_id, company_id, id),
  ADD CONSTRAINT stripe_settings_payout_account_fk
    FOREIGN KEY (tenant_id, company_id, payout_account_id) REFERENCES app.account (tenant_id, company_id, id),
  ADD CONSTRAINT stripe_settings_party_fk
    FOREIGN KEY (tenant_id, company_id, stripe_party_id) REFERENCES app.party (tenant_id, company_id, id);

CREATE TABLE app.stripe_payout (
  id                uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id         uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                  REFERENCES app.tenant (id),
  company_id        uuid          NOT NULL,
  stripe_payout_id  text          NOT NULL CHECK (stripe_payout_id ~ '^po_[A-Za-z0-9]{8,64}$'),
  arrival_date      date          NOT NULL,
  currency          text          NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount            numeric(19,4) NOT NULL CHECK (amount > 0),
  gross             numeric(19,4) NOT NULL,
  fee               numeric(19,4) NOT NULL CHECK (fee >= 0),
  fee_gst           numeric(19,4) NOT NULL CHECK (fee_gst >= 0),
  gst_evidence      text          NOT NULL DEFAULT 'pending_tax_invoice'
                                  CHECK (gst_evidence IN ('pending_tax_invoice')),
  entry_id          uuid          NOT NULL,
  created_at        timestamptz   NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, stripe_payout_id),
  UNIQUE (tenant_id, entry_id),
  CHECK (gross - fee - fee_gst = amount),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, entry_id) REFERENCES app.journal_entry (tenant_id, company_id, id)
);
COMMENT ON TABLE app.stripe_payout IS
  'Stripe payout and its GP-027 entry (one per payout); fee GST pending the monthly tax invoice. Insert-only.';

ALTER TABLE app.stripe_payout ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.stripe_payout FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.stripe_payout
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.stripe_payout TO lf_app;
