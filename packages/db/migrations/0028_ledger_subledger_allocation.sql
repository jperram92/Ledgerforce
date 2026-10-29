-- 0028 — ledger: AR/AP open items (subledger_entry) and allocations (T-0028, design §3.3,
-- RQ-0039, ADR-0035 Proposed). Owner: packages/ledger (the only writer).
--
-- * subledger_entry: one open item per journal line on an account bound to AR_CONTROL or
--   AP_CONTROL. The writer supplies company, entry, line number and (optionally) due date; a
--   BEFORE INSERT trigger fills everything else from the line: control role, account, party,
--   document (source type and id), document date, transaction currency, original and open
--   amount in the transaction currency, and base original and open amount. Amounts are signed
--   like the GL: debit +, credit − (an AR invoice or AP payment +, an AR receipt or AP bill −),
--   so the items of a control account sum to its debit-minus-credit balance.
--   open_amount stays between 0 and original_amount, on the original's side (CHECK).
-- * allocation: append-only. A row pairs a + item with a − item of the same control account,
--   party and currency, and moves both towards zero by `amount` (transaction currency). A
--   BEFORE INSERT trigger (SECURITY DEFINER) locks both items FOR UPDATE in id order, refuses
--   over-allocation and computes the base released from each item (in proportion,
--   round half-up to 4 decimals; the whole remainder when it closes the item) and
--   fx_difference = base released from the credit item − base released from the debit item,
--   i.e. the base-currency debit to the control account a realised FX journal would post. No FX
--   journal is posted (golden posting Draft, DL-0187). An AFTER INSERT trigger (SECURITY
--   DEFINER) applies the deltas to both items. A reversal is a new row with reversal_of_id, the
--   negated amount and the original's base releases and fx_difference negated; one per
--   allocation; a reversal is never reversed.
-- * lf_app has SELECT and INSERT only on both tables. Guards bind the owner too: an item may
--   change only its open amounts and only from the allocation trigger (pg_trigger_depth() > 1);
--   allocations never change; DELETE and TRUNCATE are refused.
-- * Triggers skip rows of another tenant (or with no tenant set), so RLS refuses them with
--   42501 (cross-tenant protocol), as account_balance does (0023).

CREATE TABLE app.subledger_entry (
  id                    uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id             uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                      REFERENCES app.tenant (id),
  company_id            uuid          NOT NULL,
  entry_id              uuid          NOT NULL,
  line_no               integer       NOT NULL CHECK (line_no > 0),
  control_role          text          NOT NULL CHECK (control_role IN ('AR_CONTROL', 'AP_CONTROL')),
  account_id            uuid          NOT NULL,
  party_id              uuid,
  source_type           text          NOT NULL,
  document_id           text,
  document_date         date          NOT NULL,
  due_date              date          NOT NULL,
  currency              char(3)       NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  original_amount       numeric(19,4) NOT NULL CHECK (original_amount <> 0),
  open_amount           numeric(19,4) NOT NULL,
  base_original_amount  numeric(19,4) NOT NULL CHECK (base_original_amount <> 0),
  base_open_amount      numeric(19,4) NOT NULL,
  created_at            timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT subledger_entry_same_side CHECK (sign(original_amount) = sign(base_original_amount)),
  CONSTRAINT subledger_entry_open_within CHECK (
    CASE WHEN original_amount > 0 THEN open_amount BETWEEN 0 AND original_amount
         ELSE open_amount BETWEEN original_amount AND 0 END),
  CONSTRAINT subledger_entry_base_open_within CHECK (
    CASE WHEN base_original_amount > 0 THEN base_open_amount BETWEEN 0 AND base_original_amount
         ELSE base_open_amount BETWEEN base_original_amount AND 0 END),
  UNIQUE (tenant_id, entry_id, line_no),
  UNIQUE (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, entry_id) REFERENCES app.journal_entry (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, account_id) REFERENCES app.account (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, party_id) REFERENCES app.party (tenant_id, company_id, id)
);
COMMENT ON TABLE app.subledger_entry IS
  'AR/AP open item per control-account journal line (design 3.3). Written by the posting engine; filled from the line by the database; open amounts change only through allocation.';
COMMENT ON COLUMN app.subledger_entry.original_amount IS 'Transaction currency, signed like the GL (debit +, credit -).';
COMMENT ON COLUMN app.subledger_entry.base_original_amount IS 'Base currency: the line''s debit - credit.';
CREATE INDEX subledger_entry_party_idx ON app.subledger_entry (tenant_id, company_id, control_role, party_id);
CREATE INDEX subledger_entry_account_idx ON app.subledger_entry (tenant_id, company_id, account_id);

ALTER TABLE app.subledger_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.subledger_entry FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.subledger_entry
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.subledger_entry TO lf_app;

CREATE TABLE app.allocation (
  id                uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id         uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                  REFERENCES app.tenant (id),
  company_id        uuid          NOT NULL,
  from_entry_id     uuid          NOT NULL,
  to_entry_id       uuid          NOT NULL,
  amount            numeric(19,4) NOT NULL CHECK (amount <> 0),
  currency          char(3)       NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  from_base_amount  numeric(19,4) NOT NULL,
  to_base_amount    numeric(19,4) NOT NULL,
  fx_difference     numeric(19,4) NOT NULL,
  allocation_date   date          NOT NULL,
  reversal_of_id    uuid,
  idempotency_key   text          NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  memo              text,
  created_by        uuid,
  created_at        timestamptz   NOT NULL DEFAULT now(),
  CHECK (from_entry_id <> to_entry_id),
  CHECK ((reversal_of_id IS NULL) = (amount > 0)),
  CHECK (sign(from_base_amount) * sign(amount) >= 0 AND sign(to_base_amount) * sign(amount) >= 0),
  CHECK (reversal_of_id IS DISTINCT FROM id),
  UNIQUE (tenant_id, company_id, idempotency_key),
  UNIQUE (tenant_id, reversal_of_id),
  UNIQUE (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, from_entry_id) REFERENCES app.subledger_entry (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, to_entry_id) REFERENCES app.subledger_entry (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, reversal_of_id) REFERENCES app.allocation (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.allocation IS
  'Receipt-to-invoice / payment-to-bill matching (design 3.3). Append-only; undone by a reversing allocation.';
COMMENT ON COLUMN app.allocation.fx_difference IS
  'Base released from the credit item - base released from the debit item: the base debit to the control account a realised FX journal would post (none is posted yet, DL-0187).';
CREATE INDEX allocation_from_idx ON app.allocation (tenant_id, from_entry_id);
CREATE INDEX allocation_to_idx ON app.allocation (tenant_id, to_entry_id);

ALTER TABLE app.allocation ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.allocation FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.allocation
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.allocation TO lf_app;

-- An open item is filled from its journal line (binds every role; skips other tenants).
CREATE FUNCTION app.subledger_entry_from_line() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  l record;
  r text;
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW; -- another tenant's row (or no tenant): RLS decides
  END IF;
  SELECT jl.account_id, jl.party_id, jl.txn_currency, jl.txn_amount, jl.debit, jl.credit,
         je.entry_date, je.source_type, je.source_id
    INTO l
    FROM app.journal_line jl
    JOIN app.journal_entry je ON je.tenant_id = jl.tenant_id AND je.id = jl.entry_id
   WHERE jl.tenant_id = NEW.tenant_id AND jl.company_id = NEW.company_id
     AND jl.entry_id = NEW.entry_id AND jl.line_no = NEW.line_no;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'open item: journal entry % has no line % in this company', NEW.entry_id, NEW.line_no
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT b.role INTO r FROM app.account_system_role b
   WHERE b.tenant_id = NEW.tenant_id AND b.company_id = NEW.company_id
     AND b.account_id = l.account_id AND b.role IN ('AR_CONTROL', 'AP_CONTROL')
   ORDER BY b.role LIMIT 1;
  IF r IS NULL THEN
    RAISE EXCEPTION 'open item: line % of entry % is not on an account bound to AR_CONTROL or AP_CONTROL',
      NEW.line_no, NEW.entry_id USING ERRCODE = 'check_violation';
  END IF;
  IF l.txn_amount = 0 THEN
    RAISE EXCEPTION 'open item: line % of entry % has no transaction amount', NEW.line_no, NEW.entry_id
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.control_role         := r;
  NEW.account_id           := l.account_id;
  NEW.party_id             := l.party_id;
  NEW.source_type          := l.source_type;
  NEW.document_id          := l.source_id;
  NEW.document_date        := l.entry_date;
  NEW.due_date             := coalesce(NEW.due_date, l.entry_date);
  NEW.currency             := l.txn_currency;
  NEW.original_amount      := CASE WHEN l.debit > 0 THEN l.txn_amount ELSE -l.txn_amount END;
  NEW.open_amount          := NEW.original_amount;
  NEW.base_original_amount := l.debit - l.credit;
  NEW.base_open_amount     := NEW.base_original_amount;
  NEW.created_at           := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER subledger_entry_from_line BEFORE INSERT ON app.subledger_entry
  FOR EACH ROW EXECUTE FUNCTION app.subledger_entry_from_line();

-- Items change only their open amounts, and only from the allocation trigger. No DELETE.
CREATE FUNCTION app.subledger_entry_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'open item % cannot be deleted', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF pg_trigger_depth() < 2
     OR (to_jsonb(NEW) - 'open_amount' - 'base_open_amount')
        IS DISTINCT FROM (to_jsonb(OLD) - 'open_amount' - 'base_open_amount')
  THEN
    RAISE EXCEPTION 'open item % is immutable; open amounts change only through an allocation', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER subledger_entry_guard BEFORE UPDATE OR DELETE ON app.subledger_entry
  FOR EACH ROW EXECUTE FUNCTION app.subledger_entry_guard();
CREATE TRIGGER subledger_entry_no_truncate BEFORE TRUNCATE ON app.subledger_entry
  FOR EACH STATEMENT EXECUTE FUNCTION app.ledger_no_truncate();

-- Lock, check and price an allocation (SECURITY DEFINER: lf_app cannot lock FOR UPDATE).
CREATE FUNCTION app.allocation_check() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  f app.subledger_entry;
  t app.subledger_entry;
  o app.allocation;
  rel_f numeric;
  rel_t numeric;
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM app.subledger_entry
    WHERE tenant_id = NEW.tenant_id AND id IN (NEW.from_entry_id, NEW.to_entry_id)
    ORDER BY id FOR UPDATE;
  SELECT * INTO f FROM app.subledger_entry
   WHERE tenant_id = NEW.tenant_id AND company_id = NEW.company_id AND id = NEW.from_entry_id;
  SELECT * INTO t FROM app.subledger_entry
   WHERE tenant_id = NEW.tenant_id AND company_id = NEW.company_id AND id = NEW.to_entry_id;
  IF f.id IS NULL OR t.id IS NULL THEN
    RAISE EXCEPTION 'allocation: unknown open item' USING ERRCODE = 'check_violation';
  END IF;
  IF f.account_id <> t.account_id OR f.currency <> t.currency
     OR f.party_id IS DISTINCT FROM t.party_id
     OR sign(f.original_amount) = sign(t.original_amount) THEN
    RAISE EXCEPTION 'allocation: open items % and % must share account, party and currency and lie on opposite sides',
      f.id, t.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.allocation_date < greatest(f.document_date, t.document_date) THEN
    RAISE EXCEPTION 'allocation: dated % before its documents', NEW.allocation_date
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.reversal_of_id IS NULL THEN
    IF NEW.amount > abs(f.open_amount) OR NEW.amount > abs(t.open_amount) THEN
      RAISE EXCEPTION 'allocation: % over-allocates (open % and %)', NEW.amount, f.open_amount, t.open_amount
        USING ERRCODE = 'check_violation';
    END IF;
    rel_f := CASE WHEN NEW.amount = abs(f.open_amount) THEN abs(f.base_open_amount)
                  ELSE round(abs(f.base_open_amount) * NEW.amount / abs(f.open_amount), 4) END;
    rel_t := CASE WHEN NEW.amount = abs(t.open_amount) THEN abs(t.base_open_amount)
                  ELSE round(abs(t.base_open_amount) * NEW.amount / abs(t.open_amount), 4) END;
  ELSE
    SELECT * INTO o FROM app.allocation
     WHERE tenant_id = NEW.tenant_id AND company_id = NEW.company_id AND id = NEW.reversal_of_id;
    IF o.id IS NULL OR o.reversal_of_id IS NOT NULL
       OR o.from_entry_id <> NEW.from_entry_id OR o.to_entry_id <> NEW.to_entry_id
       OR NEW.amount <> -o.amount OR NEW.allocation_date < o.allocation_date THEN
      RAISE EXCEPTION 'allocation: % is not a reversal of allocation %', NEW.id, NEW.reversal_of_id
        USING ERRCODE = 'check_violation';
    END IF;
    rel_f := -o.from_base_amount;
    rel_t := -o.to_base_amount;
  END IF;
  NEW.currency         := f.currency;
  NEW.from_base_amount := rel_f;
  NEW.to_base_amount   := rel_t;
  NEW.fx_difference    := CASE WHEN f.original_amount < 0 THEN rel_f - rel_t ELSE rel_t - rel_f END;
  NEW.created_at       := now();
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.allocation_check() FROM PUBLIC;
CREATE TRIGGER allocation_check BEFORE INSERT ON app.allocation
  FOR EACH ROW EXECUTE FUNCTION app.allocation_check();

-- Apply an allocation to both items (rows already locked by allocation_check).
CREATE FUNCTION app.allocation_apply() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NULL;
  END IF;
  UPDATE app.subledger_entry s
     SET open_amount = s.open_amount - sign(s.original_amount) * NEW.amount,
         base_open_amount = s.base_open_amount - sign(s.original_amount)
           * CASE WHEN s.id = NEW.from_entry_id THEN NEW.from_base_amount ELSE NEW.to_base_amount END
   WHERE s.tenant_id = NEW.tenant_id AND s.id IN (NEW.from_entry_id, NEW.to_entry_id);
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION app.allocation_apply() FROM PUBLIC;
CREATE TRIGGER allocation_apply AFTER INSERT ON app.allocation
  FOR EACH ROW EXECUTE FUNCTION app.allocation_apply();

-- Allocations never change (binds the owner too).
CREATE FUNCTION app.allocation_immutable() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'allocation % is immutable; undo it with a reversing allocation', OLD.id
    USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER allocation_immutable BEFORE UPDATE OR DELETE ON app.allocation
  FOR EACH ROW EXECUTE FUNCTION app.allocation_immutable();
CREATE TRIGGER allocation_no_truncate BEFORE TRUNCATE ON app.allocation
  FOR EACH STATEMENT EXECUTE FUNCTION app.ledger_no_truncate();
