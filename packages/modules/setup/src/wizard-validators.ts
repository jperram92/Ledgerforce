/**
 * Setup wizard step validators (T-0123, design §4.1, RQ-0149 conclusion 1, ADR-0067 rule 4).
 *
 * Each validator reads the state its owning module persists — never a copy — and returns what is
 * missing in plain words; [] means the step passes. Module functions are called where the module
 * exports one (profileGaps, openingBalanceOf, listCompanyBankAccounts); otherwise the
 * module's table is read. Settings no module persists yet (GST basis, BAS frequency, branding,
 * payment terms and methods) are added by their modules in T-0158, which extends steps 3, 8, 10.
 */
import { INVOICE_NUMBER_SERIES } from '@ledgerforce/ar';
import { listCompanyBankAccounts } from '@ledgerforce/bank';
import type { Database } from '@ledgerforce/db';
import { CORE_SYSTEM_ROLES } from '@ledgerforce/gl';
import { profileGaps } from '@ledgerforce/products';
import { sql, type Transaction } from 'kysely';
import { openingBalanceOf } from './opening-balances.ts';

type Trx = Transaction<Database>;

export interface StepContext {
  readonly companyId: string;
  /** YYYY-MM-DD: tax codes and posting profiles must be usable on this date. */
  readonly asOf: string;
  /** Step 9 only: the company declared it has no history (a completion record says so). */
  readonly noHistory: boolean;
}

export type StepValidator = (trx: Trx, ctx: StepContext) => Promise<string[]>;

const exists = async (trx: Trx, query: ReturnType<typeof sql<{ x: number }>>) =>
  (await query.execute(trx)).rows.length > 0;

/** 1. Company details, base currency, ABN, fiscal year start (platform + ledger). */
const company: StepValidator = async (trx, { companyId }) => {
  const c = await trx
    .selectFrom('app.company')
    .select(['legal_name', 'abn', 'base_currency'])
    .where('id', '=', companyId)
    .executeTakeFirstOrThrow();
  const out: string[] = [];
  if (!c.legal_name?.trim()) out.push('The legal name is missing');
  // The ABN's format and checksum are enforced by app.company (company_abn_checksum).
  if (!c.abn) out.push('The ABN is missing');
  if (!/^[A-Z]{3}$/.test(c.base_currency)) out.push('The base currency is not an ISO 4217 code');
  const fy = await exists(
    trx,
    sql<{ x: number }>`SELECT 1 AS x FROM app.fiscal_year WHERE company_id = ${companyId} LIMIT 1`,
  );
  if (!fy) out.push('No fiscal year has been set up (fiscal year start)');
  return out;
};

/** 2. Chart of accounts with every core system role bound (gl; ADR-0061 period-end roles later). */
const chart: StepValidator = async (trx, { companyId }) => {
  const out: string[] = [];
  const account = await trx
    .selectFrom('app.account')
    .select('id')
    .where('company_id', '=', companyId)
    .where('status', '=', 'active')
    .limit(1)
    .executeTakeFirst();
  if (!account) out.push('The chart of accounts has no accounts');
  const bound = new Set(
    (
      await trx
        .selectFrom('app.account_role_binding')
        .select('role')
        .where('company_id', '=', companyId)
        .execute()
    ).map((r) => r.role),
  );
  for (const role of CORE_SYSTEM_ROLES) {
    if (!bound.has(role)) out.push(`System role ${role} is not bound to an account`);
  }
  return out;
};

/** 3. Tax codes (tax). GST basis and BAS frequency join in T-0158. */
const tax: StepValidator = async (trx, { companyId, asOf }) => {
  const inForce = await exists(
    trx,
    sql<{ x: number }>`
      SELECT 1 AS x FROM app.tax_code
       WHERE company_id = ${companyId} AND status = 'active'
         AND effective_from <= ${asOf}::date
         AND (effective_to IS NULL OR effective_to >= ${asOf}::date)
       LIMIT 1`,
  );
  return inForce ? [] : [`No tax code is in force on ${asOf}`];
};

/** 4. Bank accounts, one with ABA details for batch payments (bank). */
const bank: StepValidator = async (trx, { companyId }) => {
  const active = (await listCompanyBankAccounts(trx, companyId)).filter(
    (a) => a.status === 'active',
  );
  const out: string[] = [];
  if (active.length === 0) out.push('No bank account has been added');
  if (!active.some((a) => a.apcaUserId && a.abaUserName))
    out.push('No bank account has an APCA user id and ABA user name (batch payments)');
  return out;
};

/** 5. Salesforce connection and the object that triggers invoicing (connector-salesforce). */
const salesforce: StepValidator = async (trx, { companyId }) => {
  const out: string[] = [];
  const connection = await trx
    .selectFrom('app.salesforce_connection')
    .select('id')
    .where('company_id', '=', companyId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (!connection) out.push('Salesforce is not connected');
  const trigger = await exists(
    trx,
    sql<{
      x: number;
    }>`SELECT 1 AS x FROM app.salesforce_billing_settings WHERE company_id = ${companyId}`,
  );
  if (!trigger)
    out.push(
      'The Salesforce object that triggers invoicing (Opportunity or Order) has not been chosen',
    );
  return out;
};

/** 6. Accounts and products imported from Salesforce (parties, products). */
const imported: StepValidator = async (trx, { companyId }) => {
  const out: string[] = [];
  const party = await trx
    .selectFrom('app.party')
    .select('id')
    .where('company_id', '=', companyId)
    .where('status', '=', 'active')
    .where('salesforce_account_id', 'is not', null)
    .limit(1)
    .executeTakeFirst();
  if (!party) out.push('No customer or supplier has been imported from Salesforce');
  const product = await trx
    .selectFrom('app.product')
    .select('id')
    .where('company_id', '=', companyId)
    .where('status', '=', 'active')
    .where('salesforce_product2_id', 'is not', null)
    .limit(1)
    .executeTakeFirst();
  if (!product) out.push('No product has been imported from Salesforce');
  return out;
};

/** 7. Posting profiles and the gap check (products, design §4.4). */
const profiles: StepValidator = async (trx, { companyId, asOf }) => {
  const out: string[] = [];
  const count = async (table: 'app.party_posting_profile' | 'app.product_posting_profile') =>
    (
      await trx
        .selectFrom(table)
        .select('id')
        .where('company_id', '=', companyId)
        .where('status', '=', 'active')
        .limit(1)
        .execute()
    ).length;
  if ((await count('app.party_posting_profile')) === 0) out.push('No active party posting profile');
  if ((await count('app.product_posting_profile')) === 0)
    out.push('No active product posting profile');
  for (const g of await profileGaps(trx, companyId, asOf)) {
    out.push(
      `Posting-profile gap: ${g.partyProfile} × ${g.productProfile} (${g.purpose}): ${g.message}`,
    );
  }
  return out;
};

/** 8. Invoice numbering and billing formats (ledger series, documents). More in T-0158. */
const numbering: StepValidator = async (trx, { companyId }) => {
  const out: string[] = [];
  const series = await trx
    .selectFrom('app.number_series')
    .select('code')
    .where('company_id', '=', companyId)
    .where('code', '=', INVOICE_NUMBER_SERIES)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (!series) out.push(`No invoice number series (${INVOICE_NUMBER_SERIES}) has been set up`);
  const format = await trx
    .selectFrom('app.billing_format')
    .select('id')
    .where('company_id', '=', companyId)
    .where('status', '=', 'active')
    .limit(1)
    .executeTakeFirst();
  if (!format) out.push('No billing format has been set up');
  return out;
};

/** 9. Opening balances (setup, T-0080) or a recorded no-history declaration. */
const opening: StepValidator = async (trx, { companyId, noHistory }) => {
  if (noHistory || (await openingBalanceOf(trx, companyId))) return [];
  return [
    'No opening balance has been posted, and the company has not declared that it has no history',
  ];
};

/** 10. Users, roles and approval thresholds (auth, SoD settings; tenant-wide). */
const people: StepValidator = async (trx) => {
  const out: string[] = [];
  const admin = await trx
    .selectFrom('app.user_role as r')
    .innerJoin('app.app_user as u', 'u.id', 'r.user_id')
    .select('r.id')
    .where('r.role', 'in', ['owner', 'finance_admin'])
    .where('r.revoked_at', 'is', null)
    .where('u.status', '=', 'active')
    .limit(1)
    .executeTakeFirst();
  if (!admin) out.push('No active user holds the Owner or Finance Admin role');
  const sod = await exists(trx, sql<{ x: number }>`SELECT 1 AS x FROM app.sod_settings LIMIT 1`);
  if (!sod) out.push('Approval thresholds (segregation-of-duties settings) have not been saved');
  return out;
};

export const WIZARD_STEPS: readonly { readonly title: string; readonly validate: StepValidator }[] =
  [
    { title: 'Company details', validate: company },
    { title: 'Chart of accounts', validate: chart },
    { title: 'Tax codes', validate: tax },
    { title: 'Bank accounts', validate: bank },
    { title: 'Connect Salesforce', validate: salesforce },
    { title: 'Import from Salesforce', validate: imported },
    { title: 'Posting profiles', validate: profiles },
    { title: 'Numbering and billing', validate: numbering },
    { title: 'Opening balances', validate: opening },
    { title: 'Users, roles and approvals', validate: people },
  ];

/** The one step that may be completed by declaring there is nothing to set up. */
export const NO_HISTORY_STEP = 9;
