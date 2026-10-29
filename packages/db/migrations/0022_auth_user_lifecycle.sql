-- 0022 — user lifecycle (joiner/mover/leaver) and scoped personal API tokens (T-0016, design
-- §6.2–6.3, ADR-0027, RQ-0031). Owner: apps/api auth/authz.
--
-- * Leaver: app.app_user gains disabled_at/disabled_by/disable_reason/successor_user_id (who
--   disabled, why, and who inherits their approvals) and invited_by (joiner). The status change
--   to 'disabled' fires app.app_user_offboard, which in the same statement revokes every open
--   session, every active API token and every active role grant, bumps session_epoch and writes
--   one audit row. Nothing is deleted (lf_app has no DELETE; directive 6). A disabled user never
--   becomes 'active' again directly (a re-invite goes through the joiner gate).
--   disabled_by and the reason are required by the API, not here, so an older code path that
--   only sets the status still revokes everything (fail safe).
-- * Approvals: app.approval_assignee(user) follows the successor chain to an active user. No
--   table assigns approvals to a named person yet (RQ-0031 F8, DL-0143); bills (T-0052) and
--   payment batches (T-0054) must route through it.
-- * Mover: nobody grants a role to themselves (all roles); no role is granted to a disabled user
--   (except by a superuser: test data, as in 0021).
-- * app.api_token: personal tokens. Only the SHA-256 of the 256-bit secret is stored; scopes are
--   known permissions that a token may carry (app.token_scope_allowed mirrors
--   TOKEN_FORBIDDEN_SCOPES); expiry mandatory, at most 366 days from the database clock; the only
--   changes are last_used_at (forward) and one revoke; never deleted. Tenant-owned: RLS ENABLE +
--   FORCE, tenant_isolation, lf_app SELECT/INSERT and UPDATE on the usage/revoke columns only.
-- * Triggers checking under RLS skip rows of another tenant, so RLS WITH CHECK refuses them (42501).

-- ---------------------------------------------------------------------------------------------
-- Data mirrors of TypeScript constants (packages/shared/src/rbac/catalogue.ts)

-- Mirrors ALL_PERMISSIONS. user-lifecycle.db.test.ts proves the lists agree.
CREATE FUNCTION app.permission_known(p text) RETURNS boolean
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
               'payroll.net_pay_batch.create', 'payroll.net_pay_batch.release')
$$;
COMMENT ON FUNCTION app.permission_known(text) IS
  'Permission ids (design 6.4). Mirrors ALL_PERMISSIONS in packages/shared/src/rbac/catalogue.ts.';
GRANT EXECUTE ON FUNCTION app.permission_known(text) TO lf_app;

-- Mirrors TOKEN_FORBIDDEN_SCOPES (= STEP_UP_PERMISSIONS + user/role/SoD/subscription admin).
CREATE FUNCTION app.token_scope_allowed(p text) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT app.permission_known(p)
     AND p NOT IN ('ap.payment_batch.release', 'payroll.net_pay_batch.release',
                   'parties.bank_account.change_request', 'parties.bank_account.verify',
                   'period.reopen', 'period.lock.override',
                   'users.manage', 'users.roles.assign', 'users.roles.assign_owner',
                   'settings.sod.manage', 'subscription.manage')
$$;
COMMENT ON FUNCTION app.token_scope_allowed(text) IS
  'Permissions an API token may carry (ADR-0027). Mirrors TOKEN_FORBIDDEN_SCOPES in catalogue.ts.';
GRANT EXECUTE ON FUNCTION app.token_scope_allowed(text) TO lf_app;

-- Every element allowed, no NULL, no duplicate. (Cardinality is checked by the table.)
CREATE FUNCTION app.token_scopes_valid(scopes text[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT coalesce(bool_and(coalesce(app.token_scope_allowed(s), false)), false)
         AND count(DISTINCT s) = count(*)
    FROM unnest(scopes) AS s
$$;
GRANT EXECUTE ON FUNCTION app.token_scopes_valid(text[]) TO lf_app;

-- ---------------------------------------------------------------------------------------------
-- Joiner / leaver columns on app.app_user

ALTER TABLE app.app_user ADD COLUMN invited_by uuid;
ALTER TABLE app.app_user ADD COLUMN disabled_at timestamptz;
ALTER TABLE app.app_user ADD COLUMN disabled_by uuid;
ALTER TABLE app.app_user ADD COLUMN disable_reason text
  CHECK (disable_reason IS NULL OR length(btrim(disable_reason)) BETWEEN 1 AND 500);
ALTER TABLE app.app_user ADD COLUMN successor_user_id uuid;
ALTER TABLE app.app_user
  ADD CONSTRAINT app_user_invited_by_fk FOREIGN KEY (tenant_id, invited_by)
  REFERENCES app.app_user (tenant_id, id);
ALTER TABLE app.app_user
  ADD CONSTRAINT app_user_disabled_by_fk FOREIGN KEY (tenant_id, disabled_by)
  REFERENCES app.app_user (tenant_id, id);
ALTER TABLE app.app_user
  ADD CONSTRAINT app_user_successor_fk FOREIGN KEY (tenant_id, successor_user_id)
  REFERENCES app.app_user (tenant_id, id);
ALTER TABLE app.app_user
  ADD CONSTRAINT app_user_not_disabled_by_self CHECK (disabled_by IS DISTINCT FROM id);
ALTER TABLE app.app_user
  ADD CONSTRAINT app_user_successor_not_self CHECK (successor_user_id IS DISTINCT FROM id);
COMMENT ON COLUMN app.app_user.invited_by IS 'Joiner: who invited the user (design 6.3). NULL = provisioning.';
COMMENT ON COLUMN app.app_user.disabled_at IS 'Leaver: when the user was disabled (database clock, ADR-0027).';
COMMENT ON COLUMN app.app_user.disabled_by IS 'Leaver: who disabled the user; never the user themself.';
COMMENT ON COLUMN app.app_user.disable_reason IS 'Leaver: why (required by the API).';
COMMENT ON COLUMN app.app_user.successor_user_id IS 'Leaver: an active user who inherits pending approvals (app.approval_assignee).';

-- Whether p_user is an active user of the current tenant (under the caller's RLS).
CREATE FUNCTION app.user_is_active(p_user uuid) RETURNS boolean
  LANGUAGE sql STABLE
AS $$
  SELECT EXISTS (SELECT 1 FROM app.app_user u WHERE u.id = p_user AND u.status = 'active')
$$;
GRANT EXECUTE ON FUNCTION app.user_is_active(uuid) TO lf_app;

-- The successor must be an active user of the tenant; an unknown id is left to the foreign key.
CREATE FUNCTION app.app_user_check_successor(p_tenant uuid, p_successor uuid) RETURNS void
  LANGUAGE plpgsql
AS $$
BEGIN
  IF p_successor IS NULL
     OR p_tenant IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM app.app_user u WHERE u.tenant_id = p_tenant AND u.id = p_successor)
     AND NOT app.user_is_active(p_successor) THEN
    RAISE EXCEPTION 'successor % is not an active user', p_successor USING ERRCODE = 'check_violation';
  END IF;
END
$$;

CREATE FUNCTION app.app_user_lifecycle_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'disabled' AND NEW.status = 'active' THEN
    RAISE EXCEPTION 'user % is disabled: re-invite instead of re-activating', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'disabled' AND NEW.status = 'disabled' THEN
    NEW.disabled_at := clock_timestamp();
    NEW.session_epoch := NEW.session_epoch + 1;
    PERFORM app.app_user_check_successor(NEW.tenant_id, NEW.successor_user_id);
    RETURN NEW;
  END IF;
  IF NEW.disabled_at IS DISTINCT FROM OLD.disabled_at
     OR NEW.disabled_by IS DISTINCT FROM OLD.disabled_by
     OR NEW.disable_reason IS DISTINCT FROM OLD.disable_reason
     OR NEW.invited_by IS DISTINCT FROM OLD.invited_by THEN
    RAISE EXCEPTION 'user %: who invited or disabled the user, and why, is history', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.successor_user_id IS DISTINCT FROM OLD.successor_user_id THEN
    IF NEW.status <> 'disabled' THEN
      RAISE EXCEPTION 'user %: only a disabled user has a successor', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    PERFORM app.app_user_check_successor(NEW.tenant_id, NEW.successor_user_id);
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER app_user_lifecycle_guard BEFORE UPDATE ON app.app_user
  FOR EACH ROW EXECUTE FUNCTION app.app_user_lifecycle_guard();

-- ---------------------------------------------------------------------------------------------
-- API tokens

CREATE TABLE app.api_token (
  id             uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id      uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                             REFERENCES app.tenant (id),
  user_id        uuid        NOT NULL,
  name           text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  scopes         text[]      NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 64
                                             AND app.token_scopes_valid(scopes)),
  secret_sha256  text        NOT NULL CHECK (secret_sha256 ~ '^[0-9a-f]{64}$'),
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at     timestamptz NOT NULL,
  last_used_at   timestamptz,
  revoked_at     timestamptz,
  revoked_by     uuid,
  revoke_reason  text        CHECK (revoke_reason IS NULL OR length(btrim(revoke_reason)) BETWEEN 1 AND 200),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '366 days'),
  CHECK (last_used_at IS NULL OR last_used_at >= created_at),
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL)),
  CHECK (revoked_by IS NULL OR revoked_at IS NOT NULL),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app.app_user (tenant_id, id),
  FOREIGN KEY (tenant_id, revoked_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.api_token IS
  'Personal API token (design 6.2, ADR-0027). Secret never stored, only its SHA-256. Never deleted: revoke.';
COMMENT ON COLUMN app.api_token.scopes IS
  'Permission ids; effective permissions = scopes ∩ the owner''s current role permissions (ADR-0027).';
CREATE INDEX api_token_user_idx ON app.api_token (tenant_id, user_id);

ALTER TABLE app.api_token ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.api_token FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.api_token
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.api_token TO lf_app;
GRANT UPDATE (last_used_at, revoked_at, revoked_by, revoke_reason) ON app.api_token TO lf_app;

CREATE FUNCTION app.api_token_insert_check() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT app.sod_is_superuser() THEN
    NEW.created_at := clock_timestamp();
  END IF;
  IF NEW.revoked_at IS NOT NULL OR NEW.revoked_by IS NOT NULL OR NEW.last_used_at IS NOT NULL THEN
    RAISE EXCEPTION 'an API token is inserted active and unused' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW;
  END IF;
  IF NOT app.user_is_active(NEW.user_id) THEN
    RAISE EXCEPTION 'API token owner % is not an active user', NEW.user_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER api_token_insert_check BEFORE INSERT ON app.api_token
  FOR EACH ROW EXECUTE FUNCTION app.api_token_insert_check();

-- Binds every role, the table owner too: usage moves forward, a revoke happens once, never deleted.
CREATE FUNCTION app.api_token_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'API tokens are never deleted (directive 6): revoke instead'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'API token % is revoked and kept as history', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - 'last_used_at' - 'revoked_at' - 'revoked_by' - 'revoke_reason')
     <> (to_jsonb(OLD) - 'last_used_at' - 'revoked_at' - 'revoked_by' - 'revoke_reason') THEN
    RAISE EXCEPTION 'API token %: only usage and the revoke can change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.last_used_at IS DISTINCT FROM OLD.last_used_at
     AND (NEW.last_used_at IS NULL OR NEW.last_used_at < OLD.last_used_at) THEN
    RAISE EXCEPTION 'API token %: last_used_at only moves forward', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER api_token_guard BEFORE UPDATE OR DELETE ON app.api_token
  FOR EACH ROW EXECUTE FUNCTION app.api_token_guard();

-- ---------------------------------------------------------------------------------------------
-- Leaver: revoke everything in the statement that disables the user

CREATE FUNCTION app.app_user_offboard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  n_sessions integer;
  n_tokens   integer;
  n_roles    integer;
BEGIN
  UPDATE app.session SET revoked_at = clock_timestamp(), revoke_reason = 'user_disabled'
   WHERE tenant_id = NEW.tenant_id AND user_id = NEW.id AND revoked_at IS NULL;
  GET DIAGNOSTICS n_sessions = ROW_COUNT;
  UPDATE app.api_token
     SET revoked_at = clock_timestamp(), revoked_by = NEW.disabled_by, revoke_reason = 'user_disabled'
   WHERE tenant_id = NEW.tenant_id AND user_id = NEW.id AND revoked_at IS NULL;
  GET DIAGNOSTICS n_tokens = ROW_COUNT;
  UPDATE app.user_role
     SET revoked_at = clock_timestamp(), revoked_by = NEW.disabled_by, revoke_reason = 'leaver'
   WHERE tenant_id = NEW.tenant_id AND user_id = NEW.id AND revoked_at IS NULL;
  GET DIAGNOSTICS n_roles = ROW_COUNT;
  INSERT INTO audit.audit_log (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, after)
  VALUES (NEW.tenant_id, CASE WHEN NEW.disabled_by IS NULL THEN 'system' ELSE 'user' END,
          NEW.disabled_by, 'user.disabled', 'app_user', NEW.id::text,
          jsonb_build_object('reason', NEW.disable_reason, 'successor_user_id', NEW.successor_user_id,
                             'sessions_revoked', n_sessions, 'tokens_revoked', n_tokens,
                             'roles_revoked', n_roles));
  RETURN NULL;
END
$$;
CREATE TRIGGER app_user_offboard AFTER UPDATE OF status ON app.app_user
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM 'disabled' AND NEW.status = 'disabled')
  EXECUTE FUNCTION app.app_user_offboard();

-- ---------------------------------------------------------------------------------------------
-- Pending approvals: who acts for a user (follows successors of disabled users)

CREATE FUNCTION app.approval_assignee(p_user uuid) RETURNS uuid
  LANGUAGE sql STABLE
AS $$
  WITH RECURSIVE chain (id, status, successor, depth) AS (
    SELECT u.id, u.status, u.successor_user_id, 0 FROM app.app_user u WHERE u.id = p_user
    UNION ALL
    SELECT u.id, u.status, u.successor_user_id, c.depth + 1
      FROM chain c JOIN app.app_user u ON u.id = c.successor
     WHERE c.status <> 'active' AND c.depth < 32
  )
  SELECT id FROM chain WHERE status = 'active' ORDER BY depth LIMIT 1
$$;
COMMENT ON FUNCTION app.approval_assignee(uuid) IS
  'The active user who acts on approvals assigned to p_user: p_user, or the successor chain of a disabled user; NULL if none (ADR-0027).';
GRANT EXECUTE ON FUNCTION app.approval_assignee(uuid) TO lf_app;

-- ---------------------------------------------------------------------------------------------
-- Mover: no self-grant; no grant to a disabled user

CREATE FUNCTION app.user_role_grant_check() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.granted_by IS NOT NULL AND NEW.granted_by = NEW.user_id THEN
    RAISE EXCEPTION 'user % cannot grant a role to themselves', NEW.user_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW;
  END IF;
  IF NOT app.sod_is_superuser() AND EXISTS (
       SELECT 1 FROM app.app_user u
        WHERE u.tenant_id = NEW.tenant_id AND u.id = NEW.user_id AND u.status = 'disabled') THEN
    RAISE EXCEPTION 'user % is disabled: no role can be granted', NEW.user_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER user_role_grant_check BEFORE INSERT ON app.user_role
  FOR EACH ROW EXECUTE FUNCTION app.user_role_grant_check();

-- ---------------------------------------------------------------------------------------------
-- Audit attribution: a request made with an API token names the token (its owner stays the actor)

ALTER TABLE audit.audit_log ADD COLUMN api_token_id uuid;
COMMENT ON COLUMN audit.audit_log.api_token_id IS
  'The API token the request was made with (ADR-0027); NULL for sessions and the database itself.';
