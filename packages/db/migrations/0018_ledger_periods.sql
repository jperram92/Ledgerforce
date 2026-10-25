-- 0018 — ledger: fiscal periods, the close status matrix, overrides, reopen and the lock-date
-- policy settings (T-0023, design §3.3 invariant 3, §3.5, §2, §5.6 rule 5; RQ-0026).
-- Owner: packages/ledger (period control). The matrix itself is data in
-- packages/ledger/src/period-matrix.ts; the IMMUTABLE functions below mirror it and
-- period-control.db.test.ts proves they agree cell by cell.
--
-- * app.fiscal_year / app.fiscal_period: per company, generated from a convention held as data
--   (AU 1 July by default, in code as data, not here). Periods of a company never overlap and lie
--   inside their fiscal year (trigger under an advisory lock per company). Inserted 'open'.
-- * Status: open → ar_locked → ap_locked → soft_closed → hard_locked. lf_app has no UPDATE on
--   fiscal_period: every change goes through SECURITY DEFINER functions that check the actor's
--   period permission (period.lock / period.close forward, period.reopen backward with a reason)
--   and write app.period_status_change and audit.audit_log. A hard-locked period changes only via
--   app.period_reopen_request + app.period_reopen_approve by a different user (two approvers),
--   both holding period.reopen, with a reason. Even the owner can change nothing but status, and
--   no row of these tables is ever removed.
-- * Invariant 3: a BEFORE INSERT OR UPDATE OF status trigger on journal_entry, for a posted
--   entry, finds the period containing entry_date (none → constraint journal_entry_in_period),
--   fills period_id (a different client value is refused), refuses unknown source types
--   (journal_entry_source_type_known) and applies app.period_decision: allow; override only with
--   an app.period_override row for this entry's company, period, source type and idempotency key
--   granted to the entry's created_by; otherwise journal_entry_period_allows (PERIOD_LOCKED).
--   journal_entry.period_id gets its foreign key here (left by 0007).
-- * Races: posters take a shared, status changes an exclusive transaction advisory lock on the
--   period (lf_app cannot use FOR SHARE without UPDATE privilege, RQ-0026 S8).
-- * Reconciliation (SS-UC08-07): a bank statement line dated in a hard-locked period cannot
--   change status (match/unmatch/exclude).
-- * Settings: app.period_settings is history (insert-only); the latest row per tenant holds the
--   lock-date policy (reject | post_to_first_open_date_with_note) and payout_under_ar_lock
--   (override | allow) — the open product-owner question of design §11.3 item 4. No row = defaults
--   reject / override.
-- * Every trigger that checks under RLS skips rows of another tenant, so RLS WITH CHECK refuses
--   them with 42501 (as in 0012/0013).

-- ---------------------------------------------------------------------------------------------
-- Data mirrors of TypeScript constants

-- Mirrors ROLE_TEMPLATES (packages/shared/src/rbac/catalogue.ts) for the four period permissions.
CREATE FUNCTION app.role_allows_period_permission(role text, permission text) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT role IN ('owner', 'finance_admin')
     AND permission IN ('period.lock', 'period.close', 'period.lock.override', 'period.reopen')
$$;
COMMENT ON FUNCTION app.role_allows_period_permission(text, text) IS
  'Period permissions of the role templates (design 6.4). Mirrors the role catalogue; proven by period-control.db.test.ts.';
GRANT EXECUTE ON FUNCTION app.role_allows_period_permission(text, text) TO lf_app;

-- Whether an active user of the tenant holds the permission through an active role grant.
CREATE FUNCTION app.user_has_period_permission(p_tenant uuid, p_user uuid, p_permission text)
  RETURNS boolean
  LANGUAGE sql STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.user_role r
      JOIN app.app_user u ON u.tenant_id = r.tenant_id AND u.id = r.user_id
     WHERE r.tenant_id = p_tenant AND r.user_id = p_user AND r.revoked_at IS NULL
       AND u.status = 'active' AND app.role_allows_period_permission(r.role, p_permission))
$$;
GRANT EXECUTE ON FUNCTION app.user_has_period_permission(uuid, uuid, text) TO lf_app;

-- Mirrors SOURCE_TYPES in packages/ledger/src/period-matrix.ts. NULL = unknown (refused).
CREATE FUNCTION app.source_type_class(source_type text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN source_type IN ('ar_invoice', 'ar_credit_note', 'ar_receipt', 'ar_refund', 'ar_write_off',
                         'ar_prepayment', 'ar_prepayment_application', 'payments_stripe_charge') THEN 'ar'
    WHEN source_type IN ('ap_bill', 'ap_payment', 'payroll_pay_run', 'payroll_net_pay_batch') THEN 'ap'
    WHEN source_type = 'payments_stripe_payout' THEN 'payout'
    WHEN source_type = 'manual_journal' THEN 'journal'
    WHEN source_type = 'ledger_reversal' THEN 'reversal'
  END
$$;
GRANT EXECUTE ON FUNCTION app.source_type_class(text) TO lf_app;

-- Mirrors PERIOD_MATRIX (design 3.5): 'allow' | 'override' | 'deny'.
CREATE FUNCTION app.period_decision(status text, source_class text, payout_under_ar_lock text)
  RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN source_class IS NULL OR source_class NOT IN ('ar', 'ap', 'journal', 'payout', 'reversal') THEN 'deny'
    WHEN status = 'open' THEN 'allow'
    WHEN status = 'ar_locked' THEN
      CASE source_class
        WHEN 'ap' THEN 'allow'
        WHEN 'journal' THEN 'allow'
        WHEN 'payout' THEN CASE WHEN payout_under_ar_lock = 'allow' THEN 'allow' ELSE 'override' END
        ELSE 'override'
      END
    WHEN status = 'ap_locked' THEN CASE WHEN source_class = 'journal' THEN 'allow' ELSE 'override' END
    WHEN status = 'soft_closed' THEN 'override'
    ELSE 'deny'
  END
$$;
GRANT EXECUTE ON FUNCTION app.period_decision(text, text, text) TO lf_app;

CREATE FUNCTION app.period_status_rank(status text) RETURNS int
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT array_position(ARRAY['open', 'ar_locked', 'ap_locked', 'soft_closed', 'hard_locked'], status) - 1
$$;
GRANT EXECUTE ON FUNCTION app.period_status_rank(text) TO lf_app;

-- Advisory-lock keys: one per period (posting vs status change), one per company (overlaps).
CREATE FUNCTION app.period_lock_key(id uuid) RETURNS bigint
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$ SELECT hashtextextended('lf.period:' || id::text, 0) $$;
GRANT EXECUTE ON FUNCTION app.period_lock_key(uuid) TO lf_app;

-- ---------------------------------------------------------------------------------------------
-- Tables

CREATE TABLE app.fiscal_year (
  id          uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id   uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                          REFERENCES app.tenant (id),
  company_id  uuid        NOT NULL,
  label       text        NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 20),
  start_date  date        NOT NULL,
  end_date    date        NOT NULL,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (start_date <= end_date),
  UNIQUE (tenant_id, company_id, id),
  UNIQUE (tenant_id, company_id, label),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.fiscal_year IS
  'Fiscal year of a company (design 3.5); label FY<end year>. Generated from a convention held as data; never removed.';

ALTER TABLE app.fiscal_year ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.fiscal_year FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.fiscal_year
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.fiscal_year TO lf_app;

CREATE TABLE app.fiscal_period (
  id                 uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id          uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                 REFERENCES app.tenant (id),
  company_id         uuid        NOT NULL,
  fiscal_year_id     uuid        NOT NULL,
  period_no          smallint    NOT NULL CHECK (period_no BETWEEN 1 AND 13),
  name               text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 40),
  start_date         date        NOT NULL,
  end_date           date        NOT NULL,
  status             text        NOT NULL DEFAULT 'open'
                                 CHECK (status IN ('open', 'ar_locked', 'ap_locked', 'soft_closed', 'hard_locked')),
  status_changed_at  timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (start_date <= end_date),
  UNIQUE (tenant_id, company_id, id),
  UNIQUE (tenant_id, fiscal_year_id, period_no),
  FOREIGN KEY (tenant_id, company_id, fiscal_year_id) REFERENCES app.fiscal_year (tenant_id, company_id, id)
);
COMMENT ON TABLE app.fiscal_period IS
  'Accounting period with its close status (design 3.5). Status changes only via app.period_set_status / reopen functions.';
CREATE INDEX fiscal_period_dates_idx ON app.fiscal_period (tenant_id, company_id, start_date, end_date);

ALTER TABLE app.fiscal_period ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.fiscal_period FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.fiscal_period
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.fiscal_period TO lf_app;

ALTER TABLE app.journal_entry ADD CONSTRAINT journal_entry_period_fk
  FOREIGN KEY (tenant_id, company_id, period_id) REFERENCES app.fiscal_period (tenant_id, company_id, id);

CREATE TABLE app.period_reopen_request (
  id            uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id     uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                            REFERENCES app.tenant (id),
  company_id    uuid        NOT NULL,
  period_id     uuid        NOT NULL,
  to_status     text        NOT NULL CHECK (to_status IN ('open', 'ar_locked', 'ap_locked', 'soft_closed')),
  reason        text        NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  requested_by  uuid        NOT NULL,
  requested_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  status        text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved')),
  approved_by   uuid,
  approved_at   timestamptz,
  CHECK ((status = 'approved') = (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  CHECK (approved_by IS DISTINCT FROM requested_by),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, period_id) REFERENCES app.fiscal_period (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES app.app_user (tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.period_reopen_request IS
  'Reopen of a hard-locked period: requested by one holder of period.reopen, approved by a different one (design 3.5).';
CREATE UNIQUE INDEX period_reopen_request_pending_uq ON app.period_reopen_request (tenant_id, period_id)
  WHERE status = 'pending';

ALTER TABLE app.period_reopen_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.period_reopen_request FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.period_reopen_request
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT ON app.period_reopen_request TO lf_app;

CREATE TABLE app.period_status_change (
  id                 uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id          uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                 REFERENCES app.tenant (id),
  company_id         uuid        NOT NULL,
  period_id          uuid        NOT NULL,
  from_status        text        NOT NULL CHECK (from_status IN ('open', 'ar_locked', 'ap_locked', 'soft_closed', 'hard_locked')),
  to_status          text        NOT NULL CHECK (to_status IN ('open', 'ar_locked', 'ap_locked', 'soft_closed', 'hard_locked')),
  changed_by         uuid        NOT NULL,
  reason             text        CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  reopen_request_id  uuid,
  changed_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (from_status <> to_status),
  FOREIGN KEY (tenant_id, company_id, period_id) REFERENCES app.fiscal_period (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, changed_by) REFERENCES app.app_user (tenant_id, id),
  FOREIGN KEY (tenant_id, reopen_request_id) REFERENCES app.period_reopen_request (tenant_id, id)
);
COMMENT ON TABLE app.period_status_change IS
  'History of every period status change: who, when, why (design 3.5, UC-10). Written only by the period functions.';
CREATE INDEX period_status_change_period_idx ON app.period_status_change (tenant_id, period_id, changed_at);

ALTER TABLE app.period_status_change ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.period_status_change FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.period_status_change
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT ON app.period_status_change TO lf_app;

CREATE TABLE app.period_override (
  id               uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id        uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                               REFERENCES app.tenant (id),
  company_id       uuid        NOT NULL,
  period_id        uuid        NOT NULL,
  source_type      text        NOT NULL CHECK (source_type ~ '^[a-z][a-z0-9_]*$'),
  idempotency_key  text        NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  granted_by       uuid        NOT NULL,
  reason           text        NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, company_id, idempotency_key),
  FOREIGN KEY (tenant_id, company_id, period_id) REFERENCES app.fiscal_period (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, granted_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.period_override IS
  'One override per posting into an AR/AP-locked or soft-closed period, by a holder of period.lock.override (design 3.5). Audited; insert-only.';

ALTER TABLE app.period_override ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.period_override FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.period_override
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.period_override TO lf_app;

CREATE TABLE app.period_settings (
  id                    uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id             uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                    REFERENCES app.tenant (id),
  lock_date_policy      text        NOT NULL DEFAULT 'reject'
                                    CHECK (lock_date_policy IN ('reject', 'post_to_first_open_date_with_note')),
  payout_under_ar_lock  text        NOT NULL DEFAULT 'override'
                                    CHECK (payout_under_ar_lock IN ('override', 'allow')),
  set_by                uuid        NOT NULL,
  reason                text        NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  set_at                timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, set_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.period_settings IS
  'Tenant period settings as history; the latest row wins (design 2, 5.6 rule 5; payout_under_ar_lock: design 11.3 item 4, awaiting the product owner).';
COMMENT ON COLUMN app.period_settings.payout_under_ar_lock IS
  'Bank/Stripe payout dated in an AR-locked period: override (treated as AR, default) | allow. Open question for the product owner (RQ-0026).';
CREATE INDEX period_settings_latest_idx ON app.period_settings (tenant_id, set_at DESC, id DESC);

ALTER TABLE app.period_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.period_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.period_settings
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.period_settings TO lf_app;

-- ---------------------------------------------------------------------------------------------
-- Shape guards (bind the owner too)

CREATE FUNCTION app.period_never_removed() RETURNS trigger
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
CREATE TRIGGER fiscal_year_immutable BEFORE UPDATE OR DELETE ON app.fiscal_year
  FOR EACH ROW EXECUTE FUNCTION app.period_never_removed();
CREATE TRIGGER period_status_change_immutable BEFORE UPDATE OR DELETE ON app.period_status_change
  FOR EACH ROW EXECUTE FUNCTION app.period_never_removed();
CREATE TRIGGER period_override_immutable BEFORE UPDATE OR DELETE ON app.period_override
  FOR EACH ROW EXECUTE FUNCTION app.period_never_removed();
CREATE TRIGGER period_settings_immutable BEFORE UPDATE OR DELETE ON app.period_settings
  FOR EACH ROW EXECUTE FUNCTION app.period_never_removed();

CREATE FUNCTION app.fiscal_year_check() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  -- A row for another tenant is refused by RLS WITH CHECK (42501); don't pre-empt it here.
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('lf.fiscal_calendar:' || NEW.company_id::text, 0));
  IF EXISTS (SELECT 1 FROM app.fiscal_year y
              WHERE y.tenant_id = NEW.tenant_id AND y.company_id = NEW.company_id
                AND y.start_date <= NEW.end_date AND NEW.start_date <= y.end_date) THEN
    RAISE EXCEPTION 'fiscal year % (% … %) would overlap another fiscal year of company %',
      NEW.label, NEW.start_date, NEW.end_date, NEW.company_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER fiscal_year_check BEFORE INSERT ON app.fiscal_year
  FOR EACH ROW EXECUTE FUNCTION app.fiscal_year_check();

CREATE FUNCTION app.fiscal_period_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  fy app.fiscal_year;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'fiscal periods are never deleted (period %)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - 'status' - 'status_changed_at') <> (to_jsonb(OLD) - 'status' - 'status_changed_at') THEN
      RAISE EXCEPTION 'only the status of a fiscal period can change (period %)', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW;
  END IF;
  IF NEW.status <> 'open' THEN
    RAISE EXCEPTION 'a fiscal period is inserted open (got %); change status with app.period_set_status', NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO fy FROM app.fiscal_year
   WHERE tenant_id = NEW.tenant_id AND company_id = NEW.company_id AND id = NEW.fiscal_year_id;
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key reports it
  END IF;
  IF NEW.start_date < fy.start_date OR NEW.end_date > fy.end_date THEN
    RAISE EXCEPTION 'period % (% … %) must lie inside its fiscal year % (% … %)',
      NEW.name, NEW.start_date, NEW.end_date, fy.label, fy.start_date, fy.end_date
      USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('lf.fiscal_calendar:' || NEW.company_id::text, 0));
  IF EXISTS (SELECT 1 FROM app.fiscal_period p
              WHERE p.tenant_id = NEW.tenant_id AND p.company_id = NEW.company_id
                AND p.start_date <= NEW.end_date AND NEW.start_date <= p.end_date) THEN
    RAISE EXCEPTION 'period % (% … %) would overlap another period of company %',
      NEW.name, NEW.start_date, NEW.end_date, NEW.company_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER fiscal_period_guard BEFORE INSERT OR UPDATE OR DELETE ON app.fiscal_period
  FOR EACH ROW EXECUTE FUNCTION app.fiscal_period_guard();

CREATE FUNCTION app.period_reopen_request_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reopen requests are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'pending' OR NEW.status <> 'approved'
     OR (to_jsonb(NEW) - 'status' - 'approved_by' - 'approved_at')
        <> (to_jsonb(OLD) - 'status' - 'approved_by' - 'approved_at') THEN
    RAISE EXCEPTION 'reopen request %: the only change is pending → approved', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER period_reopen_request_guard BEFORE UPDATE OR DELETE ON app.period_reopen_request
  FOR EACH ROW EXECUTE FUNCTION app.period_reopen_request_guard();

-- ---------------------------------------------------------------------------------------------
-- Settings and overrides (inserted by lf_app; checked and audited here)

CREATE FUNCTION app.period_settings_check() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW;
  END IF;
  IF NOT app.user_has_period_permission(NEW.tenant_id, NEW.set_by, 'period.lock') THEN
    RAISE EXCEPTION 'user % does not hold period.lock (needed to change period settings)', NEW.set_by
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO audit.audit_log (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, after)
  VALUES (NEW.tenant_id, 'user', NEW.set_by, 'period.settings_changed', 'period_settings', NEW.id::text,
          jsonb_build_object('lock_date_policy', NEW.lock_date_policy,
                             'payout_under_ar_lock', NEW.payout_under_ar_lock, 'reason', NEW.reason));
  RETURN NEW;
END
$$;
CREATE TRIGGER period_settings_check BEFORE INSERT ON app.period_settings
  FOR EACH ROW EXECUTE FUNCTION app.period_settings_check();

CREATE FUNCTION app.period_current_payout_setting(p_tenant uuid) RETURNS text
  LANGUAGE sql STABLE
AS $$
  SELECT coalesce((SELECT payout_under_ar_lock FROM app.period_settings
                    WHERE tenant_id = p_tenant ORDER BY set_at DESC, id DESC LIMIT 1), 'override')
$$;
GRANT EXECUTE ON FUNCTION app.period_current_payout_setting(uuid) TO lf_app;

CREATE FUNCTION app.period_override_check() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  per app.fiscal_period;
  d text;
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW;
  END IF;
  IF NOT app.user_has_period_permission(NEW.tenant_id, NEW.granted_by, 'period.lock.override') THEN
    RAISE EXCEPTION 'user % does not hold period.lock.override', NEW.granted_by
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(app.period_lock_key(NEW.period_id));
  SELECT * INTO per FROM app.fiscal_period
   WHERE tenant_id = NEW.tenant_id AND company_id = NEW.company_id AND id = NEW.period_id;
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key reports it
  END IF;
  d := app.period_decision(per.status, app.source_type_class(NEW.source_type),
                           app.period_current_payout_setting(NEW.tenant_id));
  IF d <> 'override' THEN
    RAISE EXCEPTION 'period % is %: % postings there are "%", so no override can be recorded',
      per.name, per.status, NEW.source_type, d USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO audit.audit_log (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, after)
  VALUES (NEW.tenant_id, 'user', NEW.granted_by, 'period.override', 'period_override', NEW.id::text,
          jsonb_build_object('period_id', NEW.period_id, 'period_status', per.status,
                             'source_type', NEW.source_type, 'idempotency_key', NEW.idempotency_key,
                             'reason', NEW.reason));
  RETURN NEW;
END
$$;
CREATE TRIGGER period_override_check BEFORE INSERT ON app.period_override
  FOR EACH ROW EXECUTE FUNCTION app.period_override_check();

-- ---------------------------------------------------------------------------------------------
-- Invariant 3 on the journal, and the reconciliation lock

CREATE FUNCTION app.journal_entry_period_check() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  per app.fiscal_period;
  cls text;
  d text;
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW;
  END IF;
  IF NEW.status <> 'posted' OR (TG_OP = 'UPDATE' AND OLD.status <> 'draft') THEN
    RETURN NEW; -- drafts are not checked; posted → reversed is not a posting
  END IF;
  SELECT * INTO per FROM app.fiscal_period
   WHERE tenant_id = NEW.tenant_id AND company_id = NEW.company_id
     AND NEW.entry_date BETWEEN start_date AND end_date;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NO_PERIOD: no fiscal period of company % covers %', NEW.company_id, NEW.entry_date
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_entry_in_period';
  END IF;
  IF NEW.period_id IS NOT NULL AND NEW.period_id <> per.id THEN
    RAISE EXCEPTION 'NO_PERIOD: period_id % does not contain entry_date % (period % does)',
      NEW.period_id, NEW.entry_date, per.name
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_entry_in_period';
  END IF;
  NEW.period_id := per.id;
  cls := app.source_type_class(NEW.source_type);
  IF cls IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_SOURCE_TYPE: % is not in the period matrix', NEW.source_type
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_entry_source_type_known';
  END IF;
  -- Serialise with status changes, then read the status again (new snapshot per statement).
  PERFORM pg_advisory_xact_lock_shared(app.period_lock_key(per.id));
  SELECT status INTO per.status FROM app.fiscal_period WHERE tenant_id = NEW.tenant_id AND id = per.id;
  d := app.period_decision(per.status, cls, app.period_current_payout_setting(NEW.tenant_id));
  IF d = 'allow' THEN
    RETURN NEW;
  END IF;
  IF d = 'override' AND NEW.created_by IS NOT NULL AND EXISTS (
       SELECT 1 FROM app.period_override o
        WHERE o.tenant_id = NEW.tenant_id AND o.company_id = NEW.company_id AND o.period_id = per.id
          AND o.source_type = NEW.source_type AND o.idempotency_key = NEW.idempotency_key
          AND o.granted_by = NEW.created_by) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'PERIOD_LOCKED: period % is %; % dated % % ', per.name, per.status, NEW.source_type,
    NEW.entry_date, CASE WHEN d = 'override' THEN 'needs a period override by its poster' ELSE 'cannot post' END
    USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_entry_period_allows';
END
$$;
CREATE TRIGGER journal_entry_period_check BEFORE INSERT OR UPDATE OF status ON app.journal_entry
  FOR EACH ROW EXECUTE FUNCTION app.journal_entry_period_check();

CREATE FUNCTION app.bank_statement_line_period_check() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  per app.fiscal_period;
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW;
  END IF;
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  SELECT * INTO per FROM app.fiscal_period
   WHERE tenant_id = OLD.tenant_id AND company_id = OLD.company_id
     AND OLD.posted_on BETWEEN start_date AND end_date;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock_shared(app.period_lock_key(per.id));
  SELECT status INTO per.status FROM app.fiscal_period WHERE tenant_id = OLD.tenant_id AND id = per.id;
  IF per.status = 'hard_locked' THEN
    RAISE EXCEPTION 'PERIOD_LOCKED: statement line % dated % is in hard-locked period %; its reconciliation cannot change',
      OLD.id, OLD.posted_on, per.name
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_statement_line_period_open';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER bank_statement_line_period_check BEFORE UPDATE OF status ON app.bank_statement_line
  FOR EACH ROW EXECUTE FUNCTION app.bank_statement_line_period_check();

-- ---------------------------------------------------------------------------------------------
-- Guarded status changes (SECURITY DEFINER, owned by lf_migrator; FORCE RLS keeps them inside
-- the caller's tenant)

CREATE FUNCTION app.period_record_change(per app.fiscal_period, p_to text, p_actor uuid, p_reason text,
                                         p_request uuid) RETURNS void
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  INSERT INTO app.period_status_change (tenant_id, company_id, period_id, from_status, to_status,
                                        changed_by, reason, reopen_request_id)
  VALUES (per.tenant_id, per.company_id, per.id, per.status, p_to, p_actor, p_reason, p_request);
  UPDATE app.fiscal_period SET status = p_to, status_changed_at = clock_timestamp()
   WHERE tenant_id = per.tenant_id AND id = per.id;
  INSERT INTO audit.audit_log (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, before, after)
  VALUES (per.tenant_id, 'user', p_actor, 'period.status_changed', 'fiscal_period', per.id::text,
          jsonb_build_object('status', per.status),
          jsonb_build_object('status', p_to, 'reason', p_reason, 'reopen_request_id', p_request));
END
$$;
REVOKE ALL ON FUNCTION app.period_record_change(app.fiscal_period, text, uuid, text, uuid) FROM PUBLIC;

CREATE FUNCTION app.period_set_status(p_period uuid, p_status text, p_actor uuid, p_reason text)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  per app.fiscal_period;
  perm text;
  reason text := nullif(btrim(p_reason), '');
BEGIN
  PERFORM pg_advisory_xact_lock(app.period_lock_key(p_period));
  SELECT * INTO per FROM app.fiscal_period WHERE id = p_period;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown fiscal period %', p_period USING ERRCODE = 'no_data_found';
  END IF;
  IF app.period_status_rank(p_status) IS NULL THEN
    RAISE EXCEPTION 'unknown period status %', p_status USING ERRCODE = 'check_violation';
  END IF;
  IF per.status = p_status THEN
    RAISE EXCEPTION 'period % is already %', per.name, p_status USING ERRCODE = 'check_violation';
  END IF;
  IF per.status = 'hard_locked' THEN
    RAISE EXCEPTION 'period % is hard_locked: reopen it with a reopen request and a second approver', per.name
      USING ERRCODE = 'check_violation';
  END IF;
  IF app.period_status_rank(p_status) > app.period_status_rank(per.status) THEN
    perm := CASE WHEN p_status IN ('ar_locked', 'ap_locked') THEN 'period.lock' ELSE 'period.close' END;
  ELSE
    perm := 'period.reopen';
    IF reason IS NULL THEN
      RAISE EXCEPTION 'a reason is required to move period % back from % to %', per.name, per.status, p_status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT app.user_has_period_permission(per.tenant_id, p_actor, perm) THEN
    RAISE EXCEPTION 'user % does not hold % (period % % → %)', p_actor, perm, per.name, per.status, p_status
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM app.period_record_change(per, p_status, p_actor, reason, NULL);
END
$$;
REVOKE ALL ON FUNCTION app.period_set_status(uuid, text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.period_set_status(uuid, text, uuid, text) TO lf_app;

CREATE FUNCTION app.period_reopen_request(p_period uuid, p_to_status text, p_actor uuid, p_reason text)
  RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  per app.fiscal_period;
  rid uuid;
BEGIN
  SELECT * INTO per FROM app.fiscal_period WHERE id = p_period;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown fiscal period %', p_period USING ERRCODE = 'no_data_found';
  END IF;
  IF per.status <> 'hard_locked' THEN
    RAISE EXCEPTION 'period % is %, not hard_locked: use app.period_set_status', per.name, per.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF nullif(btrim(p_reason), '') IS NULL THEN
    RAISE EXCEPTION 'an audit reason is required to reopen a hard-locked period' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT app.user_has_period_permission(per.tenant_id, p_actor, 'period.reopen') THEN
    RAISE EXCEPTION 'user % does not hold period.reopen', p_actor USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO app.period_reopen_request (tenant_id, company_id, period_id, to_status, reason, requested_by)
  VALUES (per.tenant_id, per.company_id, per.id, p_to_status, btrim(p_reason), p_actor)
  RETURNING id INTO rid;
  INSERT INTO audit.audit_log (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, after)
  VALUES (per.tenant_id, 'user', p_actor, 'period.reopen_requested', 'period_reopen_request', rid::text,
          jsonb_build_object('period_id', per.id, 'to_status', p_to_status, 'reason', btrim(p_reason)));
  RETURN rid;
END
$$;
REVOKE ALL ON FUNCTION app.period_reopen_request(uuid, text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.period_reopen_request(uuid, text, uuid, text) TO lf_app;

CREATE FUNCTION app.period_reopen_approve(p_request uuid, p_actor uuid) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  req app.period_reopen_request;
  per app.fiscal_period;
BEGIN
  SELECT * INTO req FROM app.period_reopen_request WHERE id = p_request FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown reopen request %', p_request USING ERRCODE = 'no_data_found';
  END IF;
  IF req.status <> 'pending' THEN
    RAISE EXCEPTION 'reopen request % is not pending (status %)', p_request, req.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF req.requested_by = p_actor THEN
    RAISE EXCEPTION 'the second approver of reopen request % must be a different user', p_request
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT app.user_has_period_permission(req.tenant_id, p_actor, 'period.reopen') THEN
    RAISE EXCEPTION 'user % does not hold period.reopen', p_actor USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(app.period_lock_key(req.period_id));
  SELECT * INTO STRICT per FROM app.fiscal_period WHERE tenant_id = req.tenant_id AND id = req.period_id;
  IF per.status <> 'hard_locked' THEN
    RAISE EXCEPTION 'period % is no longer hard_locked (status %)', per.name, per.status
      USING ERRCODE = 'check_violation';
  END IF;
  UPDATE app.period_reopen_request SET status = 'approved', approved_by = p_actor, approved_at = clock_timestamp()
   WHERE tenant_id = req.tenant_id AND id = req.id;
  INSERT INTO audit.audit_log (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, after)
  VALUES (req.tenant_id, 'user', p_actor, 'period.reopen_approved', 'period_reopen_request', req.id::text,
          jsonb_build_object('period_id', per.id, 'to_status', req.to_status, 'requested_by', req.requested_by));
  PERFORM app.period_record_change(per, req.to_status, p_actor, req.reason, req.id);
END
$$;
REVOKE ALL ON FUNCTION app.period_reopen_approve(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.period_reopen_approve(uuid, uuid) TO lf_app;
