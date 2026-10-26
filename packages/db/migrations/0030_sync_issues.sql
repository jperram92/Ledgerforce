-- 0030 — Sync issues inbox, delivery failure log, API budget share (T-0071, design §5.6 rules
-- 2–3, ADR-0008, ADR-0036, RQ-0044, DL-0213..DL-0216). Owner: packages/outbox (failure log and
-- inbox), apps/worker (writers), apps/api (read and act), packages/connectors/salesforce (share).
--
-- * app.outbox_delivery_failure: one row per failed delivery attempt of an outbox event by one
--   handler: a secret-free error summary (name, kind, code, HTTP status, retryable, short
--   message). Written by the outbox worker in its own tenant transaction after the attempt rolled
--   back. pg-boss keeps only { handler, failureId } as the job output, never the message (pg-boss
--   tables have no RLS). Append-only.
-- * app.sync_issue: one row per (event, handler) whose delivery was dead-lettered — retries
--   exhausted (1 min → 6 h, ten retries) or a permanent error. Status model:
--     open → retried (user) → resolved (a later delivery succeeded) | open (dead-lettered again)
--     open → ignored (user) → retried (user)
--   A new dead letter (another dead_letter_job_id) re-opens the issue from any status with the
--   new error and more attempts. The trigger below enforces this for every role; lf_app may
--   update only the mutable columns. Nothing is deleted. User actions are audited by the API
--   (audit.audit_log); failures by the log above.
-- * app.salesforce_connection.api_budget_share: the share of the org's daily API allocation the
--   write-back may use (design §5.6 rule 3), data per connection, default 25 %.
-- * app.permission_known: + sync.issues.read, sync.issues.manage (catalogue.ts, ADR-0023).
-- * Tenant-owned: RLS ENABLE + FORCE, tenant_isolation, explicit lf_app grants.

-- ---------------------------------------------------------------------------------------------
-- Delivery failure log

CREATE TABLE app.outbox_delivery_failure (
  id             uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id      uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                             REFERENCES app.tenant (id),
  event_id       uuid        NOT NULL,
  handler        text        NOT NULL
                             CHECK (handler ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$' AND length(handler) <= 100),
  attempt        integer     NOT NULL CHECK (attempt BETWEEN 1 AND 1000),
  error_name     text        NOT NULL CHECK (error_name ~ '^[A-Za-z][A-Za-z0-9_]{0,99}$'),
  error_kind     text        CHECK (error_kind ~ '^[a-z][a-z0-9_]{0,63}$'),
  error_code     text        CHECK (length(error_code) BETWEEN 1 AND 200),
  http_status    smallint    CHECK (http_status BETWEEN 100 AND 599),
  retryable      boolean     NOT NULL,
  error_message  text        NOT NULL CHECK (length(error_message) <= 1000),
  failed_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, event_id) REFERENCES app.outbox_event (tenant_id, id)
);
COMMENT ON TABLE app.outbox_delivery_failure IS
  'One row per failed outbox delivery attempt (design 5.6): secret-free error summary. Append-only.';
CREATE INDEX outbox_delivery_failure_event_idx
  ON app.outbox_delivery_failure (tenant_id, event_id, handler, attempt);
CREATE TRIGGER outbox_delivery_failure_immutable BEFORE UPDATE OR DELETE ON app.outbox_delivery_failure
  FOR EACH ROW EXECUTE FUNCTION app.sod_never_changed();
ALTER TABLE app.outbox_delivery_failure ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.outbox_delivery_failure FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.outbox_delivery_failure
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.outbox_delivery_failure TO lf_app;

-- ---------------------------------------------------------------------------------------------
-- Sync issues inbox

CREATE TABLE app.sync_issue (
  id                  uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id           uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                  REFERENCES app.tenant (id),
  company_id          uuid,
  event_id            uuid        NOT NULL,
  handler             text        NOT NULL
                                  CHECK (handler ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$' AND length(handler) <= 100),
  connector           text        NOT NULL CHECK (connector ~ '^[a-z][a-z0-9_]{0,63}$'),
  status              text        NOT NULL DEFAULT 'open'
                                  CHECK (status IN ('open', 'retried', 'resolved', 'ignored')),
  attempts            integer     NOT NULL CHECK (attempts BETWEEN 1 AND 100000),
  last_failure_id     uuid,
  error_name          text        NOT NULL CHECK (error_name ~ '^[A-Za-z][A-Za-z0-9_]{0,99}$'),
  error_kind          text        CHECK (error_kind ~ '^[a-z][a-z0-9_]{0,63}$'),
  error_code          text        CHECK (length(error_code) BETWEEN 1 AND 200),
  http_status         smallint    CHECK (http_status BETWEEN 100 AND 599),
  retryable           boolean     NOT NULL,
  error_message       text        NOT NULL CHECK (length(error_message) <= 1000),
  dead_letter_job_id  uuid        NOT NULL,
  retry_job_id        uuid,
  note                text        CHECK (length(note) <= 500),
  status_changed_by   uuid,
  status_changed_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  first_failed_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_failed_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, event_id, handler),
  FOREIGN KEY (tenant_id, event_id) REFERENCES app.outbox_event (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, last_failure_id) REFERENCES app.outbox_delivery_failure (tenant_id, id),
  FOREIGN KEY (tenant_id, status_changed_by) REFERENCES app.app_user (tenant_id, id),
  CONSTRAINT sync_issue_retry_has_job CHECK (status <> 'retried' OR retry_job_id IS NOT NULL)
);
COMMENT ON TABLE app.sync_issue IS
  'Sync issues inbox (design 5.6 rule 2): one row per dead-lettered (event, handler), with error, attempts and a one-click retry. Never deleted.';
CREATE INDEX sync_issue_status_idx ON app.sync_issue (tenant_id, status, last_failed_at DESC, id DESC);

-- The status model, for every role (lf_app is further limited by column grants).
CREATE FUNCTION app.sync_issue_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.company_id, NEW.event_id, NEW.handler, NEW.connector,
      NEW.first_failed_at, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.company_id, OLD.event_id, OLD.handler, OLD.connector,
      OLD.first_failed_at, OLD.created_at) THEN
    RAISE EXCEPTION 'sync issue %: identity columns never change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'sync issue %: attempts never decrease', OLD.id USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.dead_letter_job_id IS DISTINCT FROM OLD.dead_letter_job_id THEN
    -- A new dead letter: the issue is open again with the new error, from any status.
    IF NEW.status <> 'open' OR NEW.attempts <= OLD.attempts THEN
      RAISE EXCEPTION 'sync issue %: a new failure re-opens the issue with more attempts', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF (NEW.last_failure_id, NEW.error_name, NEW.error_kind, NEW.error_code, NEW.http_status,
        NEW.retryable, NEW.error_message, NEW.last_failed_at, NEW.attempts)
       IS DISTINCT FROM
       (OLD.last_failure_id, OLD.error_name, OLD.error_kind, OLD.error_code, OLD.http_status,
        OLD.retryable, OLD.error_message, OLD.last_failed_at, OLD.attempts) THEN
      RAISE EXCEPTION 'sync issue %: the error changes only with a new dead letter', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = OLD.status THEN
      IF (NEW.retry_job_id, NEW.note, NEW.status_changed_by) IS DISTINCT FROM
         (OLD.retry_job_id, OLD.note, OLD.status_changed_by) THEN
        RAISE EXCEPTION 'sync issue %: nothing changes without a status change', OLD.id
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END IF;
    IF NOT (
         (OLD.status IN ('open', 'ignored') AND NEW.status = 'retried'
            AND NEW.retry_job_id IS DISTINCT FROM OLD.retry_job_id AND NEW.status_changed_by IS NOT NULL)
      OR (OLD.status = 'open' AND NEW.status = 'ignored' AND NEW.status_changed_by IS NOT NULL)
      OR (OLD.status = 'retried' AND NEW.status = 'resolved')
    ) THEN
      RAISE EXCEPTION 'sync issue % cannot go from % to %', OLD.id, OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status OR NEW.dead_letter_job_id IS DISTINCT FROM OLD.dead_letter_job_id THEN
    NEW.status_changed_at := clock_timestamp();
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER sync_issue_guard BEFORE UPDATE ON app.sync_issue
  FOR EACH ROW EXECUTE FUNCTION app.sync_issue_guard();
CREATE TRIGGER sync_issue_never_deleted BEFORE DELETE ON app.sync_issue
  FOR EACH ROW EXECUTE FUNCTION app.sod_never_changed();

ALTER TABLE app.sync_issue ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.sync_issue FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.sync_issue
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.sync_issue TO lf_app;
GRANT UPDATE (status, attempts, last_failure_id, error_name, error_kind, error_code, http_status,
              retryable, error_message, dead_letter_job_id, retry_job_id, note, status_changed_by,
              last_failed_at)
  ON app.sync_issue TO lf_app;

-- ---------------------------------------------------------------------------------------------
-- API budget share per Salesforce connection (design 5.6 rule 3)

ALTER TABLE app.salesforce_connection
  ADD COLUMN api_budget_share numeric(5,4) NOT NULL DEFAULT 0.2500
    CHECK (api_budget_share > 0 AND api_budget_share <= 1);
COMMENT ON COLUMN app.salesforce_connection.api_budget_share IS
  'Share of the org''s daily API allocation the write-back may use (design 5.6 rule 3); default 25 %.';
GRANT UPDATE (api_budget_share) ON app.salesforce_connection TO lf_app;

-- ---------------------------------------------------------------------------------------------
-- Permission mirror (catalogue.ts ALL_PERMISSIONS): + sync.issues.read, sync.issues.manage

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
               'sync.issues.read', 'sync.issues.manage')
$$;
