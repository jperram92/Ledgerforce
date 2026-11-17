/**
 * T-0158 module-owned settings for wizard steps 3 and 8 (design §4.1, RQ-0153, ADR-0071), against
 * a real PostgreSQL as lf_app.
 *
 * SS-PLAT-121: step 3 lists the GST basis and BAS frequency until the tax module stores a setting
 * in force on the as-of date (effective-dated, from the 1st of a month); step 8 lists branding,
 * default payment terms and accepted payment methods until the ar module stores them, and Stripe
 * as a method needs Stripe set up. The modules and the database refuse malformed settings; another
 * tenant cannot read them. Step 10 needs nothing new (RQ-0153 Q4).
 *
 * SS-PLAT-148 (T-0183, ADR-0079 decision 2): when bank transfer is accepted, step 8 also lists the
 * remittance bank account until an approved one is in force. The company walked by SS-PLAT-121
 * has one approved in its fixture (maker-checker, ADR-0080).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createCompanyBankAccount } from '@ledgerforce/bank';
import { seedBillingFormats } from '@ledgerforce/documents';
import { auServicesSmb, loadChartTemplate } from '@ledgerforce/gl';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { withTenant } from '@ledgerforce/db';
import {
  approveRemittanceAccountChange,
  invoiceSettingsOf,
  InvoiceSettingsError,
  rejectRemittanceAccountChange,
  requestRemittanceAccountChange,
  setInvoiceSettings,
  type InvoiceSettingsPatch,
} from '@ledgerforce/ar';
import {
  seedTaxCodes,
  setTaxSettings,
  taxSettingsOf,
  TaxSettingsError,
  type SetTaxSettings,
} from '@ledgerforce/tax';
import { LocalKeyringKms } from '@ledgerforce/shared/crypto';
import { sql, type Transaction } from 'kysely';
import type { Database } from '@ledgerforce/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wizardOf } from './wizard.ts';

const T = '01900000-0000-7000-8000-000000015801';
const OTHER_T = '01900000-0000-7000-8000-000000015802';
const AS_OF = '2026-11-13';
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);

const BASIS = 'The GST accounting basis (cash or accrual) has not been set';
const FREQUENCY = 'The BAS reporting frequency (monthly, quarterly or annual) has not been set';
const BRANDING = 'Invoice branding (a brand colour) has not been set';
const TERMS = 'Default payment terms have not been set';
const METHODS = 'No accepted payment method (bank transfer or Stripe) has been chosen';
const STRIPE =
  'Stripe is an accepted payment method but Stripe is not set up (no clearing account)';
const REMITTANCE = 'No remittance bank account has been chosen for bank transfer';
const kms = LocalKeyringKms.fromJson(
  JSON.stringify({ active: 'k1', keys: { k1: randomBytes(32).toString('base64') } }),
);

let f: LedgerFixture;
let c: string;
let user: string;
let checker: string;
let acct: Record<string, string> = {};

const missing = async (step: number, asOf = AS_OF) =>
  (await f.inTenant((trx) => wizardOf(trx, c, { asOf }))).steps[step - 1]?.missing;
const setTax = (s: Partial<SetTaxSettings>) =>
  f.inTenant((trx) =>
    setTaxSettings(trx, {
      companyId: c,
      effectiveFrom: '2026-07-01',
      gstBasis: 'cash',
      basFrequency: 'quarterly',
      ...s,
    }),
  );
const setAr = (p: InvoiceSettingsPatch) => f.inTenant((trx) => setInvoiceSettings(trx, c, p));
/** An active company bank account on the chart's operating account (sealed by the bank module). */
const operatingAccount = (trx: Transaction<Database>, company: string, glAccountId: string) =>
  createCompanyBankAccount(trx, kms, company, {
    glAccountId,
    name: 'Operating',
    bsb: '062-000',
    accountName: 'Harbour Lane Design Pty Ltd',
    accountNumber: '12345678',
    currency: 'AUD',
  });
/** Maker-checker (ADR-0080): `user` requests, `checker` approves, in separate transactions. */
const approveRemittance = async (company: string, bankAccountId: string) => {
  const changeId = randomUUID();
  await f.inTenant((trx) =>
    requestRemittanceAccountChange(trx, {
      companyId: company,
      changeId,
      bankAccountId,
      requestedBy: user,
    }),
  );
  await f.inTenant((trx) =>
    approveRemittanceAccountChange(trx, { companyId: company, changeId, approvedBy: checker }),
  );
};
const refused = async (p: Promise<unknown>): Promise<{ code: string; message: string }> => {
  const e: unknown = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(Error);
  return e as { code: string; message: string };
};

beforeAll(async () => {
  f = await createLedgerFixture(T);
  user = await f.addUser('finance_admin');
  checker = await f.addUser('finance_admin');
  c = await f.inTenant(async (trx) => {
    const row = await trx
      .insertInto('app.company')
      .values({ name: 'Harbour Lane Design', base_currency: 'AUD' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await seedTaxCodes(trx, row.id);
    await trx
      .insertInto('app.number_series')
      .values({ company_id: row.id, code: 'ar_invoice_document', prefix: 'INV-' })
      .execute();
    await seedBillingFormats(trx, row.id);
    return row.id;
  });
  acct = await f.inTenant(async (trx) =>
    Object.fromEntries((await loadChartTemplate(trx, c, auServicesSmb)).accounts),
  );
  // T-0183: bank transfer needs a remittance account in force; approve one up front.
  const operating = await f.inTenant((trx) => operatingAccount(trx, c, acct['1010'] ?? ''));
  await approveRemittance(c, operating);
}, 120_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

describe('SS-PLAT-121: step 3 requires the GST basis and BAS frequency (tax module)', () => {
  it('SS-PLAT-121 AC-1 step 3 lists the GST basis and BAS frequency until a tax setting is in force on the as-of date [T-0158]', async () => {
    expect(await missing(3)).toEqual([BASIS, FREQUENCY]);
    expect(await f.inTenant((trx) => taxSettingsOf(trx, c, AS_OF))).toBeNull();

    // Saved, but only from next month: not in force yet.
    await setTax({ effectiveFrom: '2026-12-01', gstBasis: 'accrual', basFrequency: 'monthly' });
    expect(await missing(3)).toEqual([BASIS, FREQUENCY]);
    expect(await missing(3, '2026-12-01')).toEqual([]);

    const saved = await setTax({ setBy: user });
    expect(saved).toMatchObject({
      companyId: c,
      effectiveFrom: '2026-07-01',
      gstBasis: 'cash',
      basFrequency: 'quarterly',
      setBy: user,
    });
    expect(saved.setAt).toBeInstanceOf(Date);
    expect(await missing(3)).toEqual([]);
  });

  it('SS-PLAT-121 AC-1 the setting in force is the latest from on or before the date; saving the same date corrects it [T-0158]', async () => {
    const at = (d: string) => f.inTenant((trx) => taxSettingsOf(trx, c, d));
    expect(await at('2026-06-30')).toBeNull();
    expect(await at('2026-07-01')).toMatchObject({ gstBasis: 'cash', basFrequency: 'quarterly' });
    expect(await at('2026-11-30')).toMatchObject({ effectiveFrom: '2026-07-01' });
    expect(await at('2027-03-31')).toMatchObject({
      effectiveFrom: '2026-12-01',
      gstBasis: 'accrual',
      basFrequency: 'monthly',
    });
    // Every lawful pair is accepted (RQ-0153 conclusion 1): eligibility is not data we hold.
    await setTax({ effectiveFrom: '2026-12-01', gstBasis: 'cash', basFrequency: 'annual' });
    expect(await at('2027-03-31')).toMatchObject({ gstBasis: 'cash', basFrequency: 'annual' });
    const rows = await f.admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM app.tax_settings WHERE company_id = $1',
      [c],
    );
    expect(rows.rows[0]?.n).toBe(2);
  });

  it('SS-PLAT-121 AC-1 malformed tax settings are refused by the module and by the database [T-0158]', async () => {
    for (const bad of [
      { effectiveFrom: '2026-07-15' },
      { effectiveFrom: '01/07/2026' },
      { gstBasis: 'hybrid' as never },
      { basFrequency: 'weekly' as never },
      { companyId: 'nope' },
    ]) {
      const e = await refused(setTax(bad));
      expect(e).toBeInstanceOf(TaxSettingsError);
      expect(e.code).toBe('INVALID_TAX_SETTINGS');
    }
    const insert = (from: string, basis: string, freq: string) =>
      f.inTenant((trx) =>
        sql`INSERT INTO app.tax_settings (company_id, effective_from, gst_basis, bas_frequency)
            VALUES (${c}, ${from}::date, ${basis}, ${freq})`.execute(trx),
      );
    await expect(insert('2027-01-15', 'cash', 'monthly')).rejects.toThrow(/check constraint/);
    await expect(insert('2027-01-01', 'hybrid', 'monthly')).rejects.toThrow(/check constraint/);
    await expect(insert('2027-01-01', 'cash', 'weekly')).rejects.toThrow(/check constraint/);
    await expect(
      f.inTenant((trx) => sql`DELETE FROM app.tax_settings WHERE company_id = ${c}`.execute(trx)),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('SS-PLAT-121: step 8 requires branding, payment terms and payment methods (ar module)', () => {
  it('SS-PLAT-121 AC-2 step 8 lists branding, payment terms and methods until the ar module stores each [T-0158]', async () => {
    expect(await missing(8)).toEqual([BRANDING, TERMS, METHODS]);
    expect(await f.inTenant((trx) => invoiceSettingsOf(trx, c))).toEqual({
      brandColour: null,
      brandAccentColour: null,
      logo: null,
      defaultPaymentTermsDays: null,
      acceptedPaymentMethods: null,
    });

    await setAr({ brandColour: '#1f4e79' });
    expect(await missing(8)).toEqual([TERMS, METHODS]);
    await setAr({ defaultPaymentTermsDays: 14 });
    expect(await missing(8)).toEqual([METHODS]);
    await setAr({ acceptedPaymentMethods: ['bank_transfer'] });
    expect(await missing(8)).toEqual([]);

    // A patch changes only what it names.
    expect(await f.inTenant((trx) => invoiceSettingsOf(trx, c))).toEqual({
      brandColour: '#1F4E79',
      brandAccentColour: null,
      logo: null,
      defaultPaymentTermsDays: 14,
      acceptedPaymentMethods: ['bank_transfer'],
    });
  });

  it('SS-PLAT-121 AC-2 accepting Stripe needs Stripe set up; a logo is optional and stored with its type [T-0158]', async () => {
    await setAr({ acceptedPaymentMethods: ['stripe', 'bank_transfer'] });
    expect(await missing(8)).toEqual([STRIPE]);
    await f.inTenant((trx) =>
      sql`INSERT INTO app.stripe_settings (company_id, clearing_account_id)
          VALUES (${c}, ${acct['1010'] ?? ''})`.execute(trx),
    );
    expect(await missing(8)).toEqual([]);

    await setAr({ logo: { contentType: 'image/png', content: PNG }, brandAccentColour: '#F2A900' });
    expect(await f.inTenant((trx) => invoiceSettingsOf(trx, c))).toEqual({
      brandColour: '#1F4E79',
      brandAccentColour: '#F2A900',
      logo: { contentType: 'image/png', sizeBytes: PNG.length },
      defaultPaymentTermsDays: 14,
      acceptedPaymentMethods: ['bank_transfer', 'stripe'],
    });
    await setAr({ logo: { contentType: 'image/jpeg', content: JPEG } });
    expect((await f.inTenant((trx) => invoiceSettingsOf(trx, c))).logo).toEqual({
      contentType: 'image/jpeg',
      sizeBytes: JPEG.length,
    });
    await setAr({ logo: null });
    expect((await f.inTenant((trx) => invoiceSettingsOf(trx, c))).logo).toBeNull();
    expect(await missing(8)).toEqual([]);
  });

  it('SS-PLAT-121 AC-2 malformed AR invoice settings are refused by the module and by the database [T-0158]', async () => {
    const bad: InvoiceSettingsPatch[] = [
      { brandColour: 'blue' },
      { brandColour: null as never },
      { brandAccentColour: '#12345' },
      { defaultPaymentTermsDays: -1 },
      { defaultPaymentTermsDays: 366 },
      { defaultPaymentTermsDays: 7.5 },
      { defaultPaymentTermsDays: null as never },
      { acceptedPaymentMethods: [] },
      { acceptedPaymentMethods: ['cheque' as never] },
      { acceptedPaymentMethods: ['stripe', 'stripe'] },
      { acceptedPaymentMethods: null as never },
      { logo: { contentType: 'image/svg+xml' as never, content: PNG } },
      { logo: { contentType: 'image/png', content: JPEG } },
      { logo: { contentType: 'image/jpeg', content: PNG } },
      { logo: { contentType: 'image/png', content: new Uint8Array(0) } },
      { logo: { contentType: 'image/png', content: new Uint8Array(512 * 1024 + 1).fill(0x89) } },
    ];
    for (const p of bad) {
      const e = await refused(setAr(p));
      expect(e).toBeInstanceOf(InvoiceSettingsError);
      expect(e.code).toBe('INVALID_INVOICE_SETTINGS');
    }
    const update = (set: ReturnType<typeof sql>) =>
      f.inTenant((trx) =>
        sql`UPDATE app.ar_settings SET ${set} WHERE company_id = ${c}`.execute(trx),
      );
    await expect(update(sql`brand_colour = 'blue'`)).rejects.toThrow(/check constraint/);
    await expect(update(sql`default_payment_terms_days = 400`)).rejects.toThrow(/check constraint/);
    await expect(update(sql`accepted_payment_methods = '{}'`)).rejects.toThrow(/check constraint/);
    await expect(update(sql`accepted_payment_methods = '{cheque}'`)).rejects.toThrow(
      /check constraint/,
    );
    await expect(update(sql`accepted_payment_methods = '{stripe,stripe}'`)).rejects.toThrow(
      /check constraint/,
    );
    await expect(update(sql`logo_content_type = 'image/svg+xml'`)).rejects.toThrow(
      /check constraint/,
    );
    await expect(update(sql`logo = '\\x00'::bytea`)).rejects.toThrow(/check constraint/);
    // Nothing changed.
    expect(await missing(8)).toEqual([]);
  });
});

describe('SS-PLAT-148: step 8 asks for a remittance bank account when bank transfer is accepted', () => {
  it('SS-PLAT-148 step 8 lists the remittance account with bank transfer and none in force; not with Stripe only, nor once an approved account is in force [T-0183]', async () => {
    const { c2, gl } = await f.inTenant(async (trx) => {
      const row = await trx
        .insertInto('app.company')
        .values({ name: 'Bay Street Studio', base_currency: 'AUD' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('app.number_series')
        .values({ company_id: row.id, code: 'ar_invoice_document', prefix: 'INV-' })
        .execute();
      await seedBillingFormats(trx, row.id);
      const chart = Object.fromEntries(
        (await loadChartTemplate(trx, row.id, auServicesSmb)).accounts,
      );
      await setInvoiceSettings(trx, row.id, {
        brandColour: '#0B3D2E',
        defaultPaymentTermsDays: 30,
      });
      await sql`INSERT INTO app.stripe_settings (company_id, clearing_account_id)
                VALUES (${row.id}, ${chart['1210'] ?? ''})`.execute(trx);
      return { c2: row.id, gl: chart };
    });
    const missing2 = async () =>
      (await f.inTenant((trx) => wizardOf(trx, c2, { asOf: AS_OF }))).steps[7]?.missing;
    const set2 = (p: InvoiceSettingsPatch) => f.inTenant((trx) => setInvoiceSettings(trx, c2, p));

    // Stripe only: no remittance account is needed.
    await set2({ acceptedPaymentMethods: ['stripe'] });
    expect(await missing2()).toEqual([]);

    // Bank transfer accepted and no account at all.
    await set2({ acceptedPaymentMethods: ['bank_transfer'] });
    expect(await missing2()).toEqual([REMITTANCE]);
    await set2({ acceptedPaymentMethods: ['bank_transfer', 'stripe'] });
    expect(await missing2()).toEqual([REMITTANCE]);

    // A bank account exists, and a change is requested but not approved, then rejected.
    const operating = await f.inTenant((trx) => operatingAccount(trx, c2, gl['1010'] ?? ''));
    const asked = randomUUID();
    await f.inTenant((trx) =>
      requestRemittanceAccountChange(trx, {
        companyId: c2,
        changeId: asked,
        bankAccountId: operating,
        requestedBy: user,
      }),
    );
    expect(await missing2()).toEqual([REMITTANCE]);
    await f.inTenant((trx) =>
      rejectRemittanceAccountChange(trx, {
        companyId: c2,
        changeId: asked,
        rejectedBy: checker,
        reason: 'Wrong account',
      }),
    );
    expect(await missing2()).toEqual([REMITTANCE]);

    // Approved by a second person: in force, nothing is missing.
    await approveRemittance(c2, operating);
    expect(await missing2()).toEqual([]);

    // Archiving the account releases the designation (ADR-0086): step 8 asks again.
    await f.inTenant((trx) =>
      trx
        .updateTable('app.bank_account')
        .set({ status: 'archived' })
        .where('id', '=', operating)
        .execute(),
    );
    expect(await missing2()).toEqual([REMITTANCE]);
    // The other company's account in force is untouched.
    expect(await missing(8)).toEqual([]);
  });
});

describe('SS-PLAT-121: tenant isolation and step 10', () => {
  it('SS-PLAT-121 AC-3 another tenant cannot read or write the company settings [T-0158]', async () => {
    await withTenant(f.db, OTHER_T, (trx) =>
      trx.insertInto('app.tenant').values({ id: OTHER_T, name: 'Other Pty Ltd' }).execute(),
    );
    expect(await withTenant(f.db, OTHER_T, (trx) => taxSettingsOf(trx, c, AS_OF))).toBeNull();
    expect((await withTenant(f.db, OTHER_T, (trx) => invoiceSettingsOf(trx, c))).brandColour).toBe(
      null,
    );
    await expect(
      withTenant(f.db, OTHER_T, (trx) =>
        setTaxSettings(trx, {
          companyId: c,
          effectiveFrom: '2027-07-01',
          gstBasis: 'cash',
          basFrequency: 'monthly',
        }),
      ),
    ).rejects.toThrow();
    expect((await f.inTenant((trx) => taxSettingsOf(trx, c, '2027-08-01')))?.basFrequency).toBe(
      'annual',
    );
  });

  it('SS-PLAT-121 step 10 asks for nothing beyond the users and the saved SoD thresholds (RQ-0153 Q4) [T-0158]', async () => {
    expect(await missing(10)).toEqual([
      'Approval thresholds (segregation-of-duties settings) have not been saved',
    ]);
    // Only the Owner may save SoD settings (settings.sod.manage).
    const owner = await f.addUser('owner');
    await f.inTenant((trx) =>
      sql`INSERT INTO app.sod_settings (set_by, reason) VALUES (${owner}, 'Defaults confirmed')`.execute(
        trx,
      ),
    );
    expect(await missing(10)).toEqual([]);
  });
});
