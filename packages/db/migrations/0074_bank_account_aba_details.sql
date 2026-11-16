-- 0074 — company bank account: the ABA header is editable in place (T-0193, ADR-0094, RQ-0176,
-- DL-0800). Owner: packages/modules/bank.
--
-- * lf_app may now UPDATE apca_user_id, aba_user_name and aba_fi_mnemonic of app.bank_account
--   (in addition to name, status and csv_mapping, migration 0013). These identify the company to
--   its own bank in an ABA file's descriptive record; they cannot redirect a payment. The BSB,
--   account name, number columns, currency, GL account and company stay without an UPDATE grant:
--   a different number is still a new account (0013).
-- * app.bank_account_aba_archived_guard(): BEFORE UPDATE OF the three columns. An archived
--   account keeps its ABA details: a change of any of them is refused (check_violation) when the
--   row is archived before or after the update. Rows of another tenant are left to RLS.
-- Nothing is dropped; the table keeps RLS ENABLE + FORCE and its tenant_isolation policy.

GRANT UPDATE (apca_user_id, aba_user_name, aba_fi_mnemonic) ON app.bank_account TO lf_app;

CREATE FUNCTION app.bank_account_aba_archived_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW; -- another tenant's row (or no tenant): RLS decides
  END IF;
  IF (NEW.apca_user_id, NEW.aba_user_name, NEW.aba_fi_mnemonic)
       IS DISTINCT FROM (OLD.apca_user_id, OLD.aba_user_name, OLD.aba_fi_mnemonic)
     AND (OLD.status = 'archived' OR NEW.status = 'archived') THEN
    RAISE EXCEPTION 'bank account % is archived; its ABA details cannot change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.bank_account_aba_archived_guard() IS
  'ADR-0094: the ABA details of an archived company bank account cannot change.';
CREATE TRIGGER bank_account_aba_archived_guard
  BEFORE UPDATE OF apca_user_id, aba_user_name, aba_fi_mnemonic ON app.bank_account
  FOR EACH ROW EXECUTE FUNCTION app.bank_account_aba_archived_guard();

COMMENT ON COLUMN app.bank_account.apca_user_id IS
  'APCA / Direct Entry user id, 6 digits (ABA type 0, pos 57-62; RQ-0006). Editable by lf_app while active (0074, ADR-0094).';
