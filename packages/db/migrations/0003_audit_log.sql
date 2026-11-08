-- 0003 — append-only audit log (design §6.8).
-- Two independent locks: lf_app holds INSERT only (privilege), and statement-level triggers
-- reject UPDATE/DELETE/TRUNCATE for everyone, including the owner. lf_app cannot disable
-- triggers (it is not the owner and not superuser) or set session_replication_role.

CREATE TABLE audit.audit_log (
  id             bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id      uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                             REFERENCES app.tenant (id),
  occurred_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_type     text        NOT NULL CHECK (actor_type IN ('user', 'system', 'integration', 'agent')),
  actor_user_id  uuid,
  action         text        NOT NULL CHECK (length(action) > 0),
  entity_type    text        NOT NULL,
  entity_id      text,
  before         jsonb,
  after          jsonb,
  ip             inet,
  user_agent     text,
  request_id     text
);
COMMENT ON TABLE audit.audit_log IS 'Append-only audit trail: actor, action, entity, before/after, IP, UA, request id (design 6.8).';
CREATE INDEX audit_log_tenant_time_idx ON audit.audit_log (tenant_id, occurred_at);
CREATE INDEX audit_log_entity_idx ON audit.audit_log (tenant_id, entity_type, entity_id);

ALTER TABLE audit.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit.audit_log
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT INSERT ON audit.audit_log TO lf_app;

CREATE FUNCTION audit.reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit.audit_log is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'raise_exception', HINT = 'Audit records are never changed (design 6.8).';
END
$$;

CREATE TRIGGER audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON audit.audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit.reject_mutation();

CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit.audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit.reject_mutation();
