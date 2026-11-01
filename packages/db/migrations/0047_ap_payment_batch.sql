-- 0047 — Supplier payment batches: build and release (T-0054, design §6.5 rule 1, UC-06, DL-0281).
-- Owner: packages/modules/ap.
--
-- * app.payment_batch: a batch of supplier payments from one operating bank account, built by the
--   AP Clerk from posted bills due on or before a date (client-chosen id, so the SoD engine records
--   step payment_batch.create against the same subject the release checks). Status
--   draft → partially_released → released; the confirmation, ABA file and GP-009 posting are
--   T-0056/T-0057. Only `status` and `updated_at` ever change; the total is frozen.
-- * app.payment_batch_item: one row per due bill considered — a payment (amount = the bill's open
--   amount, to the supplier's verified active bank account) or an exclusion with its reason
--   (BANK_DETAILS_COOLING_OFF | NO_VERIFIED_BANK_DETAILS, from app.party_payment_eligibility).
--   Append-only. A bill is paid by at most one live batch (enforced in @ledgerforce/ap under a
--   per-company advisory lock; batches are never deleted).
-- * app.payment_batch_release: one row per release action (who, when). The batch is released
--   once it has the required number of releases: two above the tenant's batch_two_releasers
--   threshold (app.sod_settings), otherwise one. Who may release (creator ≠ releaser, two distinct
--   releasers, small-team exceptions) is the API SoD engine's decision; step-up MFA is the route's.
-- * Tenant-owned: RLS ENABLE + FORCE, tenant_isolation, explicit lf_app grants; nothing deleted.

CREATE TABLE app.payment_batch (
  id                uuid          PRIMARY KEY,
  tenant_id         uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                  REFERENCES app.tenant (id),
  company_id        uuid          NOT NULL,
  batch_no          text          NOT NULL CHECK (length(batch_no) BETWEEN 1 AND 40),
  payment_date      date          NOT NULL,
  due_by            date          NOT NULL,
  account_id        uuid          NOT NULL,
  currency          char(3)       NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  total             numeric(19,4) NOT NULL CHECK (total > 0),
  payment_count     integer       NOT NULL CHECK (payment_count > 0),
  status            text          NOT NULL DEFAULT 'draft'
                                  CHECK (status IN ('draft', 'partially_released', 'released', 'cancelled')),
  created_by        uuid,
  created_at        timestamptz   NOT NULL DEFAULT clock_timestamp(),
  updated_at        timestamptz   NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, company_id, batch_no),
  UNIQUE (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, account_id) REFERENCES app.account (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.payment_batch IS
  'Supplier payment batch (UC-06): built from due bills, released by others (SoD, step-up); only status changes.';

CREATE TABLE app.payment_batch_item (
  tenant_id         uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                  REFERENCES app.tenant (id),
  company_id        uuid          NOT NULL,
  batch_id          uuid          NOT NULL,
  line_no           integer       NOT NULL CHECK (line_no BETWEEN 1 AND 10000),
  bill_id           uuid          NOT NULL,
  party_id          uuid          NOT NULL,
  amount            numeric(19,4) NOT NULL CHECK (amount > 0),
  bank_account_id   uuid,
  excluded_reason   text          CHECK (excluded_reason IN ('BANK_DETAILS_COOLING_OFF', 'NO_VERIFIED_BANK_DETAILS')),
  payable_from      timestamptz,
  PRIMARY KEY (tenant_id, batch_id, line_no),
  UNIQUE (tenant_id, batch_id, bill_id),
  CHECK ((excluded_reason IS NULL) = (bank_account_id IS NOT NULL)),
  FOREIGN KEY (tenant_id, company_id, batch_id) REFERENCES app.payment_batch (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, bill_id) REFERENCES app.supplier_bill (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, party_id) REFERENCES app.party (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, party_id, bank_account_id)
    REFERENCES app.party_bank_account (tenant_id, company_id, party_id, id)
);
COMMENT ON TABLE app.payment_batch_item IS
  'A payment of one bill''s open amount in a batch, or the bill''s exclusion with its reason. Append-only.';
CREATE INDEX payment_batch_item_bill_idx ON app.payment_batch_item (tenant_id, bill_id);

CREATE TABLE app.payment_batch_release (
  id                uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id         uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                  REFERENCES app.tenant (id),
  company_id        uuid          NOT NULL,
  batch_id          uuid          NOT NULL,
  released_by       uuid,
  released_at       timestamptz   NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, company_id, batch_id) REFERENCES app.payment_batch (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, released_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.payment_batch_release IS 'Release actions on a payment batch (maker-checker, two above the threshold). Append-only.';
CREATE INDEX payment_batch_release_batch_idx ON app.payment_batch_release (tenant_id, batch_id);

-- Only the status moves, forward: draft → partially_released → released (or → cancelled before release).
CREATE FUNCTION app.payment_batch_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status', 'updated_at']) <> (to_jsonb(OLD) - ARRAY['status', 'updated_at']) THEN
    RAISE EXCEPTION 'payment batch % cannot be changed, only moved on', OLD.batch_no USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = OLD.status
     OR (OLD.status = 'draft' AND NEW.status IN ('partially_released', 'released', 'cancelled'))
     OR (OLD.status = 'partially_released' AND NEW.status IN ('released', 'cancelled')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'payment batch % cannot move from % to %', OLD.batch_no, OLD.status, NEW.status
    USING ERRCODE = 'check_violation';
END;
$$;
CREATE TRIGGER payment_batch_guard BEFORE UPDATE ON app.payment_batch
  FOR EACH ROW EXECUTE FUNCTION app.payment_batch_guard();

ALTER TABLE app.payment_batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.payment_batch FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.payment_batch
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.payment_batch TO lf_app;
GRANT UPDATE (status, updated_at) ON app.payment_batch TO lf_app;

ALTER TABLE app.payment_batch_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.payment_batch_item FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.payment_batch_item
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.payment_batch_item TO lf_app;

ALTER TABLE app.payment_batch_release ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.payment_batch_release FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.payment_batch_release
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.payment_batch_release TO lf_app;
