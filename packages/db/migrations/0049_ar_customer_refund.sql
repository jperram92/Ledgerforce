-- 0049 — Customer refunds paid through the payment batch (T-0055, UC-11 step 3, GP-006,
-- postings.md Q9, DL-0288). Owner: packages/modules/ar (refund document) and packages/modules/ap
-- (batch lines).
--
-- * app.customer_refund: a refund of a customer's credit balance (client-chosen id). Requested by
--   the AR clerk against the party's available credit (checked in @ledgerforce/ar under a per-party
--   advisory lock); paid exactly once by its own posted journal entry (GP-006, source ar_refund,
--   source id = the refund id), which also allocates it to the credit. Method `bank_batch` pays it
--   in the next supplier payment batch; `stripe` (refund to the original card) is reserved for
--   T-0122 so the CHECK never has to be widened (the runner refuses DROP CONSTRAINT).
--   Status requested → paid | cancelled; only status, entry_id, paid_on and updated_at may change
--   (column grants + guard trigger), and a refund in a live batch cannot be cancelled.
-- * app.payment_batch_refund: a refund paid (or excluded) in a payment batch, like
--   app.payment_batch_item for bills (0047): the customer's verified active bank account, or the
--   exclusion reason from app.party_payment_eligibility — the same verification and cooling-off as
--   suppliers (Q9). A separate table rather than a nullable bill_id on payment_batch_item: the item
--   rows keep their bill FK and NOT NULL, and each row has exactly one kind of document.
--   Append-only (SELECT, INSERT).
-- * app.payment_batch_confirmation: a batch that pays only refunds has no GP-009 entry (each
--   refund posts its own GP-006 entry). entry_id stays NOT NULL (the verify gate refuses DROP NOT
--   NULL): such a batch's confirmation names the GP-006 entry of its first refund. The guard is
--   replaced (CREATE OR REPLACE): when the batch pays refunds and no bill, the entry must be a
--   posted ar_refund entry of a refund this batch pays; otherwise it must still be the batch's own
--   posted ap_payment entry (as 0048).
-- * Tenant-owned: RLS ENABLE + FORCE, tenant_isolation, explicit lf_app grants; nothing deleted.

CREATE TABLE app.customer_refund (
  id                uuid          PRIMARY KEY,
  tenant_id         uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                  REFERENCES app.tenant (id),
  company_id        uuid          NOT NULL,
  refund_no         text          NOT NULL CHECK (length(refund_no) BETWEEN 1 AND 40),
  party_id          uuid          NOT NULL,
  refund_date       date          NOT NULL,
  amount            numeric(19,4) NOT NULL CHECK (amount > 0),
  currency          char(3)       NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  method            text          NOT NULL CHECK (method IN ('bank_batch', 'stripe')),
  reason            text          CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 500),
  status            text          NOT NULL DEFAULT 'requested'
                                  CHECK (status IN ('requested', 'paid', 'cancelled')),
  entry_id          uuid,
  paid_on           date,
  created_by        uuid,
  created_at        timestamptz   NOT NULL DEFAULT clock_timestamp(),
  updated_at        timestamptz   NOT NULL DEFAULT clock_timestamp(),
  CHECK ((status = 'paid') = (entry_id IS NOT NULL)),
  CHECK ((status = 'paid') = (paid_on IS NOT NULL)),
  CHECK (paid_on IS NULL OR paid_on >= refund_date),
  UNIQUE (tenant_id, company_id, refund_no),
  UNIQUE (tenant_id, company_id, id),
  UNIQUE (tenant_id, entry_id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, party_id) REFERENCES app.party (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, entry_id) REFERENCES app.journal_entry (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.customer_refund IS
  'Refund of a customer credit (UC-11, GP-006): requested, then paid once by its own ar_refund entry.';
CREATE INDEX customer_refund_party_idx ON app.customer_refund (tenant_id, company_id, party_id, status);

CREATE TABLE app.payment_batch_refund (
  tenant_id         uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                  REFERENCES app.tenant (id),
  company_id        uuid          NOT NULL,
  batch_id          uuid          NOT NULL,
  line_no           integer       NOT NULL CHECK (line_no BETWEEN 1 AND 10000),
  refund_id         uuid          NOT NULL,
  party_id          uuid          NOT NULL,
  amount            numeric(19,4) NOT NULL CHECK (amount > 0),
  bank_account_id   uuid,
  excluded_reason   text          CHECK (excluded_reason IN ('BANK_DETAILS_COOLING_OFF', 'NO_VERIFIED_BANK_DETAILS')),
  payable_from      timestamptz,
  PRIMARY KEY (tenant_id, batch_id, line_no),
  UNIQUE (tenant_id, batch_id, refund_id),
  CHECK ((excluded_reason IS NULL) = (bank_account_id IS NOT NULL)),
  FOREIGN KEY (tenant_id, company_id, batch_id) REFERENCES app.payment_batch (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, refund_id) REFERENCES app.customer_refund (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, party_id) REFERENCES app.party (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, party_id, bank_account_id)
    REFERENCES app.party_bank_account (tenant_id, company_id, party_id, id)
);
COMMENT ON TABLE app.payment_batch_refund IS
  'A customer refund paid in a payment batch (to the verified bank account), or its exclusion with the reason. Append-only.';
CREATE INDEX payment_batch_refund_refund_idx ON app.payment_batch_refund (tenant_id, refund_id);

-- Only forward: requested → paid (by its own posted ar_refund entry) or → cancelled (not while a
-- live batch pays it). Nothing but status, entry_id, paid_on and updated_at changes.
CREATE FUNCTION app.customer_refund_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status', 'entry_id', 'paid_on', 'updated_at'])
     <> (to_jsonb(OLD) - ARRAY['status', 'entry_id', 'paid_on', 'updated_at']) THEN
    RAISE EXCEPTION 'customer refund % cannot be changed, only moved on', OLD.refund_no
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = OLD.status AND NEW.entry_id IS NOT DISTINCT FROM OLD.entry_id
     AND NEW.paid_on IS NOT DISTINCT FROM OLD.paid_on THEN
    RETURN NEW;
  END IF;
  IF OLD.status <> 'requested' OR NEW.status NOT IN ('paid', 'cancelled') THEN
    RAISE EXCEPTION 'customer refund % cannot move from % to %', OLD.refund_no, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'paid' AND NOT EXISTS (
    SELECT 1 FROM app.journal_entry e
     WHERE e.tenant_id = NEW.tenant_id AND e.company_id = NEW.company_id AND e.id = NEW.entry_id
       AND e.status = 'posted' AND e.source_type = 'ar_refund' AND e.source_id = NEW.id::text) THEN
    RAISE EXCEPTION 'customer refund % can only be paid by its own posted ar_refund entry', OLD.refund_no
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'cancelled' AND EXISTS (
    SELECT 1 FROM app.payment_batch_refund r
      JOIN app.payment_batch b ON b.tenant_id = r.tenant_id AND b.id = r.batch_id
     WHERE r.tenant_id = OLD.tenant_id AND r.refund_id = OLD.id
       AND r.excluded_reason IS NULL AND b.status <> 'cancelled') THEN
    RAISE EXCEPTION 'customer refund % is in a live payment batch and cannot be cancelled', OLD.refund_no
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER customer_refund_guard BEFORE UPDATE ON app.customer_refund
  FOR EACH ROW EXECUTE FUNCTION app.customer_refund_guard();

-- As 0048, except: with no bill paid in the batch the entry is the GP-006 entry of one of its refunds.
CREATE OR REPLACE FUNCTION app.payment_batch_confirmation_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  st    text;
  bno   text;
  refunds_only boolean;
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
  -- Refunds only: the batch pays at least one refund and no bill.
  refunds_only := NOT EXISTS (
      SELECT 1 FROM app.payment_batch_item i
       WHERE i.tenant_id = NEW.tenant_id AND i.batch_id = NEW.batch_id AND i.excluded_reason IS NULL)
    AND EXISTS (
      SELECT 1 FROM app.payment_batch_refund r
       WHERE r.tenant_id = NEW.tenant_id AND r.batch_id = NEW.batch_id AND r.excluded_reason IS NULL);
  IF refunds_only THEN
    IF NOT EXISTS (
      SELECT 1 FROM app.payment_batch_refund r
        JOIN app.journal_entry e ON e.tenant_id = r.tenant_id AND e.company_id = r.company_id
       WHERE r.tenant_id = NEW.tenant_id AND r.batch_id = NEW.batch_id AND r.excluded_reason IS NULL
         AND e.id = NEW.entry_id AND e.status = 'posted' AND e.source_type = 'ar_refund'
         AND e.source_id = r.refund_id::text) THEN
      RAISE EXCEPTION 'payment batch % pays only refunds and is confirmed by one of their posted ar_refund entries', bno
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
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

ALTER TABLE app.customer_refund ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.customer_refund FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.customer_refund
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.customer_refund TO lf_app;
GRANT UPDATE (status, entry_id, paid_on, updated_at) ON app.customer_refund TO lf_app;

ALTER TABLE app.payment_batch_refund ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.payment_batch_refund FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.payment_batch_refund
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.payment_batch_refund TO lf_app;
