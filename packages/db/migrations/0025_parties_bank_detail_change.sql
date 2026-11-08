-- 0025 — parties: bank-detail change verification with cooling-off (T-0053, design §6.1, §6.2,
-- §6.5 rule 2, RQ-0034, ADR-0030). Owner: packages/modules/parties.
--
-- * app.bank_detail_change: one row per new bank account of a supplier or employee, requested →
--   verified | rejected. lf_app has SELECT only; rows change only through the SECURITY DEFINER
--   functions below. The first account of a party goes through it too (RQ-0034 finding 5).
-- * Request (app.bank_detail_change_request): the requester holds parties.bank_account.change_request,
--   created the pending account and has a fresh step-up. It snapshots the active account and the
--   party's remittance contacts at that moment ("previous remittance contact", design §6.5 rule 2).
-- * Verify (app.bank_detail_change_verify): the verifier holds parties.bank_account.verify, has a
--   fresh MFA step-up (≤ 300 s by the database clock, mirroring ADR-0025) and writes the
--   out-of-band confirmation note. It sets payable_from = verified_at + the tenant's cooling-off
--   (frozen on the row), supersedes the old account, activates the new one and writes one notice
--   per snapshotted contact into app.bank_detail_change_notice (masked details only).
-- * Requester ≠ verifier (SOD_BANK_DETAIL_SELF_VERIFY, ADR-0026), for every role: a deferred
--   constraint trigger refuses the COMMIT unless small-team mode is on and the SoD interceptor
--   recorded the exception for this change and actor in the same transaction.
-- * app.party_bank_account (0012) is guarded: new rows start pending_verification; an account
--   becomes active only through a verified change; superseded and archived are final; at most
--   one active account per party.
-- * app.bank_detail_settings: cooling-off hours as history (latest wins, default 24, 1–720),
--   Owner only (settings.sod.manage), audited. app.party_payment_eligibility(uuid[]) is the
--   check payment batches call (T-0054): BANK_DETAILS_COOLING_OFF | NO_VERIFIED_BANK_DETAILS.
-- * Every trigger that checks under RLS skips rows of another tenant, so RLS WITH CHECK refuses
--   them with 42501 (as in 0012/0018/0021).

-- ---------------------------------------------------------------------------------------------
-- Data mirrors of TypeScript constants

-- Mirrors ROLE_TEMPLATES (packages/shared/src/rbac/catalogue.ts) for the two bank-detail writes.
CREATE FUNCTION app.role_allows_bank_detail_permission(role text, permission text) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT (permission = 'parties.bank_account.change_request' AND role IN ('owner', 'ap_clerk'))
      OR (permission = 'parties.bank_account.verify' AND role = 'owner')
$$;
COMMENT ON FUNCTION app.role_allows_bank_detail_permission(text, text) IS
  'Bank-detail write permissions of the role templates (design 6.4). Mirrors the role catalogue; proven by bank-change.workflow.db.test.ts.';
GRANT EXECUTE ON FUNCTION app.role_allows_bank_detail_permission(text, text) TO lf_app;

-- Whether an active user of the tenant holds the permission through an active role grant.
CREATE FUNCTION app.user_has_bank_detail_permission(p_tenant uuid, p_user uuid, p_permission text)
  RETURNS boolean
  LANGUAGE sql STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.user_role r
      JOIN app.app_user u ON u.tenant_id = r.tenant_id AND u.id = r.user_id
     WHERE r.tenant_id = p_tenant AND r.user_id = p_user AND r.revoked_at IS NULL
       AND u.status = 'active' AND app.role_allows_bank_detail_permission(r.role, p_permission))
$$;
GRANT EXECUTE ON FUNCTION app.user_has_bank_detail_permission(uuid, uuid, text) TO lf_app;

-- Step-up proof (ADR-0025, mirrored for defence in depth): the user's own live session, MFA by
-- amr (RFC 8176 mfa/otp/hwk) or the default MFA acr, authenticated at most 300 s ago (60 s skew).
-- A deployment that maps MFA to another acr must extend this function (fails closed meanwhile).
CREATE FUNCTION app.bank_detail_step_up_fresh(p_tenant uuid, p_user uuid, p_session uuid)
  RETURNS boolean
  LANGUAGE sql VOLATILE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.session s
      JOIN app.app_user u ON u.tenant_id = s.tenant_id AND u.id = s.user_id
     WHERE s.tenant_id = p_tenant AND s.id = p_session AND s.user_id = p_user
       AND u.status = 'active' AND s.user_session_epoch = u.session_epoch
       AND s.revoked_at IS NULL
       AND s.absolute_expires_at > clock_timestamp()
       AND s.last_seen_at + make_interval(secs => s.idle_timeout_seconds) > clock_timestamp()
       AND (s.amr && ARRAY['mfa', 'otp', 'hwk']::text[] OR s.acr = 'urn:ledgerforce:loa:mfa')
       AND s.auth_time >= clock_timestamp() - interval '300 seconds'
       AND s.auth_time <= clock_timestamp() + interval '60 seconds')
$$;
REVOKE ALL ON FUNCTION app.bank_detail_step_up_fresh(uuid, uuid, uuid) FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- Settings: the cooling-off length (design 6.5 "configurable thresholds")

CREATE TABLE app.bank_detail_settings (
  id                 uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id          uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                 REFERENCES app.tenant (id),
  cooling_off_hours  integer     NOT NULL DEFAULT 24 CHECK (cooling_off_hours BETWEEN 1 AND 720),
  set_by             uuid        NOT NULL,
  reason             text        NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  set_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, set_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.bank_detail_settings IS
  'Bank-detail cooling-off length as history; the latest row wins, none = 24 h (design 6.5). Insert-only.';
CREATE INDEX bank_detail_settings_latest_idx ON app.bank_detail_settings (tenant_id, set_at DESC, id DESC);

ALTER TABLE app.bank_detail_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bank_detail_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.bank_detail_settings
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.bank_detail_settings TO lf_app;

CREATE TRIGGER bank_detail_settings_immutable BEFORE UPDATE OR DELETE ON app.bank_detail_settings
  FOR EACH ROW EXECUTE FUNCTION app.sod_never_changed();

CREATE FUNCTION app.bank_detail_settings_check() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT app.sod_is_superuser() THEN
    NEW.set_at := clock_timestamp();
  END IF;
  -- A row for another tenant is refused by RLS WITH CHECK (42501); don't pre-empt it here.
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW;
  END IF;
  IF NOT app.user_may_manage_sod(NEW.tenant_id, NEW.set_by) THEN
    RAISE EXCEPTION 'user % does not hold settings.sod.manage', NEW.set_by
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO audit.audit_log (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, after)
  VALUES (NEW.tenant_id, 'user', NEW.set_by, 'bank_detail.settings_changed', 'bank_detail_settings',
          NEW.id::text, jsonb_build_object('cooling_off_hours', NEW.cooling_off_hours, 'reason', NEW.reason));
  RETURN NEW;
END
$$;
CREATE TRIGGER bank_detail_settings_check BEFORE INSERT ON app.bank_detail_settings
  FOR EACH ROW EXECUTE FUNCTION app.bank_detail_settings_check();

-- The cooling-off hours of the current tenant: latest settings row, else the default 24.
CREATE FUNCTION app.bank_detail_cooling_off_hours() RETURNS integer
  LANGUAGE sql STABLE
AS $$
  SELECT coalesce((SELECT s.cooling_off_hours FROM app.bank_detail_settings s
                    WHERE s.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
                    ORDER BY s.set_at DESC, s.id DESC LIMIT 1), 24)
$$;
GRANT EXECUTE ON FUNCTION app.bank_detail_cooling_off_hours() TO lf_app;

-- ---------------------------------------------------------------------------------------------
-- The change workflow

-- Composite targets so a change can only name accounts of its own party (id alone is unique).
CREATE UNIQUE INDEX party_bank_account_party_row_uq
  ON app.party_bank_account (tenant_id, company_id, party_id, id);
CREATE UNIQUE INDEX party_bank_account_one_active_uq
  ON app.party_bank_account (tenant_id, party_id) WHERE status = 'active';

CREATE TABLE app.bank_detail_change (
  id                            uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id                     uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                            REFERENCES app.tenant (id),
  company_id                    uuid        NOT NULL,
  party_id                      uuid        NOT NULL,
  bank_account_id               uuid        NOT NULL,
  previous_bank_account_id      uuid,
  previous_remittance_contacts  jsonb       NOT NULL DEFAULT '[]'::jsonb
                                            CHECK (jsonb_typeof(previous_remittance_contacts) = 'array'),
  status                        text        NOT NULL DEFAULT 'requested'
                                            CHECK (status IN ('requested', 'verified', 'rejected')),
  requested_by                  uuid        NOT NULL,
  requested_at                  timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_by                    uuid,
  decided_at                    timestamptz,
  decision_note                 text        CHECK (length(btrim(decision_note)) BETWEEN 1 AND 2000),
  cooling_off_hours             integer     CHECK (cooling_off_hours BETWEEN 1 AND 720),
  payable_from                  timestamptz,
  CHECK ((status = 'requested') = (decided_by IS NULL)),
  CHECK ((status = 'requested') = (decided_at IS NULL)),
  CHECK ((status = 'requested') = (decision_note IS NULL)),
  CHECK ((status = 'verified') = (cooling_off_hours IS NOT NULL)),
  CHECK ((status = 'verified') = (payable_from IS NOT NULL)),
  CHECK (payable_from - decided_at = make_interval(hours => cooling_off_hours)),
  CHECK (decided_at >= requested_at),
  CHECK (previous_bank_account_id IS DISTINCT FROM bank_account_id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, bank_account_id),
  FOREIGN KEY (tenant_id, company_id, party_id) REFERENCES app.party (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, party_id, bank_account_id)
    REFERENCES app.party_bank_account (tenant_id, company_id, party_id, id),
  FOREIGN KEY (tenant_id, company_id, party_id, previous_bank_account_id)
    REFERENCES app.party_bank_account (tenant_id, company_id, party_id, id),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES app.app_user (tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.bank_detail_change IS
  'Bank-detail change: requested by one user, verified (out-of-band note, step-up) by another, payable after the cooling-off (design 6.5 rule 2, ADR-0030).';
COMMENT ON COLUMN app.bank_detail_change.previous_remittance_contacts IS
  'Snapshot at request time of the party''s active remittance contacts with an email: [{contact_id, name, email}].';
COMMENT ON COLUMN app.bank_detail_change.payable_from IS
  'decided_at + cooling_off_hours (database clock); payment batches exclude the party before it.';
CREATE UNIQUE INDEX bank_detail_change_open_uq ON app.bank_detail_change (tenant_id, party_id)
  WHERE status = 'requested';
CREATE INDEX bank_detail_change_party_idx ON app.bank_detail_change (tenant_id, party_id, requested_at);

ALTER TABLE app.bank_detail_change ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bank_detail_change FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.bank_detail_change
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT ON app.bank_detail_change TO lf_app;

CREATE TABLE app.bank_detail_change_notice (
  id               uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id        uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                               REFERENCES app.tenant (id),
  change_id        uuid        NOT NULL,
  kind             text        NOT NULL DEFAULT 'bank_details_changed' CHECK (kind IN ('bank_details_changed')),
  contact_id       uuid,
  recipient_name   text,
  recipient_email  text        CHECK (recipient_email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  status           text        NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'sent', 'failed', 'no_recipient')),
  payload          jsonb       NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  sent_at          timestamptz,
  CHECK ((recipient_email IS NULL) = (status = 'no_recipient')),
  CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
  FOREIGN KEY (tenant_id, change_id) REFERENCES app.bank_detail_change (tenant_id, id)
);
COMMENT ON TABLE app.bank_detail_change_notice IS
  'Durable notice to the previous remittance contact of a verified bank-detail change (design 6.5 rule 2). Masked details only; a dispatcher sends it.';
CREATE INDEX bank_detail_change_notice_pending_idx ON app.bank_detail_change_notice (tenant_id, created_at)
  WHERE status IN ('pending', 'failed');

ALTER TABLE app.bank_detail_change_notice ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bank_detail_change_notice FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.bank_detail_change_notice
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT ON app.bank_detail_change_notice TO lf_app;
GRANT UPDATE (status, sent_at) ON app.bank_detail_change_notice TO lf_app;

-- ---------------------------------------------------------------------------------------------
-- Guards (bind every role, the table owner too)

-- A change is history: the only update is requested → verified | rejected with its decision.
CREATE FUNCTION app.bank_detail_change_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'bank-detail changes are never deleted (directive 6)' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'requested' OR NEW.status NOT IN ('verified', 'rejected')
     OR (to_jsonb(NEW) - 'status' - 'decided_by' - 'decided_at' - 'decision_note' - 'cooling_off_hours' - 'payable_from')
        <> (to_jsonb(OLD) - 'status' - 'decided_by' - 'decided_at' - 'decision_note' - 'cooling_off_hours' - 'payable_from') THEN
    RAISE EXCEPTION 'bank-detail change %: the only change is requested → verified or rejected', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER bank_detail_change_guard BEFORE UPDATE OR DELETE ON app.bank_detail_change
  FOR EACH ROW EXECUTE FUNCTION app.bank_detail_change_guard();

-- Requester ≠ verifier (SOD_BANK_DETAIL_SELF_VERIFY), checked at COMMIT so the SoD interceptor's
-- small-team exception row (written after the handler, ADR-0026) counts.
CREATE FUNCTION app.bank_detail_change_sod_check() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'verified' AND NEW.decided_by = NEW.requested_by AND NOT (
       coalesce((SELECT s.small_team_mode FROM app.sod_settings s WHERE s.tenant_id = NEW.tenant_id
                  ORDER BY s.set_at DESC, s.id DESC LIMIT 1), false)
       AND EXISTS (SELECT 1 FROM app.sod_exception e
                    WHERE e.tenant_id = NEW.tenant_id AND e.rule = 'SOD_BANK_DETAIL_SELF_VERIFY'
                      AND e.step = 'bank_detail_change.verify' AND e.subject_type = 'bank_detail_change'
                      AND e.subject_id = NEW.id::text AND e.actor_user_id = NEW.decided_by)) THEN
    RAISE EXCEPTION 'SOD_BANK_DETAIL_SELF_VERIFY: the requester of bank-detail change % cannot verify it', NEW.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_detail_self_verify';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER bank_detail_change_sod AFTER UPDATE ON app.bank_detail_change
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.bank_detail_change_sod_check();

-- Bank accounts: born pending; active only via a verified change; superseded/archived are final.
CREATE FUNCTION app.party_bank_account_status_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  -- A row for another tenant is refused by RLS (42501); don't pre-empt it here.
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending_verification' THEN
      RAISE EXCEPTION 'new bank details start pending_verification; they become active through a verified bank-detail change'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF OLD.status IN ('superseded', 'archived') OR NEW.status = 'pending_verification' THEN
    RAISE EXCEPTION 'bank account %: % is final (a new account needs a new change)', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'active' AND NOT EXISTS (
       SELECT 1 FROM app.bank_detail_change c
        WHERE c.tenant_id = NEW.tenant_id AND c.bank_account_id = NEW.id AND c.status = 'verified') THEN
    RAISE EXCEPTION 'bank account % can only become active through a verified bank-detail change', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER party_bank_account_status_guard BEFORE INSERT OR UPDATE ON app.party_bank_account
  FOR EACH ROW EXECUTE FUNCTION app.party_bank_account_status_guard();

-- Notices: the dispatcher may only record delivery (pending/failed → sent/failed).
CREATE FUNCTION app.bank_detail_change_notice_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'bank-detail notices are never deleted (directive 6)' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status NOT IN ('pending', 'failed') OR NEW.status NOT IN ('sent', 'failed')
     OR (to_jsonb(NEW) - 'status' - 'sent_at') <> (to_jsonb(OLD) - 'status' - 'sent_at') THEN
    RAISE EXCEPTION 'bank-detail notice %: only its delivery (pending/failed → sent/failed) can be recorded', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER bank_detail_change_notice_guard BEFORE UPDATE OR DELETE ON app.bank_detail_change_notice
  FOR EACH ROW EXECUTE FUNCTION app.bank_detail_change_notice_guard();

-- ---------------------------------------------------------------------------------------------
-- Workflow functions (SECURITY DEFINER: lf_app cannot write the tables directly). The table
-- owner is still under FORCE RLS, so every function sees the caller's tenant only.

CREATE FUNCTION app.bank_detail_change_request(p_id uuid, p_bank_account uuid, p_actor uuid, p_session uuid)
  RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  acct app.party_bank_account;
  prev uuid;
  contacts jsonb;
  cid uuid := coalesce(p_id, app.uuid_generate_v7());
BEGIN
  SELECT * INTO acct FROM app.party_bank_account WHERE id = p_bank_account FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown bank account %', p_bank_account
      USING ERRCODE = 'no_data_found', CONSTRAINT = 'bank_detail_not_found';
  END IF;
  IF NOT app.user_has_bank_detail_permission(acct.tenant_id, p_actor, 'parties.bank_account.change_request') THEN
    RAISE EXCEPTION 'user % does not hold parties.bank_account.change_request', p_actor
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'bank_detail_permission';
  END IF;
  IF NOT app.bank_detail_step_up_fresh(acct.tenant_id, p_actor, p_session) THEN
    RAISE EXCEPTION 'a fresh step-up of user % is required to request a bank-detail change', p_actor
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'bank_detail_step_up';
  END IF;
  IF acct.status <> 'pending_verification' OR acct.created_by IS DISTINCT FROM p_actor THEN
    RAISE EXCEPTION 'bank account % is not a pending account entered by user %', acct.id, p_actor
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_detail_change_state';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('lf.bank_detail_change:' || acct.tenant_id || ':' || acct.party_id, 0));
  IF EXISTS (SELECT 1 FROM app.bank_detail_change c
              WHERE c.tenant_id = acct.tenant_id AND c.party_id = acct.party_id AND c.status = 'requested') THEN
    RAISE EXCEPTION 'party % already has a bank-detail change awaiting verification', acct.party_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_detail_change_open';
  END IF;
  SELECT a.id INTO prev FROM app.party_bank_account a
   WHERE a.tenant_id = acct.tenant_id AND a.party_id = acct.party_id AND a.status = 'active';
  SELECT coalesce(jsonb_agg(jsonb_build_object('contact_id', c.id, 'name', c.name, 'email', c.email)
                            ORDER BY c.id), '[]'::jsonb)
    INTO contacts
    FROM app.party_contact c
    JOIN app.party_contact_role r ON r.tenant_id = c.tenant_id AND r.contact_id = c.id
   WHERE c.tenant_id = acct.tenant_id AND c.party_id = acct.party_id AND c.status = 'active'
     AND c.email IS NOT NULL AND r.role = 'remittance' AND r.active;
  INSERT INTO app.bank_detail_change (id, tenant_id, company_id, party_id, bank_account_id,
                                      previous_bank_account_id, previous_remittance_contacts, requested_by)
  VALUES (cid, acct.tenant_id, acct.company_id, acct.party_id, acct.id, prev, contacts, p_actor);
  INSERT INTO audit.audit_log (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, after)
  VALUES (acct.tenant_id, 'user', p_actor, 'bank_detail_change.requested', 'bank_detail_change', cid::text,
          jsonb_build_object('party_id', acct.party_id, 'bank_account_id', acct.id,
                             'previous_bank_account_id', prev, 'bsb', acct.bsb,
                             'account_name', acct.account_name,
                             'account_number', '***' || acct.account_number_last3,
                             'session_id', p_session));
  RETURN cid;
END
$$;
REVOKE ALL ON FUNCTION app.bank_detail_change_request(uuid, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.bank_detail_change_request(uuid, uuid, uuid, uuid) TO lf_app;

CREATE FUNCTION app.bank_detail_change_verify(p_change uuid, p_actor uuid, p_session uuid, p_note text)
  RETURNS timestamptz
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  req app.bank_detail_change;
  acct app.party_bank_account;
  prev app.party_bank_account;
  v_hours integer;
  v_at timestamptz;
  v_until timestamptz;
  payload jsonb;
  contact jsonb;
BEGIN
  SELECT * INTO req FROM app.bank_detail_change WHERE id = p_change FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown bank-detail change %', p_change
      USING ERRCODE = 'no_data_found', CONSTRAINT = 'bank_detail_not_found';
  END IF;
  IF req.status <> 'requested' THEN
    RAISE EXCEPTION 'bank-detail change % is %, not awaiting verification', req.id, req.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_detail_change_state';
  END IF;
  IF NOT app.user_has_bank_detail_permission(req.tenant_id, p_actor, 'parties.bank_account.verify') THEN
    RAISE EXCEPTION 'user % does not hold parties.bank_account.verify', p_actor
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'bank_detail_permission';
  END IF;
  IF NOT app.bank_detail_step_up_fresh(req.tenant_id, p_actor, p_session) THEN
    RAISE EXCEPTION 'a fresh step-up of user % is required to verify bank details', p_actor
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'bank_detail_step_up';
  END IF;
  IF length(btrim(coalesce(p_note, ''))) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'an out-of-band confirmation note (1–2000 characters) is required'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_detail_confirmation_note';
  END IF;
  SELECT * INTO STRICT acct FROM app.party_bank_account
   WHERE tenant_id = req.tenant_id AND id = req.bank_account_id FOR UPDATE;
  IF acct.status <> 'pending_verification' THEN
    RAISE EXCEPTION 'bank account % is %, not pending verification', acct.id, acct.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_detail_change_state';
  END IF;
  v_hours := app.bank_detail_cooling_off_hours();
  v_at := clock_timestamp();
  v_until := v_at + make_interval(hours => v_hours);
  UPDATE app.bank_detail_change
     SET status = 'verified', decided_by = p_actor, decided_at = v_at, decision_note = btrim(p_note),
         cooling_off_hours = v_hours, payable_from = v_until
   WHERE tenant_id = req.tenant_id AND id = req.id;
  SELECT * INTO prev FROM app.party_bank_account
   WHERE tenant_id = req.tenant_id AND party_id = req.party_id AND status = 'active' FOR UPDATE;
  UPDATE app.party_bank_account SET status = 'superseded'
   WHERE tenant_id = req.tenant_id AND party_id = req.party_id AND status = 'active';
  UPDATE app.party_bank_account SET status = 'active' WHERE tenant_id = req.tenant_id AND id = acct.id;

  payload := jsonb_build_object(
    'change_id', req.id, 'party_id', req.party_id, 'verified_at', v_at, 'payable_from', v_until,
    'new_account', jsonb_build_object('bsb', acct.bsb, 'account_name', acct.account_name,
                                      'account_number', '***' || acct.account_number_last3),
    'previous_account', CASE WHEN prev.id IS NULL THEN NULL
                             ELSE jsonb_build_object('bsb', prev.bsb, 'account_name', prev.account_name,
                                                     'account_number', '***' || prev.account_number_last3) END);
  IF jsonb_array_length(req.previous_remittance_contacts) = 0 THEN
    INSERT INTO app.bank_detail_change_notice (tenant_id, change_id, status, payload)
    VALUES (req.tenant_id, req.id, 'no_recipient', payload);
  ELSE
    FOR contact IN SELECT value FROM jsonb_array_elements(req.previous_remittance_contacts) LOOP
      INSERT INTO app.bank_detail_change_notice (tenant_id, change_id, contact_id, recipient_name,
                                                 recipient_email, payload)
      VALUES (req.tenant_id, req.id, (contact->>'contact_id')::uuid, contact->>'name',
              contact->>'email', payload);
    END LOOP;
  END IF;
  INSERT INTO audit.audit_log (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, after)
  VALUES (req.tenant_id, 'user', p_actor, 'bank_detail_change.verified', 'bank_detail_change', req.id::text,
          jsonb_build_object('party_id', req.party_id, 'bank_account_id', acct.id,
                             'superseded_bank_account_id', prev.id, 'requested_by', req.requested_by,
                             'confirmation_note', btrim(p_note), 'cooling_off_hours', v_hours,
                             'payable_from', v_until, 'session_id', p_session,
                             'notices', greatest(jsonb_array_length(req.previous_remittance_contacts), 1)));
  RETURN v_until;
END
$$;
REVOKE ALL ON FUNCTION app.bank_detail_change_verify(uuid, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.bank_detail_change_verify(uuid, uuid, uuid, text) TO lf_app;

CREATE FUNCTION app.bank_detail_change_reject(p_change uuid, p_actor uuid, p_reason text)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  req app.bank_detail_change;
BEGIN
  SELECT * INTO req FROM app.bank_detail_change WHERE id = p_change FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown bank-detail change %', p_change
      USING ERRCODE = 'no_data_found', CONSTRAINT = 'bank_detail_not_found';
  END IF;
  IF req.status <> 'requested' THEN
    RAISE EXCEPTION 'bank-detail change % is %, not awaiting verification', req.id, req.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_detail_change_state';
  END IF;
  IF NOT (app.user_has_bank_detail_permission(req.tenant_id, p_actor, 'parties.bank_account.verify')
          OR app.user_has_bank_detail_permission(req.tenant_id, p_actor, 'parties.bank_account.change_request')) THEN
    RAISE EXCEPTION 'user % may not reject bank-detail changes', p_actor
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'bank_detail_permission';
  END IF;
  IF length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'a reason (1–2000 characters) is required to reject a bank-detail change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_detail_confirmation_note';
  END IF;
  UPDATE app.bank_detail_change
     SET status = 'rejected', decided_by = p_actor, decided_at = clock_timestamp(), decision_note = btrim(p_reason)
   WHERE tenant_id = req.tenant_id AND id = req.id;
  UPDATE app.party_bank_account SET status = 'archived'
   WHERE tenant_id = req.tenant_id AND id = req.bank_account_id AND status = 'pending_verification';
  INSERT INTO audit.audit_log (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, after)
  VALUES (req.tenant_id, 'user', p_actor, 'bank_detail_change.rejected', 'bank_detail_change', req.id::text,
          jsonb_build_object('party_id', req.party_id, 'bank_account_id', req.bank_account_id,
                             'requested_by', req.requested_by, 'reason', btrim(p_reason)));
END
$$;
REVOKE ALL ON FUNCTION app.bank_detail_change_reject(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.bank_detail_change_reject(uuid, uuid, text) TO lf_app;

-- ---------------------------------------------------------------------------------------------
-- Payment eligibility (called by payment batches, T-0054; under the caller's RLS)

-- One row per given party, in order: payable now through its active, verified account, or why
-- not. BANK_DETAILS_COOLING_OFF: verified, but payable_from is still ahead (database clock).
CREATE FUNCTION app.party_payment_eligibility(p_parties uuid[])
  RETURNS TABLE (party_id uuid, eligible boolean, reason text, bank_account_id uuid, payable_from timestamptz)
  LANGUAGE sql VOLATILE
AS $$
  SELECT p.id,
         c.id IS NOT NULL AND c.payable_from <= t.now_,
         CASE WHEN c.id IS NULL THEN 'NO_VERIFIED_BANK_DETAILS'
              WHEN c.payable_from > t.now_ THEN 'BANK_DETAILS_COOLING_OFF' END,
         CASE WHEN c.id IS NOT NULL THEN a.id END,
         c.payable_from
    FROM (SELECT clock_timestamp() AS now_) t
   CROSS JOIN unnest(p_parties) WITH ORDINALITY AS p(id, ord)
    LEFT JOIN app.party_bank_account a ON a.party_id = p.id AND a.status = 'active'
    LEFT JOIN app.bank_detail_change c
           ON c.tenant_id = a.tenant_id AND c.bank_account_id = a.id AND c.status = 'verified'
   ORDER BY p.ord
$$;
COMMENT ON FUNCTION app.party_payment_eligibility(uuid[]) IS
  'Whether each party can be paid now (design 6.5 rule 2, UC-06 step 1): reason BANK_DETAILS_COOLING_OFF or NO_VERIFIED_BANK_DETAILS.';
GRANT EXECUTE ON FUNCTION app.party_payment_eligibility(uuid[]) TO lf_app;
