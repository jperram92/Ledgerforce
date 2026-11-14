-- 0069 — SoD steps and rules for invoices and customer refunds (DL-0477 items 2–3, ADR-0072,
-- DL-0561; shared by T-0132 and T-0152). Owner: packages/shared (SoD rules mirror).
--
-- * app.sod_step_known: + invoice.create, invoice.approve, refund.create, refund.approve.
-- * app.sod_rule_known: + SOD_INVOICE_SELF_APPROVAL, SOD_REFUND_SELF_APPROVAL.
-- Both mirror packages/shared/src/sod/rules.ts; packages/db/src/sod.db.test.ts (SS-PLAT-62) proves
-- they agree. The CHECK constraints on app.sod_action and app.sod_exception call these functions, so
-- widening them to a superset keeps every stored row valid. Nothing is dropped.

CREATE OR REPLACE FUNCTION app.sod_step_known(step text) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT step IN ('bill.enter', 'bill.approve',
                  'credit_note.create', 'credit_note.approve',
                  'payment_batch.create', 'payment_batch.approve', 'payment_batch.release',
                  'net_pay_batch.create', 'net_pay_batch.release',
                  'bank_detail_change.request', 'bank_detail_change.verify',
                  'manual_journal.post', 'manual_journal.approve',
                  'posting_rule.author', 'posting_rule.activate',
                  'tax_code.author', 'tax_code.activate',
                  'period_reopen_request.request', 'period_reopen_request.approve',
                  -- 0069 (DL-0477, ADR-0072)
                  'invoice.create', 'invoice.approve', 'refund.create', 'refund.approve')
$$;

CREATE OR REPLACE FUNCTION app.sod_rule_known(rule text) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT rule IN ('SOD_BATCH_SELF_RELEASE', 'SOD_BATCH_SAME_RELEASER', 'SOD_BATCH_SELF_APPROVAL',
                  'SOD_NET_PAY_SELF_RELEASE', 'SOD_BANK_DETAIL_SELF_VERIFY',
                  'SOD_BILL_SELF_APPROVAL', 'SOD_JOURNAL_SELF_APPROVAL',
                  'SOD_RULE_SELF_ACTIVATION', 'SOD_TAX_CODE_SELF_ACTIVATION',
                  'SOD_PERIOD_REOPEN_SELF_APPROVAL', 'SOD_CREDIT_NOTE_SELF_APPROVAL',
                  -- 0069 (DL-0477, ADR-0072)
                  'SOD_INVOICE_SELF_APPROVAL', 'SOD_REFUND_SELF_APPROVAL')
$$;
