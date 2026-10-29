-- 0001 — platform schemas and shared helpers (design §6.7, §6.8).
-- Runs as lf_migrator (see packages/db/bootstrap). Forward-only: never edit after merge.

CREATE SCHEMA app;
CREATE SCHEMA audit;

REVOKE ALL ON SCHEMA app FROM PUBLIC;
REVOKE ALL ON SCHEMA audit FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO lf_app;
GRANT USAGE ON SCHEMA audit TO lf_app;

COMMENT ON SCHEMA app IS 'LedgerForce application data. Every tenant-owned table has tenant_id + RLS ENABLE/FORCE.';
COMMENT ON SCHEMA audit IS 'Append-only audit trail (design 6.8). lf_app may INSERT only.';

-- UUID version 7 (RFC 9562): 48-bit Unix-ms timestamp prefix + random bits, so primary keys are
-- time-ordered (index-friendly). PostgreSQL 18 ships uuidv7(); this keeps 16/17 compatible.
CREATE FUNCTION app.uuid_generate_v7() RETURNS uuid
LANGUAGE plpgsql VOLATILE PARALLEL SAFE AS $$
DECLARE
  ts_ms bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  b bytea := uuid_send(gen_random_uuid());  -- 16 random bytes with RFC variant bits already set
BEGIN
  b := overlay(b PLACING substring(int8send(ts_ms) FROM 3) FROM 1 FOR 6);
  b := set_byte(b, 6, (get_byte(b, 6) & 15) | 112);  -- version nibble = 7
  RETURN encode(b, 'hex')::uuid;
END
$$;

COMMENT ON FUNCTION app.uuid_generate_v7() IS 'RFC 9562 UUIDv7 generator (PostgreSQL 16/17 compatible).';
GRANT EXECUTE ON FUNCTION app.uuid_generate_v7() TO lf_app;
