/**
 * T-0123 setup wizard (design §4.1, RQ-0149, ADR-0067), against a real PostgreSQL as lf_app.
 *
 * SS-PLAT-118: per company the ten steps unlock in order; a step completes only when its
 * validator passes (or, for step 9 only, a no-history declaration with a reason); refusals write
 * nothing; completing step 1 seeds the default overdue-reminder schedule (AC-6); a repeat is a
 * replay; the database refuses a malformed completion record and lf_app cannot delete one.
 * SS-PLAT-119: each step's validator reads the owning module's state and lists, in plain words,
 * what is missing — walked step by step from an empty company to a complete wizard.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { setInvoiceSettings } from '@ledgerforce/ar';
import { createCompanyBankAccount } from '@ledgerforce/bank';
import { createJwtConnection } from '@ledgerforce/connector-salesforce';
import {
  generateTestKeyPair,
  selfSignedCertificate,
} from '@ledgerforce/connector-salesforce/testing';
import { withTenant } from '@ledgerforce/db';
import { seedBillingFormats } from '@ledgerforce/documents';
import { auServicesSmb, CORE_SYSTEM_ROLES, loadChartTemplate } from '@ledgerforce/gl';
import { entrySeriesFor, generateFiscalYear, SOURCE_TYPES } from '@ledgerforce/ledger';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { createParty } from '@ledgerforce/parties';
import {
  createProduct,
  seedPostingProfiles,
  setOverride,
  type SeededProfiles,
} from '@ledgerforce/products';
import { LocalKeyringKms } from '@ledgerforce/shared/crypto';
import { seedTaxCodes, setTaxSettings } from '@ledgerforce/tax';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseTrialBalanceCsv } from './opening-csv.ts';
import { postOpeningBalance } from './opening-balances.ts';
import { completeWizardStep, WizardError, wizardOf, type CompleteWizardStep } from './wizard.ts';

const T = '01900000-0000-7000-8000-000000012301';
const OTHER_T = '01900000-0000-7000-8000-000000012302';
const AS_OF = '2026-11-13';
const VALID_ABN = '51824753556';
const DAY = 86_400_000;
const kms = LocalKeyringKms.fromJson(
  JSON.stringify({ active: 'k1', keys: { k1: randomBytes(32).toString('base64') } }),
);

let f: LedgerFixture;
let c: string; // the company walked through the wizard, created empty
let clerk: string; // completes the steps; holds no role step 10 looks for
let acct: Record<string, string> = {};
let profiles: SeededProfiles;

const wizard = (company = c) => f.inTenant((trx) => wizardOf(trx, company, { asOf: AS_OF }));
const missing = async (step: number, company = c) =>
  (await wizard(company)).steps[step - 1]?.missing;
const complete = (step: number, extra: Partial<CompleteWizardStep> = {}) =>
  f.inTenant((trx) =>
    completeWizardStep(trx, { companyId: c, step, asOf: AS_OF, completedBy: clerk, ...extra }),
  );
const refusal = async (p: Promise<unknown>): Promise<WizardError> => {
  const e: unknown = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(WizardError);
  return e as WizardError;
};
const count = async (table: string, company = c) =>
  (
    await f.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${table} WHERE company_id = $1`,
      [company],
    )
  ).rows[0]?.n;

beforeAll(async () => {
  f = await createLedgerFixture(T);
  clerk = await f.addUser('accountant');
  c = await f.inTenant(async (trx) => {
    const row = await trx
      .insertInto('app.company')
      .values({ name: 'Bay Street Studio', base_currency: 'AUD' })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  });
}, 120_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

describe('SS-PLAT-118: the wizard unlocks steps in order and completes a step only when it validates', () => {
  it('SS-PLAT-118 AC-1 a new company: step 1 is open (in progress), steps 2–10 are locked [T-0123]', async () => {
    const w = await wizard();
    expect(w.companyId).toBe(c);
    expect(w.complete).toBe(false);
    expect(w.steps.map((s) => [s.step, s.status, s.locked])).toEqual([
      [1, 'in_progress', false],
      ...[2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => [n, 'not_started', true]),
    ]);
    expect(w.steps.map((s) => s.title)).toEqual([
      'Company details',
      'Chart of accounts',
      'Tax codes',
      'Bank accounts',
      'Connect Salesforce',
      'Import from Salesforce',
      'Posting profiles',
      'Numbering and billing',
      'Opening balances',
      'Users, roles and approvals',
    ]);
    expect(w.steps[0]).toMatchObject({ completedAt: null, completedBy: null, outcome: null });
  });

  it('SS-PLAT-118 AC-2 completing a later step first is refused STEP_LOCKED and writes nothing [T-0123]', async () => {
    const e = await refusal(complete(2));
    expect(e.code).toBe('STEP_LOCKED');
    expect(e.message).toBe('step 2 is locked: complete step 1 (Company details) first');
    expect(await count('app.setup_wizard_step')).toBe(0);
  });

  it('SS-PLAT-118 AC-2 completing step 1 with details missing is refused STEP_INVALID listing them; nothing is written [T-0123]', async () => {
    const e = await refusal(complete(1));
    expect(e.code).toBe('STEP_INVALID');
    expect(e.missing).toEqual([
      'The legal name is missing',
      'The ABN is missing',
      'No fiscal year has been set up (fiscal year start)',
    ]);
    expect(await count('app.setup_wizard_step')).toBe(0);
    expect(await count('app.ar_reminder_schedule')).toBe(0);

    await f.inTenant((trx) =>
      trx
        .updateTable('app.company')
        .set({ legal_name: 'Bay Street Studio Pty Ltd' })
        .where('id', '=', c)
        .execute(),
    );
    expect(await missing(1)).toEqual([
      'The ABN is missing',
      'No fiscal year has been set up (fiscal year start)',
    ]);
  });

  it('SS-PLAT-118 AC-6 completing step 1 records who and when, unlocks step 2 and seeds the default reminder schedule (step 1 at 7 days); a repeat is a replay [T-0123]', async () => {
    await f.inTenant(async (trx) => {
      await trx.updateTable('app.company').set({ abn: VALID_ABN }).where('id', '=', c).execute();
      await generateFiscalYear(trx, { companyId: c, convention: 'AU', startYear: 2026 });
    });
    expect(await missing(1)).toEqual([]);

    const r = await complete(1);
    expect(r.replayed).toBe(false);
    expect(r.step).toMatchObject({
      step: 1,
      status: 'complete',
      outcome: 'validated',
      reason: null,
      completedBy: clerk,
    });
    expect(r.step.completedAt).toBeInstanceOf(Date);
    const schedule = await f.admin.query<{ step: number; days_overdue: number }>(
      'SELECT step, days_overdue FROM app.ar_reminder_schedule WHERE company_id = $1 ORDER BY step',
      [c],
    );
    expect(schedule.rows[0]).toEqual({ step: 1, days_overdue: 7 });
    const seeded = schedule.rows.length;

    const w = await wizard();
    expect(w.steps.slice(0, 3).map((s) => [s.step, s.status, s.locked])).toEqual([
      [1, 'complete', false],
      [2, 'in_progress', false],
      [3, 'not_started', true],
    ]);

    const again = await complete(1);
    expect(again.replayed).toBe(true);
    expect(again.step.completedAt).toEqual(r.step.completedAt);
    expect(await count('app.setup_wizard_step')).toBe(1);
    expect(await count('app.ar_reminder_schedule')).toBe(seeded);
  });

  it('SS-PLAT-118 the database refuses a malformed completion record and lf_app cannot delete one [T-0123]', async () => {
    const insert = (step: number, outcome: string, reason: string | null) =>
      f.inTenant((trx) =>
        sql`INSERT INTO app.setup_wizard_step (company_id, step, outcome, reason, completed_by)
            VALUES (${c}, ${step}, ${outcome}, ${reason}, ${clerk})`.execute(trx),
      );
    await expect(insert(11, 'validated', null)).rejects.toThrow(/check constraint/);
    await expect(insert(3, 'no_history', 'none')).rejects.toThrow(/check constraint/);
    await expect(insert(9, 'no_history', null)).rejects.toThrow(/check constraint/);
    await expect(insert(9, 'no_history', '   ')).rejects.toThrow(/check constraint/);
    await expect(insert(3, 'validated', 'why')).rejects.toThrow(/check constraint/);
    await expect(insert(3, 'skipped', null)).rejects.toThrow(/check constraint/);
    await expect(
      f.inTenant((trx) =>
        sql`DELETE FROM app.setup_wizard_step WHERE company_id = ${c}`.execute(trx),
      ),
    ).rejects.toThrow(/permission denied/);
    expect(await count('app.setup_wizard_step')).toBe(1);
  });

  it('SS-PLAT-118 another tenant cannot read or complete the company’s wizard [T-0123]', async () => {
    await withTenant(f.db, OTHER_T, (trx) =>
      trx.insertInto('app.tenant').values({ id: OTHER_T, name: 'Other Pty Ltd' }).execute(),
    );
    const read = await refusal(
      withTenant(f.db, OTHER_T, (trx) => wizardOf(trx, c, { asOf: AS_OF })),
    );
    expect(read.code).toBe('UNKNOWN_COMPANY');
    const write = await refusal(
      withTenant(f.db, OTHER_T, (trx) =>
        completeWizardStep(trx, { companyId: c, step: 2, asOf: AS_OF }),
      ),
    );
    expect(write.code).toBe('UNKNOWN_COMPANY');
  });

  it('SS-PLAT-118 a malformed command is refused INVALID_COMMAND [T-0123]', async () => {
    expect((await refusal(complete(0))).code).toBe('INVALID_COMMAND');
    expect((await refusal(complete(11))).code).toBe('INVALID_COMMAND');
    expect((await refusal(complete(2, { asOf: '13/11/2026' }))).code).toBe('INVALID_COMMAND');
    expect((await refusal(complete(2, { companyId: 'nope' }))).code).toBe('INVALID_COMMAND');
  });
});

describe('SS-PLAT-119: each step validator reads its module and lists what is missing', () => {
  it('SS-PLAT-119 AC-2 step 2 lists an empty chart and every unbound core system role, then passes once the template is loaded [T-0123]', async () => {
    expect(await missing(2)).toEqual([
      'The chart of accounts has no accounts',
      ...CORE_SYSTEM_ROLES.map((r) => `System role ${r} is not bound to an account`),
    ]);
    acct = await f.inTenant(async (trx) =>
      Object.fromEntries((await loadChartTemplate(trx, c, auServicesSmb)).accounts),
    );
    expect(await missing(2)).toEqual([]);
    expect((await complete(2)).step.status).toBe('complete');
  });

  it('SS-PLAT-119 AC-2 step 3 needs a tax code in force, and (T-0158) the GST basis and BAS frequency [T-0123]', async () => {
    const settings = [
      'The GST accounting basis (cash or accrual) has not been set',
      'The BAS reporting frequency (monthly, quarterly or annual) has not been set',
    ];
    expect(await missing(3)).toEqual([`No tax code is in force on ${AS_OF}`, ...settings]);
    expect((await refusal(complete(3))).code).toBe('STEP_INVALID');
    await f.inTenant((trx) => seedTaxCodes(trx, c));
    expect(await missing(3)).toEqual(settings);
    await f.inTenant((trx) =>
      setTaxSettings(trx, {
        companyId: c,
        effectiveFrom: '2026-07-01',
        gstBasis: 'accrual',
        basFrequency: 'quarterly',
      }),
    );
    expect(await missing(3)).toEqual([]);
    await complete(3);
  });

  it('SS-PLAT-119 AC-2 step 4 needs a bank account, and one with ABA details for batch payments [T-0123]', async () => {
    const batch = 'No bank account has an APCA user id and ABA user name (batch payments)';
    expect(await missing(4)).toEqual(['No bank account has been added', batch]);
    const base = {
      bsb: '062-000',
      accountName: 'Bay Street Studio Pty Ltd',
      currency: 'AUD',
    };
    await f.inTenant((trx) =>
      createCompanyBankAccount(trx, kms, c, {
        ...base,
        glAccountId: acct['1020'] ?? '',
        name: 'Savings',
        accountNumber: '111111',
      }),
    );
    expect(await missing(4)).toEqual([batch]);
    await f.inTenant((trx) =>
      createCompanyBankAccount(trx, kms, c, {
        ...base,
        glAccountId: acct['1010'] ?? '',
        name: 'Operating',
        accountNumber: '222222',
        apcaUserId: '123456',
        abaUserName: 'BAY STREET STUDIO',
      }),
    );
    expect(await missing(4)).toEqual([]);
    await complete(4);
  });

  it('SS-PLAT-119 AC-2 step 5 needs an active Salesforce connection and the invoicing trigger [T-0123]', async () => {
    expect(await missing(5)).toEqual([
      'Salesforce is not connected',
      'The Salesforce object that triggers invoicing (Opportunity or Order) has not been chosen',
    ]);
    const keys = generateTestKeyPair();
    const now = new Date();
    await f.inTenant((trx) =>
      createJwtConnection(trx, kms, c, {
        loginUrl: 'https://test.salesforce.com',
        username: 'integration@baystreet.example',
        consumerKey: 'test-consumer-key',
        privateKeyPem: keys.privateKeyPem,
        certificatePem: selfSignedCertificate(
          keys,
          new Date(now.getTime() - DAY),
          new Date(now.getTime() + 365 * DAY),
        ),
      }),
    );
    expect(await missing(5)).toEqual([
      'The Salesforce object that triggers invoicing (Opportunity or Order) has not been chosen',
    ]);
    // The connector's billing settings (setSalesforceBillingSettings is not a package export).
    await f.inTenant((trx) =>
      sql`INSERT INTO app.salesforce_billing_settings (company_id, invoice_trigger)
          VALUES (${c}, 'order')`.execute(trx),
    );
    expect(await missing(5)).toEqual([]);
    await complete(5);
  });

  it('SS-PLAT-119 AC-2 step 6 needs a party and a product imported from Salesforce; step 7 lists missing profiles [T-0123]', async () => {
    expect(await missing(6)).toEqual([
      'No customer or supplier has been imported from Salesforce',
      'No product has been imported from Salesforce',
    ]);
    expect(await missing(7)).toEqual([
      'No active party posting profile',
      'No active product posting profile',
    ]);
    profiles = await f.inTenant((trx) =>
      seedPostingProfiles(trx, c, auServicesSmb, new Map(Object.entries(acct))),
    );
    // Entered in LedgerForce, not imported: does not count.
    await f.inTenant((trx) => createParty(trx, c, { legalName: 'Walk-in', roles: ['customer'] }));
    expect(await missing(6)).toHaveLength(2);
    await f.inTenant(async (trx) => {
      await createParty(trx, c, {
        legalName: 'Acme Pty Ltd',
        roles: ['customer'],
        salesforceAccountId: '001000000000001AAA',
      });
      await createProduct(trx, c, {
        sku: 'CONSULT',
        name: 'Consulting',
        productProfileId: profiles.productProfiles.get('PROFESSIONAL_SERVICES') ?? '',
        salesforceProduct2Id: '01t000000000001AAA',
      });
    });
    expect(await missing(6)).toEqual([]);
    await complete(6);
  });

  it('SS-PLAT-119 AC-2 step 7 lists each posting-profile gap from the gap check until it is filled [T-0123]', async () => {
    expect(await missing(7)).toEqual([]);
    // Hardware sales account archived: every customer × HARDWARE sale has no revenue account.
    await f.inTenant((trx) =>
      trx
        .updateTable('app.account')
        .set({ status: 'archived' })
        .where('id', '=', acct['4140'] ?? '')
        .execute(),
    );
    const gaps = (await missing(7)) ?? [];
    expect(gaps).toHaveLength(2);
    expect(gaps[0]).toMatch(/^Posting-profile gap: DOMESTIC_CUSTOMER × HARDWARE \(sale\): .+/);
    expect(gaps[1]).toMatch(/^Posting-profile gap: OVERSEAS_CUSTOMER × HARDWARE \(sale\): .+/);
    const e = await refusal(complete(7));
    expect(e.code).toBe('STEP_INVALID');
    expect(e.missing).toEqual(gaps);
    await f.inTenant(async (trx) => {
      for (const party of ['DOMESTIC_CUSTOMER', 'OVERSEAS_CUSTOMER']) {
        await setOverride(trx, c, {
          partyProfileId: profiles.partyProfiles.get(party) ?? '',
          productProfileId: profiles.productProfiles.get('HARDWARE') ?? '',
          revenueAccountId: acct['4110'] ?? '',
        });
      }
    });
    expect(await missing(7)).toEqual([]);
    await complete(7);
  });

  it('SS-PLAT-119 AC-2 step 8 needs the invoice number series and a billing format, and (T-0158) branding, terms and methods [T-0123]', async () => {
    const settings = [
      'Invoice branding (a brand colour) has not been set',
      'Default payment terms have not been set',
      'No accepted payment method (bank transfer or Stripe) has been chosen',
    ];
    expect(await missing(8)).toEqual([
      'No invoice number series (ar_invoice_document) has been set up',
      'No billing format has been set up',
      ...settings,
    ]);
    await f.inTenant(async (trx) => {
      await trx
        .insertInto('app.number_series')
        .values({ company_id: c, code: 'ar_invoice_document', prefix: 'INV-' })
        .execute();
      await seedBillingFormats(trx, c);
    });
    expect(await missing(8)).toEqual(settings);
    await f.inTenant((trx) =>
      setInvoiceSettings(trx, c, {
        brandColour: '#0B3D2E',
        defaultPaymentTermsDays: 30,
        acceptedPaymentMethods: ['bank_transfer'],
      }),
    );
    expect(await missing(8)).toEqual([]);
    await complete(8);
  });

  it('SS-PLAT-119 AC-2 step 9 needs an opening balance or a no-history declaration with a reason; only step 9 may be declared [T-0123]', async () => {
    expect(await missing(9)).toEqual([
      'No opening balance has been posted, and the company has not declared that it has no history',
    ]);
    expect((await refusal(complete(9))).code).toBe('STEP_INVALID');
    expect((await refusal(complete(9, { noHistoryReason: '   ' }))).code).toBe('INVALID_COMMAND');
    expect((await refusal(complete(9, { noHistoryReason: 'x'.repeat(501) }))).code).toBe(
      'INVALID_COMMAND',
    );
    const other = await refusal(complete(10, { noHistoryReason: 'new business' }));
    expect(other.code).toBe('NO_HISTORY_NOT_ALLOWED');
    expect(other.message).toBe('only step 9 (Opening balances) can be completed without history');

    const r = await complete(9, {
      noHistoryReason: '  New business, first trading day 1 Nov 2026 ',
    });
    expect(r.step).toMatchObject({
      status: 'complete',
      outcome: 'no_history',
      reason: 'New business, first trading day 1 Nov 2026',
      valid: true,
      missing: [],
    });
    expect((await wizard()).steps[9]).toMatchObject({ status: 'in_progress', locked: false });
  });

  it('SS-PLAT-119 AC-2 step 10 needs an Owner or Finance Admin and saved approval thresholds; then the wizard is complete [T-0123]', async () => {
    const people = 'No active user holds the Owner or Finance Admin role';
    const sod = 'Approval thresholds (segregation-of-duties settings) have not been saved';
    expect(await missing(10)).toEqual([people, sod]);
    await f.addUser('approver');
    expect(await missing(10)).toEqual([people, sod]);
    // The Owner may save SoD settings (settings.sod.manage), so step 10 can be finished.
    const admin = await f.addUser('owner');
    expect(await missing(10)).toEqual([sod]);
    await f.inTenant((trx) =>
      sql`INSERT INTO app.sod_settings (set_by, reason) VALUES (${admin}, 'Defaults confirmed in setup')`.execute(
        trx,
      ),
    );
    expect(await missing(10)).toEqual([]);
    await complete(10, { completedBy: admin });
    const w = await wizard();
    expect(w.complete).toBe(true);
    expect(w.steps.every((s) => s.status === 'complete' && !s.locked && s.valid)).toBe(true);
    expect(await count('app.setup_wizard_step')).toBe(10);
  });

  it('SS-PLAT-119 a step whose module state regresses after completion stays complete but shows what is missing [T-0123]', async () => {
    await f.inTenant((trx) =>
      trx
        .updateTable('app.account')
        .set({ status: 'archived' })
        .where('id', '=', acct['4130'] ?? '')
        .execute(),
    );
    const s7 = (await wizard()).steps[6];
    expect(s7?.status).toBe('complete');
    expect(s7?.valid).toBe(false);
    expect(s7?.missing.length).toBeGreaterThan(0);
    expect((await wizard()).complete).toBe(true);
  });

  it('SS-PLAT-119 step 9 passes once an opening balance is posted, and no-history is then refused [T-0123]', async () => {
    const company = f.companyId;
    await f.inTenant(async (trx) => {
      const series = [...new Set(Object.keys(SOURCE_TYPES).map((s) => entrySeriesFor(s)))];
      for (const [i, code] of series.entries()) {
        await trx
          .insertInto('app.number_series')
          .values({ company_id: company, code, prefix: `W${String(i)}-` })
          .onConflict((oc) => oc.doNothing())
          .execute();
      }
    });
    expect(await missing(9, company)).toHaveLength(1);
    await f.inTenant((trx) =>
      postOpeningBalance(trx, {
        companyId: company,
        conversionDate: '2026-11-01',
        trialBalance: parseTrialBalanceCsv(
          ['account_code,debit,credit', '1010,500.00,', '3200,,500.00'].join('\n'),
        ),
        items: [],
        idempotencyKey: randomUUID(),
      }),
    );
    expect(await missing(9, company)).toEqual([]);
    const e = await refusal(
      f.inTenant((trx) =>
        completeWizardStep(trx, {
          companyId: company,
          step: 9,
          asOf: AS_OF,
          noHistoryReason: 'new business',
        }),
      ),
    );
    expect(e.code).toBe('NO_HISTORY_NOT_ALLOWED');
    expect(e.message).toBe('an opening balance has been posted, so the company has history');
  });
});
