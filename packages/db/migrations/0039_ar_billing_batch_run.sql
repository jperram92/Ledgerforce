-- 0039 — Batch billing run: approval and exception list (T-0044, UC-02, DL-0272). Owner: packages/modules/ar.
--
-- * app.billing_batch: who approved it and when.
-- * app.billing_batch_item: why an item failed (the exception list: error code and message from
--   the posting refusal) and how many times the job tried it. A failed item's transaction rolled
--   back, so it holds no invoice and consumed no invoice number.

ALTER TABLE app.billing_batch
  ADD COLUMN approved_by uuid,
  ADD COLUMN approved_at timestamptz,
  ADD CONSTRAINT billing_batch_approved_by_fk FOREIGN KEY (tenant_id, approved_by)
    REFERENCES app.app_user (tenant_id, id);

ALTER TABLE app.billing_batch_item
  ADD COLUMN failure_code text CHECK (failure_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  ADD COLUMN failure_message text CHECK (length(failure_message) <= 2000),
  ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0);
