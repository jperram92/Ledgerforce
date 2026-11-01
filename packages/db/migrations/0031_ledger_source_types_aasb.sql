-- 0031 — Source types for the AASB/GST golden postings GP-020…GP-036 (T-0116, DL-0258,
-- RQ-0095/RQ-0096). Owner: packages/ledger (period-matrix.ts SOURCE_TYPES is the mirror;
-- period-control.db.test.ts proves the two agree for every status × source type cell).
--
-- Forward-only: replaces the body of app.source_type_class() from 0018 with the same CASE plus
-- ten source types, each in the class design §3.5 gives it:
--   ar      ar_recovery (cash on a written-off debt, GP-026)
--   ap      payroll_super_payment (Payday Super, GP-033), payroll_sgc_assessment (GP-034)
--   payout  payments_stripe_tax_invoice (monthly fee-GST reconciliation, GP-028)
--   journal ar_ecl_adjustment (GP-025), ledger_accrual (GP-031), ledger_prepayment_release
--           (GP-032b), ledger_recurring_depreciation (GP-030), ledger_prior_period_adjustment
--           (AASB 108, no control lines), revrec_release (GP-017, GP-021c)
-- Every existing source type keeps its class. Unknown source types still return NULL (refused).

CREATE OR REPLACE FUNCTION app.source_type_class(source_type text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN source_type IN ('ar_invoice', 'ar_credit_note', 'ar_receipt', 'ar_refund', 'ar_write_off',
                         'ar_prepayment', 'ar_prepayment_application', 'payments_stripe_charge',
                         'ar_recovery') THEN 'ar'
    WHEN source_type IN ('ap_bill', 'ap_payment', 'payroll_pay_run', 'payroll_net_pay_batch',
                         'payroll_super_payment', 'payroll_sgc_assessment') THEN 'ap'
    WHEN source_type IN ('payments_stripe_payout', 'payments_stripe_tax_invoice') THEN 'payout'
    WHEN source_type IN ('manual_journal', 'ar_ecl_adjustment', 'ledger_accrual',
                         'ledger_prepayment_release', 'ledger_recurring_depreciation',
                         'ledger_prior_period_adjustment', 'revrec_release') THEN 'journal'
    WHEN source_type = 'ledger_reversal' THEN 'reversal'
  END
$$;

COMMENT ON FUNCTION app.source_type_class(text) IS
  'Source type → period class (design 3.5). Mirrors SOURCE_TYPES in packages/ledger/src/period-matrix.ts (0031: AASB/GST source types).';
