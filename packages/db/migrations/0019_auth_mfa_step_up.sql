-- 0019 — MFA enforcement and step-up re-authentication (ADR-0025, T-0013, design §6.2, RQ-0027).
-- Owner: apps/api auth.
--
-- app.session.auth_time: when the user last actively authenticated at the IdP, taken from the
-- validated ID token's auth_time claim at login and refreshed by a step-up. NULL when the IdP did
-- not assert one, and for sessions created before this migration: a NULL never satisfies a
-- step-up check (fail closed), so those users step up once.
--
-- app.auth_request gains the step-up link. A row with session_id is a step-up of that session
-- (same tenant, composite FK), not a login: the callback updates the session instead of creating
-- one. max_age_seconds is the max_age sent to the IdP and checked on the returned auth_time;
-- return_to is a same-origin path to land on afterwards. Additive only: existing rows are logins.
-- Grants are unchanged: lf_app keeps SELECT, INSERT and UPDATE (consumed_at) on auth_request, and
-- SELECT, INSERT, UPDATE on session, so the new columns are covered.

ALTER TABLE app.session ADD COLUMN auth_time timestamptz;
COMMENT ON COLUMN app.session.auth_time IS 'Last active authentication at the IdP (ID token auth_time; login or step-up). NULL = unknown, never fresh (ADR-0025).';

-- Target of the composite FK below (id alone is already unique).
CREATE UNIQUE INDEX session_tenant_id_uq ON app.session (tenant_id, id);

ALTER TABLE app.auth_request ADD COLUMN session_id uuid;
ALTER TABLE app.auth_request ADD COLUMN max_age_seconds integer;
ALTER TABLE app.auth_request ADD COLUMN return_to text;
ALTER TABLE app.auth_request
  ADD CONSTRAINT auth_request_session_fk
  FOREIGN KEY (tenant_id, session_id) REFERENCES app.session (tenant_id, id);
ALTER TABLE app.auth_request
  ADD CONSTRAINT auth_request_step_up_shape CHECK (
    (session_id IS NULL AND max_age_seconds IS NULL AND return_to IS NULL)
    OR (session_id IS NOT NULL AND max_age_seconds BETWEEN 1 AND 3600 AND return_to IS NOT NULL)
  );
ALTER TABLE app.auth_request
  ADD CONSTRAINT auth_request_return_to_path CHECK (
    return_to IS NULL
    OR (return_to ~ '^/' AND return_to !~ '^//' AND return_to !~ '\\' AND length(return_to) <= 512)
  );
COMMENT ON COLUMN app.auth_request.session_id IS 'Set for a step-up: the session it re-authenticates (ADR-0025). NULL for a login.';
COMMENT ON COLUMN app.auth_request.max_age_seconds IS 'Step-up only: max_age sent to the IdP and checked on auth_time.';
COMMENT ON COLUMN app.auth_request.return_to IS 'Step-up only: same-origin path to redirect to afterwards.';
