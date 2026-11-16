-- 0072 — remittance account hardening (T-0191, ADR-0086, RQ-0168; security review r8 L1, L2,
-- DL-0694). Owner: packages/modules/ar (setting, change record, notices); packages/modules/bank
-- (company bank accounts).
--
-- L1: archiving releases the designation.
-- * app.bank_account_remittance_release(): AFTER UPDATE OF status on app.bank_account. When the
--   status of the company's designated remittance account changes (archive, or re-activation of an
--   account that migration 0071 left designated while archived), it sets
--   app.ar_settings.remittance_bank_account_id to NULL and writes an audit row
--   (remittance_account.released, masked). To print the account again, a new change must be
--   requested and approved, and that approval notifies everyone (L2).
-- * app.ar_settings_remittance_guard() (0071) is replaced with CREATE OR REPLACE and keeps its
--   contract. It now also allows, without an approval, exactly the release above: a clear to NULL
--   from inside a trigger (pg_trigger_depth() >= 2, the precedent of 0028). It refuses to
--   designate an account that is not active, even with an approval.
--
-- L2: every approved change notifies every active Owner and Finance Admin.
-- * app.remittance_account_notice: one durable notice per recipient, written in the approving
--   transaction. This follows the existing notification path, app.bank_detail_change_notice
--   (0025, T-0053). The payload masks accounts to the last 3 digits and names the requester and
--   approver. If nobody holds the roles, one no_recipient row is written. A dispatcher (T-0197)
--   records delivery.
-- * app.remittance_account_change_notify(): SECURITY DEFINER (lf_app has no INSERT on notices),
--   AFTER UPDATE on app.remittance_account_change for requested -> approved, so an approval that
--   bypasses the module still notifies.
-- * Tenant-owned: RLS ENABLE + FORCE, tenant_isolation. lf_app may SELECT and UPDATE
--   (status, sent_at) only. The guard allows only pending/failed -> sent/failed and refuses
--   DELETE. Nothing is dropped. No clear account number is stored (ADR-0018).

-- ---------------------------------------------------------------------------------------------
-- L1: only an approval, or the release on a status change, writes the remittance account.

CREATE OR REPLACE FUNCTION app.ar_settings_remittance_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  st text;
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW;
  END IF;
  IF (TG_OP = 'INSERT' AND NEW.remittance_bank_account_id IS NOT NULL)
     OR (TG_OP = 'UPDATE' AND NEW.remittance_bank_account_id IS DISTINCT FROM OLD.remittance_bank_account_id) THEN
    -- 0072: the release made by app.bank_account_remittance_release (a clear, from a trigger).
    IF TG_OP = 'UPDATE' AND NEW.remittance_bank_account_id IS NULL AND pg_trigger_depth() >= 2 THEN
      RETURN NEW;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM app.remittance_account_change c
       WHERE c.tenant_id = NEW.tenant_id AND c.company_id = NEW.company_id
         AND c.status = 'approved' AND c.decided_xact = pg_current_xact_id()
         AND c.bank_account_id IS NOT DISTINCT FROM NEW.remittance_bank_account_id) THEN
      RAISE EXCEPTION 'the remittance bank account changes only through an approved remittance account change'
        USING ERRCODE = 'check_violation';
    END IF;
    -- 0072: only an active account can be designated, even with an approval.
    IF NEW.remittance_bank_account_id IS NOT NULL THEN
      SELECT b.status INTO st FROM app.bank_account b
       WHERE b.tenant_id = NEW.tenant_id AND b.company_id = NEW.company_id
         AND b.id = NEW.remittance_bank_account_id;
      IF st IS DISTINCT FROM 'active' THEN
        RAISE EXCEPTION 'bank account % is %; only an active account can be the remittance account',
          NEW.remittance_bank_account_id, coalesce(st, 'missing')
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION app.bank_account_remittance_release() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NULL;
  END IF;
  UPDATE app.ar_settings s
     SET remittance_bank_account_id = NULL, updated_at = clock_timestamp()
   WHERE s.tenant_id = NEW.tenant_id AND s.company_id = NEW.company_id
     AND s.remittance_bank_account_id = NEW.id;
  IF FOUND THEN
    INSERT INTO audit.audit_log (tenant_id, actor_type, action, entity_type, entity_id, before, after)
    VALUES (NEW.tenant_id, 'system', 'remittance_account.released', 'ar_settings', NEW.company_id::text,
            jsonb_build_object('remittance_bank_account_id', NEW.id),
            jsonb_build_object('remittance_bank_account_id', NULL,
                               'reason', 'bank account status changed from ' || OLD.status || ' to ' || NEW.status,
                               'bank_account', jsonb_build_object(
                                 'id', NEW.id, 'name', NEW.name, 'bsb', NEW.bsb,
                                 'account_name', NEW.account_name,
                                 'account_number', '***' || NEW.account_number_last3,
                                 'currency', NEW.currency, 'status', NEW.status)));
  END IF;
  RETURN NULL;
END
$$;
COMMENT ON FUNCTION app.bank_account_remittance_release() IS
  'ADR-0086 L1: a status change of the designated remittance account releases the designation; printing it again needs a new approved change.';
CREATE TRIGGER bank_account_remittance_release AFTER UPDATE OF status ON app.bank_account
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION app.bank_account_remittance_release();

-- ---------------------------------------------------------------------------------------------
-- L2: notices of every approved change

CREATE TABLE app.remittance_account_notice (
  id                 uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id          uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                 REFERENCES app.tenant (id),
  company_id         uuid        NOT NULL,
  change_id          uuid        NOT NULL,
  kind               text        NOT NULL DEFAULT 'remittance_account_changed'
                                 CHECK (kind IN ('remittance_account_changed')),
  recipient_user_id  uuid,
  recipient_name     text,
  recipient_email    text        CHECK (recipient_email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  status             text        NOT NULL DEFAULT 'pending'
                                 CHECK (status IN ('pending', 'sent', 'failed', 'no_recipient')),
  payload            jsonb       NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  sent_at            timestamptz,
  CHECK ((recipient_user_id IS NULL) = (status = 'no_recipient')),
  CHECK ((recipient_email IS NULL) = (status = 'no_recipient')),
  CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
  UNIQUE (tenant_id, change_id, recipient_user_id),
  FOREIGN KEY (tenant_id, company_id, change_id)
    REFERENCES app.remittance_account_change (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, recipient_user_id) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.remittance_account_notice IS
  'ADR-0086: notice of an approved remittance account change to each active Owner and Finance Admin. Masked details only; a dispatcher (T-0197) records delivery.';
CREATE INDEX remittance_account_notice_pending_idx ON app.remittance_account_notice (tenant_id, created_at)
  WHERE status IN ('pending', 'failed');

ALTER TABLE app.remittance_account_notice ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.remittance_account_notice FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.remittance_account_notice
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT ON app.remittance_account_notice TO lf_app;
GRANT UPDATE (status, sent_at) ON app.remittance_account_notice TO lf_app;

-- The dispatcher may only record delivery (pending/failed -> sent/failed); never deleted.
CREATE FUNCTION app.remittance_account_notice_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'remittance account notices are never deleted (directive 6)' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status NOT IN ('pending', 'failed') OR NEW.status NOT IN ('sent', 'failed')
     OR (to_jsonb(NEW) - 'status' - 'sent_at') <> (to_jsonb(OLD) - 'status' - 'sent_at') THEN
    RAISE EXCEPTION 'remittance account notice %: only its delivery (pending/failed -> sent/failed) can be recorded', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER remittance_account_notice_guard BEFORE UPDATE OR DELETE ON app.remittance_account_notice
  FOR EACH ROW EXECUTE FUNCTION app.remittance_account_notice_guard();

-- Masked view of one company bank account for a notice payload (NULL for no account).
CREATE FUNCTION app.remittance_account_masked(p_tenant uuid, p_company uuid, p_account uuid)
  RETURNS jsonb
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object('id', b.id, 'name', b.name, 'bsb', b.bsb, 'account_name', b.account_name,
                            'account_number', '***' || b.account_number_last3, 'currency', b.currency)
    FROM app.bank_account b
   WHERE b.tenant_id = p_tenant AND b.company_id = p_company AND b.id = p_account
$$;
REVOKE ALL ON FUNCTION app.remittance_account_masked(uuid, uuid, uuid) FROM PUBLIC;

CREATE FUNCTION app.remittance_account_change_notify() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  payload jsonb;
  n integer := 0;
  r record;
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NULL; -- another tenant's row (or no tenant): RLS decides
  END IF;
  payload := jsonb_build_object(
    'kind', 'remittance_account_changed',
    'change_id', NEW.id,
    'company_id', NEW.company_id,
    'company_name', (SELECT c.name FROM app.company c WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.company_id),
    'account', app.remittance_account_masked(NEW.tenant_id, NEW.company_id, NEW.bank_account_id),
    'previous_account', app.remittance_account_masked(NEW.tenant_id, NEW.company_id, NEW.previous_bank_account_id),
    'requested_by', (SELECT jsonb_build_object('user_id', u.id, 'name', u.display_name, 'email', u.email)
                       FROM app.app_user u WHERE u.tenant_id = NEW.tenant_id AND u.id = NEW.requested_by),
    'requested_at', NEW.requested_at,
    'approved_by', (SELECT jsonb_build_object('user_id', u.id, 'name', u.display_name, 'email', u.email)
                      FROM app.app_user u WHERE u.tenant_id = NEW.tenant_id AND u.id = NEW.decided_by),
    'approved_at', NEW.decided_at,
    'self_approved', NEW.decided_by = NEW.requested_by);
  FOR r IN
    SELECT u.id, u.display_name, u.email
      FROM app.app_user u
     WHERE u.tenant_id = NEW.tenant_id AND u.status = 'active'
       AND EXISTS (SELECT 1 FROM app.user_role ur
                    WHERE ur.tenant_id = u.tenant_id AND ur.user_id = u.id AND ur.revoked_at IS NULL
                      AND ur.role IN ('owner', 'finance_admin'))
     ORDER BY u.id
  LOOP
    INSERT INTO app.remittance_account_notice
      (tenant_id, company_id, change_id, recipient_user_id, recipient_name, recipient_email, payload)
    VALUES (NEW.tenant_id, NEW.company_id, NEW.id, r.id, r.display_name, r.email, payload);
    n := n + 1;
  END LOOP;
  IF n = 0 THEN
    INSERT INTO app.remittance_account_notice (tenant_id, company_id, change_id, status, payload)
    VALUES (NEW.tenant_id, NEW.company_id, NEW.id, 'no_recipient', payload);
  END IF;
  RETURN NULL;
END
$$;
COMMENT ON FUNCTION app.remittance_account_change_notify() IS
  'ADR-0086 L2: an approved remittance account change notifies every active Owner and Finance Admin (masked), in the approving transaction.';
REVOKE ALL ON FUNCTION app.remittance_account_change_notify() FROM PUBLIC;
CREATE TRIGGER remittance_account_change_notify AFTER UPDATE ON app.remittance_account_change
  FOR EACH ROW WHEN (OLD.status = 'requested' AND NEW.status = 'approved')
  EXECUTE FUNCTION app.remittance_account_change_notify();
