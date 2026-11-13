-- 0066 — Record that app.ar_settings.ecl_allowance_account_id is deprecated (T-0159, ADR-0068,
-- DL-0474). Owner: packages/modules/ar.
--
-- The bad-debt write-off finds the ECL allowance by the AR_ECL_ALLOWANCE system role (T-0145). The
-- column is kept (forward-only, additive): a value that differs from the role binding makes the
-- write-off refuse, and a value equal to it changes nothing. Only the comment changes here.

COMMENT ON COLUMN app.ar_settings.ecl_allowance_account_id IS
  'DEPRECATED (ADR-0068, T-0145): the ECL allowance is the account bound to the AR_ECL_ALLOWANCE system role. Kept for compatibility; must be NULL or equal that account.';
