-- 0048 — Payment batch confirmation: GP-009 on bank confirmation (T-0057, UC-06 step 5,
-- design §3.8 row 7, DL-0285). Owner: packages/modules/ap.
--
-- * app.payment_batch_confirmation: the bank's confirmation of a released batch — one row per
--   batch (primary key), naming the journal entry that posted it (GP-009, source ap_payment,
--   one entry per batch, unique), the date the bank confirmed (the entry date), an optional bank
--   reference and who recorded it. Append-only: lf_app has SELECT and INSERT only.
-- * Why a new table and not a 'confirmed' status: app.payment_batch.status has a CHECK from 0047
--   and the forward-only runner refuses DROP CONSTRAINT, so a CHECK cannot be widened in place
--   (precedents DL-0107, DL-0117, DL-0258). The confirmation is a fact with its own data
--   (entry, date, reference), so it lives in its own row; "confirmed" = a released batch that
--   has one. The 0047 status CHECK is unchanged.
-- * app.payment_batch_confirmation_guard (BEFORE INSERT): the batch must be released (row locked
--   FOR SHARE so a concurrent status change waits) and the entry must be the batch's own posted
--   ap_payment entry in the same company. Defence in depth: @ledgerforce/ap checks first.
-- * app.payment_batch_guard is replaced (CREATE OR REPLACE, same transitions as 0047) to also
--   refuse cancelling a batch that has a confirmation: the money has left the bank; a bank
--   rejection of one payment is UC-06 A3 (a reversal of that payment), not a cancel.
-- * Tenant-owned: RLS ENABLE + FORCE, tenant_isolation, explicit lf_app grants; nothing deleted.

CREATE TABLE app.payment_batch_confirmation (
  tenant_id         uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                  REFERENCES app.tenant (id),
  company_id        uuid          NOT NULL,
  batch_id          uuid          NOT NULL,
  entry_id          uuid          NOT NULL,
  confirmed_on      date          NOT NULL,
  bank_reference    text          CHECK (bank_reference IS NULL OR length(bank_reference) BETWEEN 1 AND 100),
  confirmed_by      uuid,
  confirmed_at      timestamptz   NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, batch_id),
  UNIQUE (tenant_id, entry_id),
  FOREIGN KEY (tenant_id, company_id, batch_id) REFERENCES app.payment_batch (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, entry_id) REFERENCES app.journal_entry (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, confirmed_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.payment_batch_confirmation IS
  'Bank confirmation of a released payment batch and its GP-009 journal (one per batch). Append-only.';

CREATE FUNCTION app.payment_batch_confirmation_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  st  text;
  bno text;
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW; -- another tenant's row (or no tenant): RLS decides (as migration 0028)
  END IF;
  SELECT status, batch_no INTO st, bno FROM app.payment_batch
   WHERE tenant_id = NEW.tenant_id AND company_id = NEW.company_id AND id = NEW.batch_id
     FOR SHARE;
  IF st IS DISTINCT FROM 'released' THEN
    RAISE EXCEPTION 'payment batch % is %; only a released batch can be confirmed', bno, coalesce(st, 'missing')
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.journal_entry e
     WHERE e.tenant_id = NEW.tenant_id AND e.company_id = NEW.company_id AND e.id = NEW.entry_id
       AND e.status = 'posted' AND e.source_type = 'ap_payment' AND e.source_id = NEW.batch_id::text) THEN
    RAISE EXCEPTION 'payment batch % can only be confirmed by its own posted ap_payment entry', bno
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_batch_confirmation_guard BEFORE INSERT ON app.payment_batch_confirmation
  FOR EACH ROW EXECUTE FUNCTION app.payment_batch_confirmation_guard();

-- Same transitions as 0047; a confirmed batch can no longer be cancelled.
CREATE OR REPLACE FUNCTION app.payment_batch_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status', 'updated_at']) <> (to_jsonb(OLD) - ARRAY['status', 'updated_at']) THEN
    RAISE EXCEPTION 'payment batch % cannot be changed, only moved on', OLD.batch_no USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'cancelled' AND NEW.status <> OLD.status AND EXISTS (
       SELECT 1 FROM app.payment_batch_confirmation c
        WHERE c.tenant_id = OLD.tenant_id AND c.batch_id = OLD.id) THEN
    RAISE EXCEPTION 'payment batch % is confirmed by the bank and cannot be cancelled', OLD.batch_no
      USING ERRCODE = 'check_violation';
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

ALTER TABLE app.payment_batch_confirmation ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.payment_batch_confirmation FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.payment_batch_confirmation
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.payment_batch_confirmation TO lf_app;
