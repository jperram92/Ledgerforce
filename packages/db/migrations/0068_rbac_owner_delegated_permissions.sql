-- 0068 — Permissions decided under the owner's delegation (T-0169, DL-0477, ADR-0072).
-- Owner: packages/shared (rbac catalogue mirror).
--
-- * app.permission_known: + settings.setup.manage (setup wizard, T-0157), ar.invoice.approve
--   (single-invoice approval, T-0132), ar.refund.create and ar.refund.approve (customer refunds,
--   T-0152). Mirrors packages/shared/src/rbac/catalogue.ts ALL_PERMISSIONS; user-lifecycle.db.test.ts
--   proves the two agree. Role templates stay in TypeScript (0016).
-- * app.token_scope_allowed is unchanged: it builds on permission_known, and none of the new
--   permissions is on the token deny-list (consistent with ar.credit_note.approve).
-- Widening only (CREATE OR REPLACE with a superset); nothing is dropped.

CREATE OR REPLACE FUNCTION app.permission_known(p text) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT p IN ('company.read', 'users.read', 'users.manage', 'users.roles.assign',
               'users.roles.assign_owner', 'subscription.manage', 'audit_log.read', 'settings.read',
               'settings.sod.manage', 'settings.chart.manage', 'settings.tax.manage',
               'settings.posting_rules.author', 'settings.posting_rules.activate', 'period.close',
               'period.lock', 'period.lock.override', 'period.reopen', 'gl.account.read',
               'gl.journal.read', 'gl.journal.post', 'gl.journal.approve', 'reports.run', 'parties.read',
               'parties.manage', 'parties.bank_account.read', 'parties.bank_account.change_request',
               'parties.bank_account.verify', 'bank.read', 'bank.statement.import', 'bank.reconcile',
               'tax.read', 'tax.bas.prepare', 'ar.read', 'ar.invoice.create', 'ar.invoice.send',
               'ar.credit_note.create', 'ar.credit_note.approve', 'ar.receipt.record', 'ar.dunning.run',
               'ar.batch.run', 'ar.batch.approve', 'ap.read', 'ap.bill.enter', 'ap.bill.approve',
               'ap.payment_batch.create', 'ap.payment_batch.approve', 'ap.payment_batch.release',
               'payroll.read', 'payroll.employee_bank.read', 'payroll.pay_run.import',
               'payroll.net_pay_batch.create', 'payroll.net_pay_batch.release',
               'sync.issues.read', 'sync.issues.manage',
               -- 0068 (T-0169, DL-0477, ADR-0072)
               'settings.setup.manage', 'ar.invoice.approve', 'ar.refund.create', 'ar.refund.approve')
$$;
