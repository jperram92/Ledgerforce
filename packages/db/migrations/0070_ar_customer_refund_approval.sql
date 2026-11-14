-- 0070 — Customer refund approval (T-0152, ADR-0074, DL-0477 item 3). Owner: packages/modules/ar
-- (approval record) and packages/modules/ap (batch guard).
--
-- * app.customer_refund_approval: the checker's approval of a requested refund (maker-checker:
--   the SoD rule SOD_REFUND_SELF_APPROVAL, migration 0069, refuses the refund's creator in the API
--   guard). One row per refund, append-only (SELECT, INSERT for lf_app): an approval is evidence.
--   An insert trigger refuses approving a refund that is not requested.
-- * Additive guards, so no code path can pay an unapproved refund:
--   - customer_refund_paid_needs_approval: a refund moves to paid only with an approval row;
--   - payment_batch_refund_needs_approval: a payable batch line (no exclusion) needs one.
--   They are new triggers next to the 0055 guard, which is not replaced.
-- * Every trigger skips rows of another tenant, so RLS WITH CHECK refuses those (42501), as 0055.
-- * Tenant-owned: RLS ENABLE + FORCE, tenant_isolation, explicit lf_app grants; nothing deleted.

CREATE TABLE app.customer_refund_approval (
  tenant_id     uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                            REFERENCES app.tenant (id),
  company_id    uuid        NOT NULL,
  refund_id     uuid        NOT NULL,
  approved_by   uuid        NOT NULL,
  approved_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, refund_id),
  FOREIGN KEY (tenant_id, company_id, refund_id) REFERENCES app.customer_refund (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.customer_refund_approval IS
  'Approval of a requested customer refund (ADR-0074): one per refund, append-only; a batch pays only approved refunds.';

CREATE FUNCTION app.customer_refund_approval_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  st  text;
  rno text;
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW; -- another tenant's row (or no tenant): RLS decides
  END IF;
  SELECT status, refund_no INTO st, rno FROM app.customer_refund
   WHERE tenant_id = NEW.tenant_id AND company_id = NEW.company_id AND id = NEW.refund_id
     FOR SHARE;
  IF st IS DISTINCT FROM 'requested' THEN
    RAISE EXCEPTION 'customer refund % is %; only a requested refund can be approved',
      coalesce(rno, NEW.refund_id::text), coalesce(st, 'missing')
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER customer_refund_approval_guard BEFORE INSERT ON app.customer_refund_approval
  FOR EACH ROW EXECUTE FUNCTION app.customer_refund_approval_guard();

CREATE FUNCTION app.customer_refund_paid_needs_approval() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW;
  END IF;
  IF NEW.status = 'paid' AND OLD.status IS DISTINCT FROM 'paid' AND NOT EXISTS (
    SELECT 1 FROM app.customer_refund_approval a
     WHERE a.tenant_id = NEW.tenant_id AND a.refund_id = NEW.id) THEN
    RAISE EXCEPTION 'customer refund % is not approved and cannot be paid', OLD.refund_no
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER customer_refund_paid_needs_approval BEFORE UPDATE ON app.customer_refund
  FOR EACH ROW EXECUTE FUNCTION app.customer_refund_paid_needs_approval();

CREATE FUNCTION app.payment_batch_refund_needs_approval() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW;
  END IF;
  IF NEW.excluded_reason IS NULL AND NOT EXISTS (
    SELECT 1 FROM app.customer_refund_approval a
     WHERE a.tenant_id = NEW.tenant_id AND a.refund_id = NEW.refund_id) THEN
    RAISE EXCEPTION 'customer refund % is not approved and cannot be paid in a batch', NEW.refund_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_batch_refund_needs_approval BEFORE INSERT ON app.payment_batch_refund
  FOR EACH ROW EXECUTE FUNCTION app.payment_batch_refund_needs_approval();

ALTER TABLE app.customer_refund_approval ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.customer_refund_approval FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.customer_refund_approval
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.customer_refund_approval TO lf_app;
