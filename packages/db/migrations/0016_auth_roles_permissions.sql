-- 0016 — role assignments (T-0012, design §6.4, ADR-0023). Owner: apps/api authz.
--
-- * The ten role templates and their permissions are an immutable code constant
--   (packages/shared/src/rbac/catalogue.ts). The database knows only the role ids, through the
--   IMMUTABLE function app.role_template_exists, so no table without tenant_id is added (same
--   pattern as app.system_role_allows in 0005). apps/api permissions.db.test.ts proves the two
--   lists agree.
-- * app.user_role: one row per grant. A grant is never deleted or edited; it is revoked by
--   setting revoked_at/revoked_by/revoke_reason once (directive 6). At most one active grant per
--   user and role.
-- * Every grant or revoke bumps app.app_user.session_epoch in the same transaction, which
--   revokes all of the user's sessions (design §6.2, ADR-0016). It is a trigger so no writer can
--   forget it.

CREATE FUNCTION app.role_template_exists(role text) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT role IN ('owner', 'finance_admin', 'accountant', 'ar_clerk', 'ap_clerk', 'approver',
                  'payroll_officer', 'auditor', 'sales_user', 'integration')
$$;
COMMENT ON FUNCTION app.role_template_exists(text) IS
  'The ten role templates of design 6.4. Mirrors ROLE_IDS in packages/shared/src/rbac/catalogue.ts.';
GRANT EXECUTE ON FUNCTION app.role_template_exists(text) TO lf_app;

CREATE TABLE app.user_role (
  id             uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id      uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                             REFERENCES app.tenant (id),
  user_id        uuid        NOT NULL,
  role           text        NOT NULL CHECK (app.role_template_exists(role)),
  granted_at     timestamptz NOT NULL DEFAULT now(),
  granted_by     uuid,
  revoked_at     timestamptz,
  revoked_by     uuid,
  revoke_reason  text,
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL)),
  CHECK (revoked_by IS NULL OR revoked_at IS NOT NULL),
  CHECK (revoked_at IS NULL OR revoked_at >= granted_at),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app.app_user (tenant_id, id),
  FOREIGN KEY (tenant_id, granted_by) REFERENCES app.app_user (tenant_id, id),
  FOREIGN KEY (tenant_id, revoked_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.user_role IS
  'Role grants (design 6.4, ADR-0023). Never deleted: revoke by setting revoked_at. granted_by NULL = provisioning.';
CREATE UNIQUE INDEX user_role_active_uq ON app.user_role (tenant_id, user_id, role)
  WHERE revoked_at IS NULL;
CREATE INDEX user_role_user_idx ON app.user_role (tenant_id, user_id);

ALTER TABLE app.user_role ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.user_role FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.user_role
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.user_role TO lf_app;
GRANT UPDATE (revoked_at, revoked_by, revoke_reason) ON app.user_role TO lf_app;

-- A grant is inserted active; the only change ever allowed is revoking an active grant once.
CREATE FUNCTION app.user_role_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.revoked_at IS NOT NULL OR NEW.revoked_by IS NOT NULL THEN
      RAISE EXCEPTION 'role grant must be inserted active; revoke it afterwards'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'role grant % (%) is revoked and kept as history: it cannot change', OLD.id, OLD.role
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'role grant % (%): the only allowed change is a revoke', OLD.id, OLD.role
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.user_id <> OLD.user_id
     OR NEW.role <> OLD.role OR NEW.granted_at <> OLD.granted_at
     OR NEW.granted_by IS DISTINCT FROM OLD.granted_by THEN
    RAISE EXCEPTION 'role grant %: only the revoke columns can change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER user_role_guard BEFORE INSERT OR UPDATE ON app.user_role
  FOR EACH ROW EXECUTE FUNCTION app.user_role_guard();

-- Revoke-all on role change (design 6.2, ADR-0016): same transaction, same tenant (RLS applies).
CREATE FUNCTION app.user_role_revoke_sessions() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE app.app_user SET session_epoch = session_epoch + 1
   WHERE tenant_id = NEW.tenant_id AND id = NEW.user_id;
  RETURN NULL;
END
$$;
CREATE TRIGGER user_role_revoke_sessions AFTER INSERT OR UPDATE ON app.user_role
  FOR EACH ROW EXECUTE FUNCTION app.user_role_revoke_sessions();
