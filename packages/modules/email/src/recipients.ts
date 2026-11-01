/**
 * Recipient resolution from contact roles (T-0042, ADR-0046 rule 2). Active roles on active
 * contacts with an email address only; addresses are de-duplicated and sorted.
 */
import type { Database } from '@ledgerforce/db';
import { sql, type Transaction } from 'kysely';

export type EmailPurpose = 'invoice' | 'statement' | 'reminder' | 'remittance';

export interface Recipients {
  readonly to: readonly string[];
  readonly cc: readonly string[];
}

const ROLES: Record<
  EmailPurpose,
  { to: readonly string[]; fallback: readonly string[]; cc: readonly string[] }
> = {
  invoice: { to: ['billing_to'], fallback: [], cc: ['billing_cc'] },
  reminder: { to: ['billing_to'], fallback: [], cc: ['billing_cc'] },
  statement: { to: ['statements'], fallback: ['billing_to'], cc: ['billing_cc'] },
  remittance: { to: ['remittance'], fallback: [], cc: [] },
};

async function emailsFor(
  trx: Transaction<Database>,
  companyId: string,
  partyId: string,
  roles: readonly string[],
): Promise<string[]> {
  if (roles.length === 0) return [];
  const r = await sql<{ email: string }>`
    SELECT DISTINCT lower(c.email) AS email
      FROM app.party_contact_role r
      JOIN app.party_contact c ON c.tenant_id = r.tenant_id AND c.id = r.contact_id
     WHERE r.company_id = ${companyId} AND r.party_id = ${partyId}::uuid
       AND r.role = ANY(${sql.val([...roles])}::text[]) AND r.active
       AND c.status = 'active' AND c.email IS NOT NULL
     ORDER BY 1`.execute(trx);
  return r.rows.map((x) => x.email);
}

export async function resolveRecipients(
  trx: Transaction<Database>,
  companyId: string,
  partyId: string,
  purpose: EmailPurpose,
): Promise<Recipients> {
  const rule = ROLES[purpose];
  let to = await emailsFor(trx, companyId, partyId, rule.to);
  if (to.length === 0) to = await emailsFor(trx, companyId, partyId, rule.fallback);
  if (to.length === 0) return { to: [], cc: [] };
  const cc = (await emailsFor(trx, companyId, partyId, rule.cc)).filter((e) => !to.includes(e));
  return { to, cc };
}
