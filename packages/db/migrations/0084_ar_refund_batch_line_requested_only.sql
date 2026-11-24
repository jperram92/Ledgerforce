-- 0084 (round 12; reserved as 0086, numbered 0084 after the base reached 0083; the lead may renumber at merge) —
-- A payment batch never pays a refund that is not requested (T-0207, RQ-0189, ADR-0107,
-- DL-0950..DL-0959). Owner: packages/modules/ar (refunds.ts) with packages/modules/ap
-- (payment-batches.ts).
--
-- T-0207 lets the AR Clerk cancel a requested bank refund that no live payment batch pays. The
-- 0055 guard refuses the cancel once a live batch line is committed, but a batch build that read
-- the refund as requested before the cancel committed could still insert its line afterwards:
-- the batch build and the cancel take different advisory locks, and the 0070 insert trigger reads
-- only the approval. This trigger closes both orders:
-- * the line's insert reads the refund FOR SHARE, which conflicts with the cancel's row lock
--   (FOR NO KEY UPDATE; a foreign-key check's FOR KEY SHARE does not), so it waits for a running
--   cancel and then sees the committed status — a cancelled (or paid) refund is refused;
-- * a cancel that starts after the line was inserted waits for the line's transaction, and its
--   0055 guard then sees the committed line and refuses the cancel.
-- Excluded lines (no payment, a reason recorded) are left alone. Additive: a new function and a
-- new trigger; nothing is dropped or replaced.

CREATE FUNCTION app.payment_batch_refund_requested_only() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  st  text;
  no  text;
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW; -- another tenant's row (or no tenant): RLS decides (as migration 0070)
  END IF;
  IF NEW.excluded_reason IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT status, refund_no INTO st, no FROM app.customer_refund
   WHERE tenant_id = NEW.tenant_id AND company_id = NEW.company_id AND id = NEW.refund_id
     FOR SHARE;
  IF st IS DISTINCT FROM 'requested' THEN
    RAISE EXCEPTION 'customer refund % is % and cannot be paid in a batch', coalesce(no, NEW.refund_id::text), coalesce(st, 'missing')
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION app.payment_batch_refund_requested_only() IS
  'T-0207: a payable payment batch line needs a requested refund, read FOR SHARE so a concurrent cancel serialises with it.';
CREATE TRIGGER payment_batch_refund_requested_only BEFORE INSERT ON app.payment_batch_refund
  FOR EACH ROW EXECUTE FUNCTION app.payment_batch_refund_requested_only();
