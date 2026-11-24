-- 0086 (reserved 0085; built as 0084, renumbered at merge after T-0207 0084 and T-0231 0085; DL-0964) — Bills mailbox OAuth2 hardening (T-0243, security review r12 L1/L2, RQ-0190, ADR-0108,
-- DL-0962, DL-0963). Owner: packages/modules/ap (inbox-mailbox.ts, mailbox-oauth-connect.ts).
--
-- * PKCE verifier lifetime (L2): app.bill_inbox_oauth_request.code_verifier becomes nullable and a
--   new verifier_cleared_at records when it was cleared. The callback clears it in the statement
--   that consumes the request, a cancel clears it, and the tenant's inbox poll sweeps expired ones.
--   The guard trigger makes the verifier write-once-to-NULL for every role: an INSERT must carry a
--   verifier, an UPDATE may only clear it (never set another value) and only for a consumed or
--   expired request, and the two columns change together once. CHECK keeps them consistent.
--   No backfill here (FORCE RLS hides every row from the migrator): the first poll sweep of each
--   tenant clears the verifiers of requests consumed or expired before this migration.
-- * Rotation failure (L1): app.bill_inbox_mailbox.secret_rotation_failed_at is set when a rotated
--   refresh token could not be re-sealed after retries, and cleared by the next good rotation. The
--   last_error CHECK (0074) cannot be widened (the runner refuses DROP CONSTRAINT), so the state
--   has its own column. lf_app may UPDATE it; it is not a secret column, so the 0083 guard ignores it.
-- Forward-only and additive: DROP NOT NULL (allowed by the runner), new columns, a CHECK, a trigger,
-- grants.

ALTER TABLE app.bill_inbox_oauth_request ALTER COLUMN code_verifier DROP NOT NULL;
ALTER TABLE app.bill_inbox_oauth_request ADD COLUMN verifier_cleared_at timestamptz;
ALTER TABLE app.bill_inbox_oauth_request
  ADD CONSTRAINT bill_inbox_oauth_request_verifier_cleared_ck
    CHECK ((code_verifier IS NULL) = (verifier_cleared_at IS NOT NULL));
COMMENT ON COLUMN app.bill_inbox_oauth_request.code_verifier IS
  'PKCE verifier (RFC 7636); NULL once the request is consumed, cancelled or expired (T-0243, ADR-0108).';
COMMENT ON COLUMN app.bill_inbox_oauth_request.verifier_cleared_at IS
  'When the PKCE verifier was cleared; set exactly when code_verifier is NULL.';

CREATE FUNCTION app.bill_inbox_oauth_request_verifier_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.code_verifier IS NULL OR NEW.verifier_cleared_at IS NOT NULL THEN
      RAISE EXCEPTION 'a mailbox OAuth request is created with its PKCE verifier (ADR-0108)'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.code_verifier, NEW.verifier_cleared_at)
     IS DISTINCT FROM (OLD.code_verifier, OLD.verifier_cleared_at) THEN
    IF OLD.code_verifier IS NULL OR NEW.code_verifier IS NOT NULL THEN
      RAISE EXCEPTION 'the PKCE verifier can only be cleared, once (ADR-0108)'
        USING ERRCODE = 'P0001';
    END IF;
    IF NEW.consumed_at IS NULL AND OLD.expires_at > clock_timestamp() THEN
      RAISE EXCEPTION 'the PKCE verifier of a live request cannot be cleared (ADR-0108)'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bill_inbox_oauth_request_verifier_guard
  BEFORE INSERT OR UPDATE ON app.bill_inbox_oauth_request
  FOR EACH ROW EXECUTE FUNCTION app.bill_inbox_oauth_request_verifier_guard();

GRANT UPDATE (code_verifier, verifier_cleared_at) ON app.bill_inbox_oauth_request TO lf_app;

ALTER TABLE app.bill_inbox_mailbox ADD COLUMN secret_rotation_failed_at timestamptz;
COMMENT ON COLUMN app.bill_inbox_mailbox.secret_rotation_failed_at IS
  'Set when the poller could not re-seal a rotated OAuth refresh token after retries (operator must check the key service; the poll stops); cleared by the next good rotation (T-0243, ADR-0108).';
GRANT UPDATE (secret_rotation_failed_at) ON app.bill_inbox_mailbox TO lf_app;
