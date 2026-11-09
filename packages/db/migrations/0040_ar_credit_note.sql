-- 0040 — ar: customer credit notes draft → approved → posted, the per-line posting snapshot of
-- sales invoices, and the company BAS frequency (T-0045, design §3.8 row 4, §4.1 step 3, §6.4,
-- UC-11; RQ-0114; ADR-0044 R5/W6; golden posting GP-005). Owner: packages/modules/ar.
--
-- * app.company.bas_frequency: monthly | quarterly (default) | annual (design §4.1 step 3). A
--   posted credit note records whether it falls in a later BAS period than its invoice
--   (app.bas_period_start; mirrors basPeriodOf in credit-note-journal.ts).
-- * app.sales_invoice_line_posting: how each invoice line posted — revenue account, tax-code
--   version, net and tax. Written by the invoice post (same savepoint, invoice still approved);
--   insert-only; must match a line of the invoice's ar_invoice journal entry. It is what a credit
--   note inherits: ADR-0044 R5/W6 "a credit note never re-resolves: each of its lines takes the
--   tax code of the line it adjusts".
-- * app.credit_note: the document against one posted invoice (same party, currency and price
--   mode; date not before the invoice). Its journal is written only by the posting engine
--   (source type ar_credit_note, source_id = the credit note id, key ar_credit_note:<id>).
--   Approval facts frozen once approved; posted rows never change.
-- * app.credit_note_line: the W6 link invoice_line_id → the invoice line it adjusts, with the
--   account and tax-code version copied from that line's posting snapshot (checked here). Lines
--   change only in draft; net/tax are filled at approval and must sum to the header totals.
-- * SoD (design §6.4 AR Clerk, rule SOD_CREDIT_NOTE_SELF_APPROVAL): the creator may not approve a
--   credit note above the tenant's credit_note_self_approval_threshold unless small-team mode is
--   on (the module also requires the exception; ADR-0026). Checked by the module and here.
-- * DELETE is never granted (directive 6). Triggers skip rows of another tenant, so RLS WITH
--   CHECK refuses them with 42501.

ALTER TABLE app.company
  ADD COLUMN bas_frequency text NOT NULL DEFAULT 'quarterly'
    CONSTRAINT company_bas_frequency_check CHECK (bas_frequency IN ('monthly', 'quarterly', 'annual'));
COMMENT ON COLUMN app.company.bas_frequency IS
  'BAS reporting frequency (design 4.1 step 3): monthly, quarterly (calendar quarters) or annual (AU financial year).';

CREATE FUNCTION app.bas_period_start(d date, frequency text) RETURNS date
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT CASE frequency
    WHEN 'monthly' THEN date_trunc('month', d)::date
    WHEN 'quarterly' THEN date_trunc('quarter', d)::date
    WHEN 'annual' THEN (date_trunc('year', d - interval '6 months') + interval '6 months')::date
  END
$$;
COMMENT ON FUNCTION app.bas_period_start(date, text) IS
  'First day of the BAS period containing d (RQ-0114 finding 4). Mirrors basPeriodOf (packages/modules/ar).';
GRANT EXECUTE ON FUNCTION app.bas_period_start(date, text) TO lf_app;

-- Invoice line posting snapshot ------------------------------------------------------------------

-- Additive key so a snapshot row's invoice line provably belongs to its invoice and company.
ALTER TABLE app.sales_invoice_line
  ADD CONSTRAINT sales_invoice_line_invoice_member_uq UNIQUE (tenant_id, company_id, invoice_id, id);

CREATE TABLE app.sales_invoice_line_posting (
  id               uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id        uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                 REFERENCES app.tenant (id),
  company_id       uuid          NOT NULL,
  invoice_id       uuid          NOT NULL,
  invoice_line_id  uuid          NOT NULL,
  account_id       uuid          NOT NULL,
  tax_code_id      uuid          NOT NULL,
  net_amount       numeric(19,4) NOT NULL CHECK (net_amount >= 0),
  tax_amount       numeric(19,4) NOT NULL CHECK (tax_amount >= 0),
  created_at       timestamptz   NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, invoice_line_id),
  UNIQUE (tenant_id, company_id, invoice_line_id),
  FOREIGN KEY (tenant_id, company_id, invoice_id) REFERENCES app.sales_invoice (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, invoice_id, invoice_line_id)
    REFERENCES app.sales_invoice_line (tenant_id, company_id, invoice_id, id),
  FOREIGN KEY (tenant_id, company_id, account_id) REFERENCES app.account (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, tax_code_id) REFERENCES app.tax_code (tenant_id, company_id, id)
);
COMMENT ON TABLE app.sales_invoice_line_posting IS
  'How each sales invoice line posted (account, tax-code version, net, tax); credit notes inherit it (ADR-0044 W6). Insert-only.';

ALTER TABLE app.sales_invoice_line_posting ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.sales_invoice_line_posting FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.sales_invoice_line_posting
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.sales_invoice_line_posting TO lf_app;
CREATE TRIGGER sales_invoice_line_posting_immutable BEFORE UPDATE OR DELETE ON app.sales_invoice_line_posting
  FOR EACH ROW EXECUTE FUNCTION app.sod_never_changed();

CREATE FUNCTION app.sales_invoice_line_posting_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  st text;
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW;
  END IF;
  IF NOT app.sod_is_superuser() THEN
    NEW.created_at := clock_timestamp();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.sales_invoice_line l
                  WHERE l.id = NEW.invoice_line_id AND l.tenant_id = NEW.tenant_id
                    AND l.company_id = NEW.company_id AND l.invoice_id = NEW.invoice_id) THEN
    RAISE EXCEPTION 'invoice line % is not a line of sales invoice %', NEW.invoice_line_id, NEW.invoice_id
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT i.status INTO st FROM app.sales_invoice i
   WHERE i.tenant_id = NEW.tenant_id AND i.company_id = NEW.company_id AND i.id = NEW.invoice_id;
  IF st IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'sales invoice %: line postings are recorded only while it posts (status %)',
      NEW.invoice_id, coalesce(st, 'missing') USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM app.journal_entry je
         JOIN app.journal_line jl ON jl.tenant_id = je.tenant_id AND jl.entry_id = je.id
        WHERE je.tenant_id = NEW.tenant_id AND je.company_id = NEW.company_id
          AND je.source_type = 'ar_invoice' AND je.source_id = NEW.invoice_id::text
          AND je.status = 'posted'
          AND jl.account_id = NEW.account_id AND jl.tax_code_id = NEW.tax_code_id) THEN
    RAISE EXCEPTION 'sales invoice %: no posted journal line on account % with tax code % matches line %',
      NEW.invoice_id, NEW.account_id, NEW.tax_code_id, NEW.invoice_line_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER sales_invoice_line_posting_guard BEFORE INSERT ON app.sales_invoice_line_posting
  FOR EACH ROW EXECUTE FUNCTION app.sales_invoice_line_posting_guard();

-- Credit notes ---------------------------------------------------------------------------------

CREATE TABLE app.credit_note (
  id                uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id         uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                  REFERENCES app.tenant (id),
  company_id        uuid          NOT NULL,
  party_id          uuid          NOT NULL,
  invoice_id        uuid          NOT NULL,
  status            text          NOT NULL DEFAULT 'draft'
                                  CHECK (status IN ('draft', 'approved', 'posted')),
  credit_note_no    text          CHECK (credit_note_no IS NULL OR length(credit_note_no) BETWEEN 1 AND 60),
  credit_note_date  date          NOT NULL,
  amounts_are       text          NOT NULL CHECK (amounts_are IN ('exclusive', 'inclusive')),
  currency          char(3)       NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  reason            text          NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  memo              text          CHECK (memo IS NULL OR length(memo) <= 2000),
  idempotency_key   text          NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  created_by        uuid,
  created_at        timestamptz   NOT NULL DEFAULT clock_timestamp(),
  approved_by       uuid,
  approved_at       timestamptz,
  net_total         numeric(19,4) CHECK (net_total IS NULL OR net_total >= 0),
  tax_total         numeric(19,4) CHECK (tax_total IS NULL OR tax_total >= 0),
  total             numeric(19,4) CHECK (total IS NULL OR total > 0),
  posted_by         uuid,
  posted_at         timestamptz,
  journal_entry_id  uuid,
  later_bas_period  boolean,
  CONSTRAINT credit_note_approval_facts CHECK (
    (status = 'draft') = (approved_by IS NULL)
    AND (approved_by IS NULL) = (approved_at IS NULL)
    AND (approved_by IS NULL) = (total IS NULL)
    AND (total IS NULL) = (net_total IS NULL) AND (total IS NULL) = (tax_total IS NULL)),
  CONSTRAINT credit_note_posting_facts CHECK (
    (status = 'posted') = (journal_entry_id IS NOT NULL)
    AND (journal_entry_id IS NULL) = (posted_at IS NULL)
    AND (journal_entry_id IS NULL) = (credit_note_no IS NULL)
    AND (journal_entry_id IS NULL) = (later_bas_period IS NULL)
    AND (journal_entry_id IS NOT NULL OR posted_by IS NULL)),
  UNIQUE (tenant_id, company_id, id),
  UNIQUE (tenant_id, company_id, idempotency_key),
  UNIQUE (tenant_id, company_id, credit_note_no),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, party_id) REFERENCES app.party (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, invoice_id) REFERENCES app.sales_invoice (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, journal_entry_id) REFERENCES app.journal_entry (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES app.app_user (tenant_id, id),
  FOREIGN KEY (tenant_id, posted_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.credit_note IS
  'Customer credit notes (design 3.8 row 4, UC-11), issued as adjustment notes. Posted only through the posting engine (ar_credit_note); posted rows never change.';
COMMENT ON COLUMN app.credit_note.credit_note_no IS
  'Document number from series ar_credit_note, taken inside the posting transaction (design 3.4).';
COMMENT ON COLUMN app.credit_note.later_bas_period IS
  'Set at posting: true when the credit note falls in a later BAS period than its invoice (Div 19 decreasing adjustment, 1B; RQ-0095 Q4).';
CREATE INDEX credit_note_invoice_idx ON app.credit_note (tenant_id, company_id, invoice_id);
CREATE INDEX credit_note_status_idx ON app.credit_note (tenant_id, company_id, status, credit_note_date);
CREATE UNIQUE INDEX credit_note_entry_uq ON app.credit_note (tenant_id, journal_entry_id)
  WHERE journal_entry_id IS NOT NULL;

ALTER TABLE app.credit_note ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.credit_note FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.credit_note
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.credit_note TO lf_app;

CREATE TABLE app.credit_note_line (
  id               uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id        uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                 REFERENCES app.tenant (id),
  company_id       uuid          NOT NULL,
  credit_note_id   uuid          NOT NULL,
  line_no          integer       NOT NULL CHECK (line_no BETWEEN 1 AND 10000),
  invoice_line_id  uuid          NOT NULL,
  description      text          CHECK (description IS NULL OR length(description) <= 2000),
  amount           numeric(19,4) NOT NULL CHECK (amount > 0),
  account_id       uuid          NOT NULL,
  tax_code_id      uuid          NOT NULL,
  net_amount       numeric(19,4) CHECK (net_amount IS NULL OR net_amount >= 0),
  tax_amount       numeric(19,4) CHECK (tax_amount IS NULL OR tax_amount >= 0),
  CHECK ((net_amount IS NULL) = (tax_amount IS NULL)),
  UNIQUE (tenant_id, credit_note_id, line_no),
  FOREIGN KEY (tenant_id, company_id, credit_note_id) REFERENCES app.credit_note (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, invoice_line_id)
    REFERENCES app.sales_invoice_line_posting (tenant_id, company_id, invoice_line_id),
  FOREIGN KEY (tenant_id, company_id, account_id) REFERENCES app.account (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, tax_code_id) REFERENCES app.tax_code (tenant_id, company_id, id)
);
COMMENT ON TABLE app.credit_note_line IS
  'Credit-note lines; invoice_line_id is the sales invoice line adjusted (ADR-0044 W6); account and tax-code version are that line''s, never re-resolved.';
COMMENT ON COLUMN app.credit_note_line.amount IS
  'Tax-exclusive or tax-inclusive per credit_note.amounts_are (= the invoice''s).';
CREATE INDEX credit_note_line_invoice_line_idx ON app.credit_note_line (tenant_id, invoice_line_id);

ALTER TABLE app.credit_note_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.credit_note_line FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.credit_note_line
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.credit_note_line TO lf_app;

-- The tenant's credit-note self-approval threshold and small-team mode (latest app.sod_settings
-- row; no row = the defaults of migration 0021, = DEFAULT_SOD_SETTINGS).
CREATE FUNCTION app.credit_note_sod_settings(p_tenant uuid, OUT threshold numeric, OUT small_team boolean)
  LANGUAGE sql STABLE
AS $$
  SELECT coalesce((SELECT s.credit_note_self_approval_threshold FROM app.sod_settings s
                    WHERE s.tenant_id = p_tenant ORDER BY s.set_at DESC, s.id DESC LIMIT 1), 1000.0000),
         coalesce((SELECT s.small_team_mode FROM app.sod_settings s
                    WHERE s.tenant_id = p_tenant ORDER BY s.set_at DESC, s.id DESC LIMIT 1), false)
$$;
GRANT EXECUTE ON FUNCTION app.credit_note_sod_settings(uuid) TO lf_app;

CREATE FUNCTION app.credit_note_insert_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  inv record;
BEGIN
  IF NOT app.sod_is_superuser() THEN
    NEW.created_at := clock_timestamp();
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW;
  END IF;
  IF NEW.status <> 'draft' OR NEW.approved_by IS NOT NULL OR NEW.journal_entry_id IS NOT NULL
     OR NEW.credit_note_no IS NOT NULL THEN
    RAISE EXCEPTION 'credit note %: a new credit note is a plain draft', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT i.status, i.party_id, i.currency, i.amounts_are, i.invoice_date INTO inv
    FROM app.sales_invoice i
   WHERE i.tenant_id = NEW.tenant_id AND i.company_id = NEW.company_id AND i.id = NEW.invoice_id;
  IF NOT FOUND OR inv.status <> 'posted' THEN
    RAISE EXCEPTION 'INVOICE_NOT_POSTED: credit note %: sales invoice % is not posted', NEW.id, NEW.invoice_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.party_id <> inv.party_id OR NEW.currency <> inv.currency OR NEW.amounts_are <> inv.amounts_are
     OR NEW.credit_note_date < inv.invoice_date THEN
    RAISE EXCEPTION 'credit note %: party, currency and price mode are the invoice''s and the date is not before it', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER credit_note_insert_guard BEFORE INSERT ON app.credit_note
  FOR EACH ROW EXECUTE FUNCTION app.credit_note_insert_guard();

CREATE FUNCTION app.credit_note_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  e record;
  sums record;
  sod record;
  freq text;
  inv_date date;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'app.credit_note rows are never deleted (directive 6)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'posted' THEN
    RAISE EXCEPTION 'credit note % is posted and cannot change; correct it by a reversal or a new document', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.company_id <> OLD.company_id
     OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.invoice_id <> OLD.invoice_id
     OR NEW.party_id <> OLD.party_id OR NEW.currency <> OLD.currency
     OR NEW.amounts_are <> OLD.amounts_are
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'credit note %: id, company, key, invoice, party, currency and creator never change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'draft' AND (NEW.credit_note_date <> OLD.credit_note_date
       OR NEW.reason <> OLD.reason OR NEW.memo IS DISTINCT FROM OLD.memo) THEN
    RAISE EXCEPTION 'credit note %: only a draft can be edited', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD.status, NEW.status) NOT IN (('draft', 'draft'), ('draft', 'approved'), ('approved', 'posted')) THEN
    RAISE EXCEPTION 'credit note %: % → % is not a workflow step', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'approved' AND (NEW.approved_by IS DISTINCT FROM OLD.approved_by
       OR NEW.approved_at <> OLD.approved_at OR NEW.net_total <> OLD.net_total
       OR NEW.tax_total <> OLD.tax_total OR NEW.total <> OLD.total) THEN
    RAISE EXCEPTION 'credit note %: the approval is frozen', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'approved' THEN
    SELECT count(*) AS n, count(net_amount) AS priced, coalesce(sum(net_amount), 0) AS net,
           coalesce(sum(tax_amount), 0) AS tax INTO sums
      FROM app.credit_note_line
     WHERE tenant_id = NEW.tenant_id AND company_id = NEW.company_id AND credit_note_id = NEW.id;
    IF sums.n = 0 OR sums.priced <> sums.n OR sums.net <> NEW.net_total OR sums.tax <> NEW.tax_total THEN
      RAISE EXCEPTION 'credit note %: approved totals must equal its priced lines', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    sod := app.credit_note_sod_settings(NEW.tenant_id);
    IF NEW.approved_by = OLD.created_by AND NEW.total > sod.threshold AND NOT sod.small_team THEN
      RAISE EXCEPTION 'SOD_CREDIT_NOTE_SELF_APPROVAL: credit note % above % is not approved by its creator (design 6.4)',
        OLD.id, sod.threshold USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NOT app.sod_is_superuser() THEN
    IF OLD.status = 'draft' AND NEW.status = 'approved' THEN
      NEW.approved_at := clock_timestamp();
    ELSIF NEW.status = 'posted' THEN
      NEW.posted_at := clock_timestamp();
    END IF;
  END IF;

  IF NEW.status = 'posted' THEN
    SELECT je.source_type, je.source_id, je.approved_by, je.status INTO e
      FROM app.journal_entry je
     WHERE je.tenant_id = NEW.tenant_id AND je.company_id = NEW.company_id AND je.id = NEW.journal_entry_id;
    IF NOT FOUND OR e.source_type <> 'ar_credit_note' OR e.source_id IS DISTINCT FROM NEW.id::text
       OR e.approved_by IS DISTINCT FROM NEW.approved_by OR e.status <> 'posted' THEN
      RAISE EXCEPTION 'credit note %: journal entry % is not the engine''s posting of this credit note',
        OLD.id, NEW.journal_entry_id USING ERRCODE = 'check_violation';
    END IF;
    SELECT c.bas_frequency INTO freq FROM app.company c
     WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.company_id;
    SELECT i.invoice_date INTO inv_date FROM app.sales_invoice i
     WHERE i.tenant_id = NEW.tenant_id AND i.company_id = NEW.company_id AND i.id = NEW.invoice_id;
    IF NEW.later_bas_period IS DISTINCT FROM
       (app.bas_period_start(NEW.credit_note_date, freq) > app.bas_period_start(inv_date, freq)) THEN
      RAISE EXCEPTION 'credit note %: later_bas_period does not match the % BAS periods of % and %',
        OLD.id, freq, inv_date, NEW.credit_note_date USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER credit_note_guard BEFORE UPDATE OR DELETE ON app.credit_note
  FOR EACH ROW EXECUTE FUNCTION app.credit_note_guard();

CREATE FUNCTION app.credit_note_line_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  cn record;
  lp record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'app.credit_note_line rows are never deleted (directive 6)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id
       OR NEW.company_id <> OLD.company_id OR NEW.credit_note_id <> OLD.credit_note_id) THEN
    RAISE EXCEPTION 'credit note line %: id, company and credit note never change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT c.status, c.invoice_id INTO cn FROM app.credit_note c
   WHERE c.tenant_id = NEW.tenant_id AND c.company_id = NEW.company_id AND c.id = NEW.credit_note_id
     FOR SHARE;
  IF cn.status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'credit note %: only a draft can be edited (credit note is %)', NEW.credit_note_id,
      coalesce(cn.status, 'missing') USING ERRCODE = 'check_violation';
  END IF;
  SELECT p.invoice_id, p.account_id, p.tax_code_id INTO lp FROM app.sales_invoice_line_posting p
   WHERE p.tenant_id = NEW.tenant_id AND p.company_id = NEW.company_id
     AND p.invoice_line_id = NEW.invoice_line_id;
  IF NOT FOUND OR lp.invoice_id <> cn.invoice_id THEN
    RAISE EXCEPTION 'LINE_NOT_ON_INVOICE: credit note %: invoice line % is not a posted line of invoice %',
      NEW.credit_note_id, NEW.invoice_line_id, cn.invoice_id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.account_id <> lp.account_id OR NEW.tax_code_id <> lp.tax_code_id THEN
    RAISE EXCEPTION 'credit note %: line % must take the account and tax code of invoice line % (ADR-0044 W6: never re-resolved)',
      NEW.credit_note_id, NEW.line_no, NEW.invoice_line_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER credit_note_line_guard BEFORE INSERT OR UPDATE OR DELETE ON app.credit_note_line
  FOR EACH ROW EXECUTE FUNCTION app.credit_note_line_guard();
