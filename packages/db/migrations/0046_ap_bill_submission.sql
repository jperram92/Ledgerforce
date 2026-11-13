-- 0046 — Bill approval routing (T-0052, design §6.5 rule 3, UC-05, DL-0290). Owner: packages/modules/ap.
--
-- * app.supplier_bill gains submitted_by / submitted_at: a coded draft is submitted by the AP Clerk
--   and waits in the Approver's queue ("Awaiting approval" = draft and submitted); only a submitted
--   bill can be approved and posted. Segregation of duties (SOD_BILL_SELF_APPROVAL, small-team
--   exceptions) is applied by the API's SoD engine on the approve route.

ALTER TABLE app.supplier_bill
  ADD COLUMN submitted_by uuid,
  ADD COLUMN submitted_at timestamptz,
  ADD CONSTRAINT supplier_bill_submitted_by_fk FOREIGN KEY (tenant_id, submitted_by)
    REFERENCES app.app_user (tenant_id, id),
  ADD CONSTRAINT supplier_bill_submitted_check CHECK ((submitted_by IS NULL) OR (submitted_at IS NOT NULL));
CREATE INDEX supplier_bill_queue_idx ON app.supplier_bill (tenant_id, company_id, status, submitted_at)
  WHERE status = 'draft' AND submitted_at IS NOT NULL;
