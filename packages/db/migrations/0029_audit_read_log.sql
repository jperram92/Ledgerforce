-- 0029 — audit log read path (T-0093, design §6.4 and §6.8, ADR-0034, RQ-0038). Owner: apps/api
-- audit (GET /audit-log).
--
-- * lf_app keeps INSERT only on audit.audit_log (migration 0003): no SELECT grant is added, so no
--   application code path can read the table directly.
-- * audit.read_log() is the only read: SECURITY DEFINER, owned by lf_migrator, STABLE (it cannot
--   write), search_path pinned, EXECUTE for lf_app only. It needs a tenant context, re-checks that
--   the acting user is active in that tenant and holds a role whose template includes
--   audit_log.read, filters tenant_id explicitly and also stays under FORCE RLS as the table
--   owner, and returns at most 100 rows per call, newest first, with keyset pages (id < before).
-- * app.role_allows_audit_read() mirrors catalogue.ts (owner, finance_admin, auditor);
--   audit-read.db.test.ts proves the two agree.

-- Mirrors the role templates of packages/shared/src/rbac/catalogue.ts that hold audit_log.read.
CREATE FUNCTION app.role_allows_audit_read(p_role text) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT p_role IN ('owner', 'finance_admin', 'auditor')
$$;
COMMENT ON FUNCTION app.role_allows_audit_read(text) IS
  'Roles whose template holds audit_log.read (design 6.4). Mirrors ROLE_TEMPLATES in catalogue.ts.';
GRANT EXECUTE ON FUNCTION app.role_allows_audit_read(text) TO lf_app;

CREATE FUNCTION audit.read_log(p_actor uuid, p_filter_actor uuid, p_action text,
                               p_entity_type text, p_entity_id text, p_from timestamptz,
                               p_to timestamptz, p_before bigint, p_limit integer)
  RETURNS TABLE (id bigint, occurred_at timestamptz, actor_type text, actor_user_id uuid,
                 action text, entity_type text, entity_id text, before jsonb, after jsonb,
                 ip text, user_agent text, request_id text, api_token_id uuid)
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'audit.read_log needs a tenant context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_actor IS NULL OR NOT EXISTS (
       SELECT 1 FROM app.user_role r
         JOIN app.app_user u ON u.tenant_id = r.tenant_id AND u.id = r.user_id
        WHERE r.tenant_id = v_tenant AND r.user_id = p_actor AND r.revoked_at IS NULL
          AND u.status = 'active' AND app.role_allows_audit_read(r.role)) THEN
    RAISE EXCEPTION 'user % may not read the audit log', p_actor USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'page size must be 1..100, got %', p_limit USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
    SELECT a.id, a.occurred_at, a.actor_type, a.actor_user_id, a.action, a.entity_type,
           a.entity_id, a.before, a.after, host(a.ip), a.user_agent, a.request_id, a.api_token_id
      FROM audit.audit_log a
     WHERE a.tenant_id = v_tenant
       AND (p_filter_actor IS NULL OR a.actor_user_id = p_filter_actor)
       AND (p_action IS NULL OR strpos(lower(a.action), lower(p_action)) > 0)
       AND (p_entity_type IS NULL OR a.entity_type = p_entity_type)
       AND (p_entity_id IS NULL OR a.entity_id = p_entity_id)
       AND (p_from IS NULL OR a.occurred_at >= p_from)
       AND (p_to IS NULL OR a.occurred_at < p_to)
       AND (p_before IS NULL OR a.id < p_before)
     ORDER BY a.id DESC
     LIMIT p_limit;
END
$$;
COMMENT ON FUNCTION audit.read_log(uuid, uuid, text, text, text, timestamptz, timestamptz, bigint, integer) IS
  'The only read path to audit.audit_log (ADR-0034): tenant + audit-reading role checked, max 100 rows, keyset pages.';
REVOKE ALL ON FUNCTION audit.read_log(uuid, uuid, text, text, text, timestamptz, timestamptz, bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit.read_log(uuid, uuid, text, text, text, timestamptz, timestamptz, bigint, integer) TO lf_app;
