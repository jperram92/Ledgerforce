-- 0010 — ledger: gapless document number series (T-0024, design §3.4, RQ-0007 (d)).
-- Owner: packages/ledger.
--
-- * app.number_series: one counter row per company and series code (invoice, credit_note,
--   bill, journal …). Never a database sequence: sequences leave gaps on rollback, and tax
--   invoices need clean series (design §3.4).
-- * app.next_document_number(company, series) runs UPDATE … SET next_value = next_value + 1
--   RETURNING inside the caller's transaction. The row lock serialises concurrent writers
--   in one series. A rollback, including a failure at commit such as the deferred balance
--   check, undoes the increment, so committed documents carry consecutive numbers.
-- * Guards: next_value only ever moves forward by exactly 1 (no reset, no skip); code and
--   company never change; prefix and pad_width are fixed once a number has been issued. The
--   formatter pads to pad_width but never truncates a wider value (lpad would).
-- * lf_app: SELECT, INSERT, UPDATE (the counter is updated in the posting transaction).
--   Nothing is deleted; status 'archived' retires a series.

CREATE TABLE app.number_series (
  tenant_id    uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                           REFERENCES app.tenant (id),
  company_id   uuid        NOT NULL,
  code         text        NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{0,39}$'),
  prefix       text        NOT NULL DEFAULT '' CHECK (prefix !~ '[[:cntrl:]]' AND length(prefix) <= 20),
  pad_width    smallint    NOT NULL DEFAULT 6 CHECK (pad_width BETWEEN 1 AND 18),
  next_value   bigint      NOT NULL DEFAULT 1 CHECK (next_value >= 1),
  status       text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, company_id, code),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id)
);
COMMENT ON TABLE app.number_series IS
  'Gapless per-company document counters (design 3.4). Advanced only by app.next_document_number().';

ALTER TABLE app.number_series ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.number_series FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.number_series
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.number_series TO lf_app;

CREATE FUNCTION app.number_series_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  -- tenant_id moves are refused by RLS WITH CHECK (42501), like every tenant table.
  IF NEW.code <> OLD.code OR NEW.company_id <> OLD.company_id THEN
    RAISE EXCEPTION 'number series %: code and company cannot change', OLD.code
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.next_value <> OLD.next_value AND NEW.next_value <> OLD.next_value + 1 THEN
    RAISE EXCEPTION 'number series %: next_value may only advance by 1 (from % to %)',
      OLD.code, OLD.next_value, NEW.next_value USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.next_value > 1 AND (NEW.prefix <> OLD.prefix OR NEW.pad_width <> OLD.pad_width) THEN
    RAISE EXCEPTION 'number series %: prefix and pad_width are fixed once a number was issued', OLD.code
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER number_series_guard BEFORE UPDATE ON app.number_series
  FOR EACH ROW EXECUTE FUNCTION app.number_series_guard();

CREATE FUNCTION app.next_document_number(p_company uuid, p_series text) RETURNS text
  LANGUAGE plpgsql
AS $$
DECLARE
  n bigint;
  pre text;
  width smallint;
BEGIN
  UPDATE app.number_series
     SET next_value = next_value + 1
   WHERE company_id = p_company AND code = p_series AND status = 'active'
  RETURNING next_value - 1, prefix, pad_width INTO n, pre, width;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no active number series % for company %', p_series, p_company
      USING ERRCODE = 'no_data_found';
  END IF;
  -- lpad truncates a longer string, so pad only when shorter.
  RETURN pre || CASE WHEN length(n::text) >= width THEN n::text ELSE lpad(n::text, width, '0') END;
END
$$;
GRANT EXECUTE ON FUNCTION app.next_document_number(uuid, text) TO lf_app;
