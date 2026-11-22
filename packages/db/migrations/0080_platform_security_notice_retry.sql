-- 0080 — Retry-now of failed security notices (T-0209, ADR-0097, RQ-0179, DL-0840..DL-0845).
-- Owner: packages/modules/email (dispatcher and retry), apps/api (routes).
-- Numbering: 0080, assigned by the lead (round 11 reserved 0079; 0078 is T-0204's and 0079
-- T-0215's, both merged into the base first).
--
-- * app.security_notice_retry: one row per failed delivery attempt that an administrator released
--   for an immediate retry ("retry now"). It names exactly one notice (as 0073 does) and the
--   attempt it releases; a composite foreign key ties it to that app.security_notice_delivery row.
--   UNIQUE (tenant_id, <notice id>, after_attempt): one release per failed attempt, so a replay or
--   a double press adds nothing (the API answers 200 for it).
-- * Guard (BEFORE INSERT): the released attempt is 'failed', is the latest attempt of the notice,
--   and the notice has no 'sent' row. Anything else is refused with 23514. Another tenant's row
--   is left to RLS (WITH CHECK refuses it with 42501), as 0077 does.
-- * The dispatcher (nextDue) ignores a failed attempt's next_attempt_at when a retry row of the
--   notice has after_attempt >= that attempt. app.security_notice_delivery stays append-only and
--   the notice tables' grants are unchanged.
-- * Tenant-owned: RLS ENABLE + FORCE, tenant_isolation; lf_app SELECT, INSERT only; append-only
--   (app.sod_never_changed on UPDATE or DELETE).
-- * app.permission_known: + security_notices.read, security_notices.retry (catalogue.ts,
--   ADR-0023 mirror). app.token_scope_allowed builds on it and needs no change.
-- Additive only; nothing is dropped or renamed.

CREATE TABLE app.security_notice_retry (
  id                    uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id             uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                    REFERENCES app.tenant (id),
  notice_kind           text        NOT NULL
                                    CHECK (notice_kind IN ('remittance_account_changed', 'bank_details_changed')),
  remittance_notice_id  uuid,
  bank_detail_notice_id uuid,
  after_attempt         integer     NOT NULL CHECK (after_attempt BETWEEN 1 AND 100000),
  requested_by          uuid        NOT NULL,
  requested_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (num_nonnulls(remittance_notice_id, bank_detail_notice_id) = 1),
  CHECK ((notice_kind = 'remittance_account_changed') = (remittance_notice_id IS NOT NULL)),
  CHECK ((notice_kind = 'bank_details_changed') = (bank_detail_notice_id IS NOT NULL)),
  UNIQUE (tenant_id, remittance_notice_id, after_attempt),
  UNIQUE (tenant_id, bank_detail_notice_id, after_attempt),
  FOREIGN KEY (tenant_id, remittance_notice_id, after_attempt)
    REFERENCES app.security_notice_delivery (tenant_id, remittance_notice_id, attempt),
  FOREIGN KEY (tenant_id, bank_detail_notice_id, after_attempt)
    REFERENCES app.security_notice_delivery (tenant_id, bank_detail_notice_id, attempt),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.security_notice_retry IS
  'ADR-0097: an administrator released a failed security notice attempt for an immediate retry. Append-only.';

CREATE FUNCTION app.security_notice_retry_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  latest record;
  sent   boolean;
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW; -- another tenant's row (or no tenant): RLS decides, as 0077
  END IF;
  SELECT d.attempt, d.outcome INTO latest
    FROM app.security_notice_delivery d
   WHERE d.tenant_id = NEW.tenant_id
     AND (d.remittance_notice_id = NEW.remittance_notice_id
          OR d.bank_detail_notice_id = NEW.bank_detail_notice_id)
   ORDER BY d.attempt DESC
   LIMIT 1;
  SELECT EXISTS (
           SELECT 1 FROM app.security_notice_delivery d
            WHERE d.tenant_id = NEW.tenant_id
              AND (d.remittance_notice_id = NEW.remittance_notice_id
                   OR d.bank_detail_notice_id = NEW.bank_detail_notice_id)
              AND d.outcome = 'sent')
    INTO sent;
  IF sent OR latest.attempt IS DISTINCT FROM NEW.after_attempt OR latest.outcome <> 'failed' THEN
    RAISE EXCEPTION 'security notice retry must release the latest failed attempt of an unsent notice'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER security_notice_retry_guard BEFORE INSERT ON app.security_notice_retry
  FOR EACH ROW EXECUTE FUNCTION app.security_notice_retry_guard();
CREATE TRIGGER security_notice_retry_immutable BEFORE UPDATE OR DELETE ON app.security_notice_retry
  FOR EACH ROW EXECUTE FUNCTION app.sod_never_changed();

ALTER TABLE app.security_notice_retry ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.security_notice_retry FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.security_notice_retry
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.security_notice_retry TO lf_app;

-- Permission mirror (catalogue.ts ALL_PERMISSIONS): + security_notices.read, security_notices.retry.
CREATE OR REPLACE FUNCTION app.permission_known(p text) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT p IN ('company.read', 'users.read', 'users.manage', 'users.roles.assign',
               'users.roles.assign_owner', 'subscription.manage', 'audit_log.read', 'settings.read',
               'settings.sod.manage', 'settings.chart.manage', 'settings.tax.manage',
               'settings.posting_rules.author', 'settings.posting_rules.activate', 'period.close',
               'period.lock', 'period.lock.override', 'period.reopen', 'gl.account.read',
               'gl.journal.read', 'gl.journal.post', 'gl.journal.approve', 'reports.run', 'parties.read',
               'parties.manage', 'parties.bank_account.read', 'parties.bank_account.change_request',
               'parties.bank_account.verify', 'bank.read', 'bank.statement.import', 'bank.reconcile',
               'tax.read', 'tax.bas.prepare', 'ar.read', 'ar.invoice.create', 'ar.invoice.send',
               'ar.credit_note.create', 'ar.credit_note.approve', 'ar.receipt.record', 'ar.dunning.run',
               'ar.batch.run', 'ar.batch.approve', 'ap.read', 'ap.bill.enter', 'ap.bill.approve',
               'ap.payment_batch.create', 'ap.payment_batch.approve', 'ap.payment_batch.release',
               'payroll.read', 'payroll.employee_bank.read', 'payroll.pay_run.import',
               'payroll.net_pay_batch.create', 'payroll.net_pay_batch.release',
               'sync.issues.read', 'sync.issues.manage',
               -- 0068 (T-0169, DL-0477, ADR-0072)
               'settings.setup.manage', 'ar.invoice.approve', 'ar.refund.create', 'ar.refund.approve',
               -- this migration (T-0209, ADR-0097)
               'security_notices.read', 'security_notices.retry')
$$;
