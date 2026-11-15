-- 0071 — the company's remittance bank account, set by maker-checker (T-0180, ADR-0079 accepted
-- with the RQ-0150 controls, ADR-0080). Owner: packages/modules/ar (setting and change record);
-- packages/shared (SoD rules mirror).
--
-- * app.ar_settings.remittance_bank_account_id (nullable): the one company bank account whose
--   name, BSB and number print on the company's customer invoices. Composite FK to
--   app.bank_account (tenant_id, company_id, id), so it is always an account of the same company.
-- * app.remittance_account_change: one row per requested change (requested → approved | rejected).
--   bank_account_id NULL asks to remove the remittance account. Insert needs an active account of
--   the company; at most one requested change per company. Decided rows are final; the only update
--   is the decision itself (status, decided_by, decided_at, reason).
-- * Only an approval writes the setting: a trigger on app.ar_settings refuses any insert or update
--   that changes remittance_bank_account_id unless a change of the company to exactly that value
--   was approved in the same transaction (decided_xact = pg_current_xact_id()).
-- * Requester ≠ approver (SOD_REMITTANCE_SELF_APPROVAL), checked at COMMIT like 0025
--   bank_detail_change_sod: allowed only when small-team mode is on and the SoD interceptor recorded
--   the exception for this change and actor in app.sod_exception.
-- * SoD mirror: app.sod_step_known + remittance_change.request, remittance_change.approve;
--   app.sod_rule_known + SOD_REMITTANCE_SELF_APPROVAL (packages/shared/src/sod/rules.ts;
--   packages/db/src/sod.db.test.ts proves they agree). Widened to a superset, as 0069 did.
-- * Tenant-owned: RLS ENABLE + FORCE, tenant_isolation, lf_app SELECT/INSERT/UPDATE (no DELETE);
--   every trigger skips another tenant's row so RLS WITH CHECK refuses it. Nothing is dropped.
-- * No clear account number is stored anywhere here; only ids (ADR-0018, ADR-0079 control 4).

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
                  'remittance_change.request', 'remittance_change.approve')
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
                  'SOD_REMITTANCE_SELF_APPROVAL')
$$;

ALTER TABLE app.ar_settings
  ADD COLUMN remittance_bank_account_id uuid,
  ADD CONSTRAINT ar_settings_remittance_bank_account_fk
    FOREIGN KEY (tenant_id, company_id, remittance_bank_account_id)
    REFERENCES app.bank_account (tenant_id, company_id, id);
COMMENT ON COLUMN app.ar_settings.remittance_bank_account_id IS
  'The company bank account printed on customer invoices (ADR-0079); written only by an approved app.remittance_account_change.';

CREATE TABLE app.remittance_account_change (
  id                        uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id                 uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                        REFERENCES app.tenant (id),
  company_id                uuid        NOT NULL,
  bank_account_id           uuid,
  previous_bank_account_id  uuid,
  status                    text        NOT NULL DEFAULT 'requested'
                                        CHECK (status IN ('requested', 'approved', 'rejected')),
  requested_by              uuid        NOT NULL,
  requested_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_by                uuid,
  decided_at                timestamptz,
  decided_xact              xid8,
  reason                    text        CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 2000),
  UNIQUE (tenant_id, company_id, id),
  CHECK ((status = 'requested') = (decided_by IS NULL AND decided_at IS NULL)),
  CHECK ((status = 'rejected') = (reason IS NOT NULL)),
  CHECK (bank_account_id IS DISTINCT FROM previous_bank_account_id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, bank_account_id) REFERENCES app.bank_account (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, previous_bank_account_id) REFERENCES app.bank_account (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES app.app_user (tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.remittance_account_change IS
  'Maker-checker changes of the invoice remittance bank account (ADR-0079): requested -> approved | rejected; decided rows are final.';
CREATE UNIQUE INDEX remittance_account_change_one_pending_uq
  ON app.remittance_account_change (tenant_id, company_id) WHERE status = 'requested';

CREATE FUNCTION app.remittance_account_change_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  st text;
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW; -- another tenant's row (or no tenant): RLS decides
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'requested' OR NEW.decided_xact IS NOT NULL THEN
      RAISE EXCEPTION 'a remittance account change starts as requested'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.bank_account_id IS NOT NULL THEN
      SELECT status INTO st FROM app.bank_account
       WHERE tenant_id = NEW.tenant_id AND company_id = NEW.company_id AND id = NEW.bank_account_id;
      IF st IS DISTINCT FROM 'active' THEN
        RAISE EXCEPTION 'bank account % is %; only an active account can be the remittance account',
          NEW.bank_account_id, coalesce(st, 'missing')
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'requested' OR NEW.status NOT IN ('approved', 'rejected')
     OR (to_jsonb(NEW) - 'status' - 'decided_by' - 'decided_at' - 'decided_xact' - 'reason')
        <> (to_jsonb(OLD) - 'status' - 'decided_by' - 'decided_at' - 'decided_xact' - 'reason') THEN
    RAISE EXCEPTION 'remittance account change %: the only change is requested -> approved or rejected', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.decided_xact := CASE WHEN NEW.status = 'approved' THEN pg_current_xact_id() END;
  RETURN NEW;
END
$$;
CREATE TRIGGER remittance_account_change_guard BEFORE INSERT OR UPDATE ON app.remittance_account_change
  FOR EACH ROW EXECUTE FUNCTION app.remittance_account_change_guard();

-- Requester ≠ approver, at COMMIT so the SoD interceptor's small-team exception row counts.
CREATE FUNCTION app.remittance_account_change_sod_check() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'approved' AND NEW.decided_by = NEW.requested_by AND NOT (
       coalesce((SELECT s.small_team_mode FROM app.sod_settings s WHERE s.tenant_id = NEW.tenant_id
                  ORDER BY s.set_at DESC, s.id DESC LIMIT 1), false)
       AND EXISTS (SELECT 1 FROM app.sod_exception e
                    WHERE e.tenant_id = NEW.tenant_id AND e.rule = 'SOD_REMITTANCE_SELF_APPROVAL'
                      AND e.step = 'remittance_change.approve' AND e.subject_type = 'remittance_change'
                      AND e.subject_id = NEW.id::text AND e.actor_user_id = NEW.decided_by)) THEN
    RAISE EXCEPTION 'SOD_REMITTANCE_SELF_APPROVAL: the requester of remittance account change % cannot approve it', NEW.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'remittance_self_approval';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER remittance_account_change_sod AFTER UPDATE ON app.remittance_account_change
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.remittance_account_change_sod_check();

-- Only an approval in this transaction writes the remittance account.
CREATE FUNCTION app.ar_settings_remittance_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW;
  END IF;
  IF (TG_OP = 'INSERT' AND NEW.remittance_bank_account_id IS NOT NULL)
     OR (TG_OP = 'UPDATE' AND NEW.remittance_bank_account_id IS DISTINCT FROM OLD.remittance_bank_account_id) THEN
    IF NOT EXISTS (
      SELECT 1 FROM app.remittance_account_change c
       WHERE c.tenant_id = NEW.tenant_id AND c.company_id = NEW.company_id
         AND c.status = 'approved' AND c.decided_xact = pg_current_xact_id()
         AND c.bank_account_id IS NOT DISTINCT FROM NEW.remittance_bank_account_id) THEN
      RAISE EXCEPTION 'the remittance bank account changes only through an approved remittance account change'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER ar_settings_remittance_guard BEFORE INSERT OR UPDATE ON app.ar_settings
  FOR EACH ROW EXECUTE FUNCTION app.ar_settings_remittance_guard();

ALTER TABLE app.remittance_account_change ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.remittance_account_change FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.remittance_account_change
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.remittance_account_change TO lf_app;
