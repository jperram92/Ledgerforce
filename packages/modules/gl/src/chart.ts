/**
 * Loading a chart template into a company (design §3.2). Runs inside the caller's tenant
 * transaction (withTenant), so RLS stamps tenant_id and every insert is checked by the
 * migration 0005 triggers. Refuses an invalid template before writing anything.
 */
import type { Database } from '@ledgerforce/db';
import type { Transaction } from 'kysely';
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
