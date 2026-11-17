-- 0077 — Resend of a Stripe refund document after a second person confirms (T-0189, ADR-0091,
-- RQ-0173, security review r8 R3). Number 0077 as assigned by the lead (0073–0076 are taken);
-- the runner refuses gaps, so tests ran with it as 0073 before the merge.
-- Owner: packages/connectors/stripe (resend record); packages/shared (SoD rules mirror).
--
-- * app.customer_refund_stripe_resend: one row per resend of an approved, requested Stripe refund
--   document whose normal send is blocked (older than 23 hours, or Stripe holds only failed or
--   canceled refunds for it) and for which Stripe holds no live refund (checked by the connector
--   before the insert). The row records who asked, why, and the resend's own Stripe
--   Idempotency-Key `lf-refund-v3-<id>`, fixed at insert so any retry repeats the same request.
--   A second person confirms it: the only update sets confirmed_by (confirmed_at is stamped by the
--   trigger). Requester ≠ confirmer always (SOD_REFUND_RESEND_SELF_CONFIRM, no small-team
--   exception), as a CHECK and in the guard. At most one unconfirmed resend per document.
-- * SoD mirror: app.sod_step_known + refund_resend.request, refund_resend.confirm;
--   app.sod_rule_known + SOD_REFUND_RESEND_SELF_CONFIRM (packages/shared/src/sod/rules.ts;
--   packages/db/src/sod.db.test.ts proves they agree). Widened to a superset, as 0069 and 0071 did.
-- * Tenant-owned: RLS ENABLE + FORCE, tenant_isolation, lf_app SELECT, INSERT and UPDATE of
--   confirmed_by only (no DELETE); the trigger skips another tenant's row so RLS refuses it.
--   Nothing is dropped.

CREATE OR REPLACE FUNCTION app.sod_step_known(step text) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT step IN ('bill.enter', 'bill.approve',
                  'credit_note.create', 'credit_note.approve',
                  'payment_batch.create', 'payment_batch.approve', 'payment_batch.release',
                  'net_pay_batch.create', 'net_pay_batch.release',
                  'bank_detail_change.request', 'bank_detail_change.verify',
                  'manual_journal.post', 'manual_journal.approve',
                  'posting_rule.author', 'posting_rule.activate',
                  'tax_code.author', 'tax_code.activate',
                  'period_reopen_request.request', 'period_reopen_request.approve',
                  -- 0069 (DL-0477, ADR-0072)
                  'invoice.create', 'invoice.approve', 'refund.create', 'refund.approve',
                  -- 0071 (T-0180, ADR-0079)
                  'remittance_change.request', 'remittance_change.approve',
                  -- 0077 (T-0189, ADR-0091)
                  'refund_resend.request', 'refund_resend.confirm')
$$;

CREATE OR REPLACE FUNCTION app.sod_rule_known(rule text) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT rule IN ('SOD_BATCH_SELF_RELEASE', 'SOD_BATCH_SAME_RELEASER', 'SOD_BATCH_SELF_APPROVAL',
                  'SOD_NET_PAY_SELF_RELEASE', 'SOD_BANK_DETAIL_SELF_VERIFY',
                  'SOD_BILL_SELF_APPROVAL', 'SOD_JOURNAL_SELF_APPROVAL',
                  'SOD_RULE_SELF_ACTIVATION', 'SOD_TAX_CODE_SELF_ACTIVATION',
                  'SOD_PERIOD_REOPEN_SELF_APPROVAL', 'SOD_CREDIT_NOTE_SELF_APPROVAL',
                  -- 0069 (DL-0477, ADR-0072)
                  'SOD_INVOICE_SELF_APPROVAL', 'SOD_REFUND_SELF_APPROVAL',
                  -- 0071 (T-0180, ADR-0079)
                  'SOD_REMITTANCE_SELF_APPROVAL',
                  -- 0077 (T-0189, ADR-0091)
                  'SOD_REFUND_RESEND_SELF_CONFIRM')
$$;

CREATE TABLE app.customer_refund_stripe_resend (
  tenant_id        uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                               REFERENCES app.tenant (id),
  company_id       uuid        NOT NULL,
  id               uuid        NOT NULL,
  refund_id        uuid        NOT NULL,
  requested_by     uuid        NOT NULL,
  requested_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  reason           text        NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  idempotency_key  text        NOT NULL,
  confirmed_by     uuid,
  confirmed_at     timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT customer_refund_stripe_resend_key CHECK (idempotency_key = 'lf-refund-v3-' || id::text),
  CONSTRAINT customer_refund_stripe_resend_confirmed CHECK ((confirmed_by IS NULL) = (confirmed_at IS NULL)),
  CONSTRAINT "SOD_REFUND_RESEND_SELF_CONFIRM" CHECK (confirmed_by IS DISTINCT FROM requested_by),
  FOREIGN KEY (tenant_id, company_id, refund_id) REFERENCES app.customer_refund (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES app.app_user (tenant_id, id),
  FOREIGN KEY (tenant_id, confirmed_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.customer_refund_stripe_resend IS
  'Resend of a Stripe refund document with a new recorded Idempotency-Key, asked by one person and confirmed by another (ADR-0091). Append-only except the confirmation.';
CREATE UNIQUE INDEX customer_refund_stripe_resend_open_idx
  ON app.customer_refund_stripe_resend (tenant_id, refund_id) WHERE confirmed_by IS NULL;
CREATE INDEX customer_refund_stripe_resend_refund_idx
  ON app.customer_refund_stripe_resend (tenant_id, refund_id, confirmed_at);

CREATE FUNCTION app.customer_refund_stripe_resend_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  st   text;
  mth  text;
  rno  text;
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW; -- another tenant's row (or no tenant): RLS decides
  END IF;
  SELECT status, method, refund_no INTO st, mth, rno FROM app.customer_refund
   WHERE tenant_id = NEW.tenant_id AND company_id = NEW.company_id AND id = NEW.refund_id
     FOR SHARE;
  IF TG_OP = 'INSERT' THEN
    IF NEW.confirmed_by IS NOT NULL OR NEW.confirmed_at IS NOT NULL THEN
      RAISE EXCEPTION 'a Stripe refund resend is confirmed only after it was asked'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.requested_at := clock_timestamp();
    IF mth IS DISTINCT FROM 'stripe' OR st IS DISTINCT FROM 'requested' OR NOT EXISTS (
      SELECT 1 FROM app.customer_refund_approval a
       WHERE a.tenant_id = NEW.tenant_id AND a.refund_id = NEW.refund_id) THEN
      RAISE EXCEPTION 'customer refund % is not approved, or not a requested Stripe refund; it cannot be resent',
        coalesce(rno, NEW.refund_id::text)
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE: only the confirmation, once, by another person, while the refund is still requested.
  IF (to_jsonb(NEW) - ARRAY['confirmed_by', 'confirmed_at'])
     <> (to_jsonb(OLD) - ARRAY['confirmed_by', 'confirmed_at']) THEN
    RAISE EXCEPTION 'Stripe refund resend % cannot be changed, only confirmed', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.confirmed_by IS NOT NULL THEN
    IF NEW.confirmed_by IS NOT DISTINCT FROM OLD.confirmed_by
       AND NEW.confirmed_at IS NOT DISTINCT FROM OLD.confirmed_at THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Stripe refund resend % is already confirmed', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.confirmed_by IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.confirmed_by = OLD.requested_by THEN
    RAISE EXCEPTION 'SOD_REFUND_RESEND_SELF_CONFIRM: the person who asked for resend % cannot confirm it', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF st IS DISTINCT FROM 'requested' THEN
    RAISE EXCEPTION 'customer refund % is %; its resend cannot be confirmed', rno, coalesce(st, 'missing')
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.confirmed_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER customer_refund_stripe_resend_guard
  BEFORE INSERT OR UPDATE ON app.customer_refund_stripe_resend
  FOR EACH ROW EXECUTE FUNCTION app.customer_refund_stripe_resend_guard();

ALTER TABLE app.customer_refund_stripe_resend ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.customer_refund_stripe_resend FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.customer_refund_stripe_resend
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.customer_refund_stripe_resend TO lf_app;
GRANT UPDATE (confirmed_by) ON app.customer_refund_stripe_resend TO lf_app;
