/**
 * Loading a chart template into a company (design §3.2). Runs inside the caller's tenant
 * transaction (withTenant), so RLS stamps tenant_id and every insert is checked by the
 * migration 0005 triggers. Refuses an invalid template before writing anything.
 */
import type { Database } from '@ledgerforce/db';
import { sql, type Transaction } from 'kysely';
import { validateTemplate, type ChartTemplate } from './templates.ts';

export class InvalidTemplateError extends Error {
  readonly problems: readonly string[];
  constructor(id: string, problems: string[]) {
    super(`chart template ${id} is invalid:\n- ${problems.join('\n- ')}`);
    this.name = 'InvalidTemplateError';
    this.problems = problems;
  }
}

export interface LoadedChart {
  /** account code → account id */
  accounts: Map<string, string>;
  suggestedSettings: Record<string, string>;
}

export async function loadChartTemplate(
  trx: Transaction<Database>,
  companyId: string,
  template: ChartTemplate,
): Promise<LoadedChart> {
  const problems = validateTemplate(template);
  if (problems.length > 0) throw new InvalidTemplateError(template.id, problems);

  const rows = await trx
    .insertInto('app.account')
    .values(
      template.accounts.map((a) => ({
        company_id: companyId,
        code: a.code,
        name: a.name,
        type: a.type,
        subtype: a.subtype,
        normal_balance: a.normalBalance,
        currency: null,
        postable: a.postable,
        is_control: a.control,
        default_tax_code: a.defaultTaxCode ?? null,
      })),
    )
    .returning(['id', 'code'])
    .execute();
  const accounts = new Map(rows.map((r) => [r.code, r.id]));

  const bindings = template.accounts.flatMap((a) => {
    const id = accounts.get(a.code);
    return a.systemRole && id
      ? [{ company_id: companyId, role: a.systemRole, account_id: id }]
      : [];
  });
  await trx.insertInto('app.account_system_role').values(bindings).execute();
  return { accounts, suggestedSettings: { ...template.suggestedSettings } };
}

export interface ChartCompany {
  id: string;
  name: string;
  base_currency: string;
}

export interface ChartAccount {
  id: string;
  company_id: string;
  code: string;
  name: string;
  type: string;
  subtype: string;
  normal_balance: string;
  currency: string | null;
  postable: boolean;
  is_control: boolean;
  status: string;
  /** System roles bound to this account (AR_CONTROL, GST_COLLECTED …), sorted. */
  system_roles: string[];
}

/**
 * The tenant's companies and their charts, in company-name then code order (T-0082). Reads only;
 * RLS limits both to the caller's tenant.
 */
export async function listChart(
  trx: Transaction<Database>,
): Promise<{ companies: ChartCompany[]; accounts: ChartAccount[] }> {
  const companies = await trx
    .selectFrom('app.company')
    .select(['id', 'name', 'base_currency'])
    .orderBy('name')
    .orderBy('id')
    .execute();
  const r = await sql<ChartAccount>`
    SELECT a.id::text, a.company_id::text, a.code, a.name, a.type, a.subtype, a.normal_balance,
           a.currency::text AS currency, a.postable, a.is_control, a.status,
           coalesce((SELECT array_agg(r.role ORDER BY r.role) FROM app.account_system_role r
                      WHERE r.tenant_id = a.tenant_id AND r.company_id = a.company_id
                        AND r.account_id = a.id), '{}'::text[]) AS system_roles
      FROM app.account a
      JOIN app.company c ON c.id = a.company_id
     ORDER BY c.name, c.id, a.code`.execute(trx);
  return { companies, accounts: r.rows };
}
