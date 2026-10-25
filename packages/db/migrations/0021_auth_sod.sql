-- 0021 — segregation of duties: action ledger, settings, small-team exceptions and the Owner's
-- weekly acknowledgements (T-0015, design §6.4–6.5, ADR-0026). Owner: apps/api (sod), rules in
-- packages/shared/src/sod/rules.ts.
--
-- * The rules are code data (rules.ts). The database knows the step ids and rule ids through the
--   IMMUTABLE functions app.sod_step_known / app.sod_rule_known, and the Owner-only permission
--   settings.sod.manage through app.role_allows_sod_manage; packages/db sod.db.test.ts proves the
--   lists agree with the TypeScript constants.
-- * app.sod_action: "who did step X on subject Y" — one row per successful SoD-declared step,
--   written by TenantInterceptor in the request transaction. app.sod_settings: history, the
--   latest row per tenant wins; no row = the code defaults (= the column defaults below), which
--   are PLACEHOLDERS (design §11.2 open decision, DL-0131). app.sod_exception: a small-team
--   exception recorded with the action it allowed. app.sod_exception_ack: the Owner's weekly
--   acknowledgement; it covers the exceptions recorded up to its time.
-- * All four are tenant-owned (RLS ENABLE + FORCE, tenant_isolation), lf_app has SELECT and
--   INSERT only, and a trigger refuses UPDATE and DELETE for every role (directive 6).
-- * Time columns are the database clock for every role except a superuser (test data), so the
--   application cannot back-date an exception into an acknowledged week.
-- * Every trigger that checks under RLS skips rows of another tenant, so RLS WITH CHECK refuses
--   them with 42501 (as in 0012/0013/0018).

-- ---------------------------------------------------------------------------------------------
-- Data mirrors of TypeScript constants

-- Mirrors SOD_STEPS (packages/shared/src/sod/rules.ts).
CREATE FUNCTION app.sod_step_known(step text) RETURNS boolean
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
                  'period_reopen_request.request', 'period_reopen_request.approve')
$$;
COMMENT ON FUNCTION app.sod_step_known(text) IS
  'SoD step ids (design 6.5). Mirrors SOD_STEPS in packages/shared/src/sod/rules.ts.';
GRANT EXECUTE ON FUNCTION app.sod_step_known(text) TO lf_app;

-- Mirrors SOD_RULES ids (packages/shared/src/sod/rules.ts).
CREATE FUNCTION app.sod_rule_known(rule text) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT rule IN ('SOD_BATCH_SELF_RELEASE', 'SOD_BATCH_SAME_RELEASER', 'SOD_BATCH_SELF_APPROVAL',
                  'SOD_NET_PAY_SELF_RELEASE', 'SOD_BANK_DETAIL_SELF_VERIFY',
                  'SOD_BILL_SELF_APPROVAL', 'SOD_JOURNAL_SELF_APPROVAL',
                  'SOD_RULE_SELF_ACTIVATION', 'SOD_TAX_CODE_SELF_ACTIVATION',
                  'SOD_PERIOD_REOPEN_SELF_APPROVAL', 'SOD_CREDIT_NOTE_SELF_APPROVAL')
$$;
COMMENT ON FUNCTION app.sod_rule_known(text) IS
  'SoD rule ids (design 6.4-6.5). Mirrors SOD_RULES in packages/shared/src/sod/rules.ts.';
GRANT EXECUTE ON FUNCTION app.sod_rule_known(text) TO lf_app;

-- Mirrors ROLE_TEMPLATES for settings.sod.manage (Owner only).
CREATE FUNCTION app.role_allows_sod_manage(role text) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT role = 'owner'
$$;
COMMENT ON FUNCTION app.role_allows_sod_manage(text) IS
  'Roles holding settings.sod.manage (design 6.5, ADR-0026). Mirrors the role catalogue.';
GRANT EXECUTE ON FUNCTION app.role_allows_sod_manage(text) TO lf_app;

-- Whether an active user of the tenant holds settings.sod.manage through an active role grant.
CREATE FUNCTION app.user_may_manage_sod(p_tenant uuid, p_user uuid) RETURNS boolean
  LANGUAGE sql STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.user_role r
      JOIN app.app_user u ON u.tenant_id = r.tenant_id AND u.id = r.user_id
     WHERE r.tenant_id = p_tenant AND r.user_id = p_user AND r.revoked_at IS NULL
       AND u.status = 'active' AND app.role_allows_sod_manage(r.role))
$$;
GRANT EXECUTE ON FUNCTION app.user_may_manage_sod(uuid, uuid) TO lf_app;

-- ---------------------------------------------------------------------------------------------
-- Tables

CREATE TABLE app.sod_action (
  id             uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id      uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                               REFERENCES app.tenant (id),
  subject_type   text          NOT NULL CHECK (subject_type ~ '^[a-z][a-z_]*$'),
  subject_id     text          NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 200),
  step           text          NOT NULL CHECK (app.sod_step_known(step)),
  actor_user_id  uuid          NOT NULL,
  amount         numeric(19,4) CHECK (amount IS NULL OR amount >= 0),
  request_id     text          CHECK (request_id IS NULL OR length(request_id) BETWEEN 1 AND 200),
  occurred_at    timestamptz   NOT NULL DEFAULT clock_timestamp(),
  CHECK (split_part(step, '.', 1) = subject_type),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, actor_user_id) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.sod_action IS
  'SoD action ledger (design 6.5, ADR-0026): who did which step on which subject. Insert-only.';
CREATE INDEX sod_action_subject_idx ON app.sod_action (tenant_id, subject_type, subject_id, occurred_at);

CREATE TABLE app.sod_settings (
  id                                   uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id                            uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                                     REFERENCES app.tenant (id),
  small_team_mode                      boolean       NOT NULL DEFAULT false,
  bill_self_approval_threshold         numeric(19,4) NOT NULL DEFAULT 1000.0000
                                                     CHECK (bill_self_approval_threshold >= 0),
  credit_note_self_approval_threshold  numeric(19,4) NOT NULL DEFAULT 1000.0000
                                                     CHECK (credit_note_self_approval_threshold >= 0),
  journal_approval_threshold           numeric(19,4) NOT NULL DEFAULT 5000.0000
                                                     CHECK (journal_approval_threshold >= 0),
  batch_two_releasers_threshold        numeric(19,4) NOT NULL DEFAULT 10000.0000
                                                     CHECK (batch_two_releasers_threshold >= 0),
  report_timezone                      text          NOT NULL DEFAULT 'Australia/Sydney'
                                                     CHECK (length(report_timezone) BETWEEN 1 AND 64),
  set_by                               uuid          NOT NULL,
  reason                               text          NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  set_at                               timestamptz   NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, set_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.sod_settings IS
  'SoD settings as history; the latest row wins. Thresholds are PLACEHOLDERS awaiting the product owner (design 11.2).';
CREATE INDEX sod_settings_latest_idx ON app.sod_settings (tenant_id, set_at DESC, id DESC);

CREATE TABLE app.sod_exception (
  id                uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id         uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                REFERENCES app.tenant (id),
  rule              text        NOT NULL CHECK (app.sod_rule_known(rule)),
  subject_type      text        NOT NULL CHECK (subject_type ~ '^[a-z][a-z_]*$'),
  subject_id        text        NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 200),
  step              text        NOT NULL CHECK (app.sod_step_known(step)),
  actor_user_id     uuid        NOT NULL,
  kind              text        NOT NULL CHECK (kind IN ('external_reviewer', 'recorded_exception')),
  reviewer_user_id  uuid,
  reason            text        NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  request_id        text        CHECK (request_id IS NULL OR length(request_id) BETWEEN 1 AND 200),
  occurred_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (split_part(step, '.', 1) = subject_type),
  CHECK ((kind = 'external_reviewer') = (reviewer_user_id IS NOT NULL)),
  CHECK (reviewer_user_id IS DISTINCT FROM actor_user_id),
  FOREIGN KEY (tenant_id, actor_user_id) REFERENCES app.app_user (tenant_id, id),
  FOREIGN KEY (tenant_id, reviewer_user_id) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.sod_exception IS
  'Small-team SoD exceptions (design 6.5): the control weakened visibly, listed on the weekly report. Insert-only.';
CREATE INDEX sod_exception_time_idx ON app.sod_exception (tenant_id, occurred_at);

CREATE TABLE app.sod_exception_ack (
  id               uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id        uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                               REFERENCES app.tenant (id),
  week_start       date        NOT NULL CHECK (extract(isodow FROM week_start) = 1),
  acknowledged_by  uuid        NOT NULL,
  note             text        CHECK (note IS NULL OR length(note) <= 2000),
  acknowledged_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, acknowledged_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.sod_exception_ack IS
  'The Owner acknowledges a week of SoD exceptions (design 6.5); covers exceptions recorded up to acknowledged_at. Insert-only.';
CREATE INDEX sod_exception_ack_week_idx ON app.sod_exception_ack (tenant_id, week_start, acknowledged_at);

ALTER TABLE app.sod_action ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.sod_action FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.sod_action
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.sod_action TO lf_app;

ALTER TABLE app.sod_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.sod_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.sod_settings
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.sod_settings TO lf_app;

ALTER TABLE app.sod_exception ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.sod_exception FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.sod_exception
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.sod_exception TO lf_app;

ALTER TABLE app.sod_exception_ack ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.sod_exception_ack FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.sod_exception_ack
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.sod_exception_ack TO lf_app;

-- ---------------------------------------------------------------------------------------------
-- Append-only (binds the table owner too)

CREATE FUNCTION app.sod_never_changed() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '%.% rows are never deleted (directive 6)', TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  RAISE EXCEPTION '%.% rows are history and cannot change', TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER sod_action_immutable BEFORE UPDATE OR DELETE ON app.sod_action
  FOR EACH ROW EXECUTE FUNCTION app.sod_never_changed();
CREATE TRIGGER sod_settings_immutable BEFORE UPDATE OR DELETE ON app.sod_settings
  FOR EACH ROW EXECUTE FUNCTION app.sod_never_changed();
CREATE TRIGGER sod_exception_immutable BEFORE UPDATE OR DELETE ON app.sod_exception
  FOR EACH ROW EXECUTE FUNCTION app.sod_never_changed();
CREATE TRIGGER sod_exception_ack_immutable BEFORE UPDATE OR DELETE ON app.sod_exception_ack
  FOR EACH ROW EXECUTE FUNCTION app.sod_never_changed();

-- The database clock, except for a superuser (test data at a chosen time).
CREATE FUNCTION app.sod_is_superuser() RETURNS boolean
  LANGUAGE sql STABLE
AS $$
  SELECT coalesce((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false)
$$;

GRANT EXECUTE ON FUNCTION app.sod_is_superuser() TO lf_app;

CREATE FUNCTION app.sod_action_check() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT app.sod_is_superuser() THEN
    NEW.occurred_at := clock_timestamp();
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER sod_action_check BEFORE INSERT ON app.sod_action
  FOR EACH ROW EXECUTE FUNCTION app.sod_action_check();

-- ---------------------------------------------------------------------------------------------
-- Checked and audited inserts

CREATE FUNCTION app.sod_settings_check() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT app.sod_is_superuser() THEN
    NEW.set_at := clock_timestamp();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.report_timezone) THEN
    RAISE EXCEPTION 'unknown time zone %', NEW.report_timezone USING ERRCODE = 'check_violation';
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
  VALUES (NEW.tenant_id, 'user', NEW.set_by, 'sod.settings_changed', 'sod_settings', NEW.id::text,
          jsonb_build_object(
            'small_team_mode', NEW.small_team_mode,
            'bill_self_approval_threshold', NEW.bill_self_approval_threshold::text,
            'credit_note_self_approval_threshold', NEW.credit_note_self_approval_threshold::text,
            'journal_approval_threshold', NEW.journal_approval_threshold::text,
            'batch_two_releasers_threshold', NEW.batch_two_releasers_threshold::text,
            'report_timezone', NEW.report_timezone,
            'reason', NEW.reason));
  RETURN NEW;
END
$$;
CREATE TRIGGER sod_settings_check BEFORE INSERT ON app.sod_settings
  FOR EACH ROW EXECUTE FUNCTION app.sod_settings_check();

CREATE FUNCTION app.sod_exception_check() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT app.sod_is_superuser() THEN
    NEW.occurred_at := clock_timestamp();
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW;
  END IF;
  IF NEW.reviewer_user_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM app.app_user u
        WHERE u.tenant_id = NEW.tenant_id AND u.id = NEW.reviewer_user_id AND u.status = 'active') THEN
    RAISE EXCEPTION 'external reviewer % is not an active user of the tenant', NEW.reviewer_user_id
      USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO audit.audit_log (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, after)
  VALUES (NEW.tenant_id, 'user', NEW.actor_user_id, 'sod.exception_recorded', NEW.subject_type,
          NEW.subject_id,
          jsonb_build_object('exception_id', NEW.id, 'rule', NEW.rule, 'step', NEW.step,
                             'kind', NEW.kind, 'reviewer_user_id', NEW.reviewer_user_id,
                             'reason', NEW.reason));
  RETURN NEW;
END
$$;
CREATE TRIGGER sod_exception_check BEFORE INSERT ON app.sod_exception
  FOR EACH ROW EXECUTE FUNCTION app.sod_exception_check();

CREATE FUNCTION app.sod_exception_ack_check() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT app.sod_is_superuser() THEN
    NEW.acknowledged_at := clock_timestamp();
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW;
  END IF;
  IF NOT app.user_may_manage_sod(NEW.tenant_id, NEW.acknowledged_by) THEN
    RAISE EXCEPTION 'user % does not hold settings.sod.manage', NEW.acknowledged_by
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO audit.audit_log (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, after)
  VALUES (NEW.tenant_id, 'user', NEW.acknowledged_by, 'sod.exceptions_acknowledged',
          'sod_exception_week', NEW.week_start::text,
          jsonb_build_object('ack_id', NEW.id, 'note', NEW.note));
  RETURN NEW;
END
$$;
CREATE TRIGGER sod_exception_ack_check BEFORE INSERT ON app.sod_exception_ack
  FOR EACH ROW EXECUTE FUNCTION app.sod_exception_ack_check();

-- ---------------------------------------------------------------------------------------------
-- Weekly exception report (under the caller's RLS)

-- The report time zone of the current tenant: latest settings row, else the placeholder default.
CREATE FUNCTION app.sod_report_timezone() RETURNS text
  LANGUAGE sql STABLE
AS $$
  SELECT coalesce((SELECT s.report_timezone FROM app.sod_settings s
                    WHERE s.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
                    ORDER BY s.set_at DESC, s.id DESC LIMIT 1), 'Australia/Sydney')
$$;
GRANT EXECUTE ON FUNCTION app.sod_report_timezone() TO lf_app;

-- Exceptions recorded in the week starting Monday p_week_start (00:00 in the report time zone),
-- each with whether an acknowledgement of that week was recorded at or after it.
CREATE FUNCTION app.sod_exception_report(p_week_start date)
  RETURNS TABLE (id uuid, rule text, subject_type text, subject_id text, step text,
                 actor_user_id uuid, kind text, reviewer_user_id uuid, reason text,
                 occurred_at timestamptz, acknowledged boolean)
  LANGUAGE plpgsql STABLE
AS $$
DECLARE
  tz text := app.sod_report_timezone();
BEGIN
  IF p_week_start IS NULL OR extract(isodow FROM p_week_start) <> 1 THEN
    RAISE EXCEPTION 'week_start % is not a Monday', p_week_start USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
    SELECT e.id, e.rule, e.subject_type, e.subject_id, e.step, e.actor_user_id, e.kind,
           e.reviewer_user_id, e.reason, e.occurred_at,
           EXISTS (SELECT 1 FROM app.sod_exception_ack a
                    WHERE a.tenant_id = e.tenant_id AND a.week_start = p_week_start
                      AND a.acknowledged_at >= e.occurred_at)
      FROM app.sod_exception e
     WHERE e.occurred_at >= (p_week_start::timestamp AT TIME ZONE tz)
       AND e.occurred_at <  ((p_week_start + 7)::timestamp AT TIME ZONE tz)
     ORDER BY e.occurred_at, e.id;
END
$$;
GRANT EXECUTE ON FUNCTION app.sod_exception_report(date) TO lf_app;
