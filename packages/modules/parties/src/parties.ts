/**
 * Party service (design §4.2): create parties with roles and addresses, add contacts, assign
 * contact roles, and answer the Billing To rule that invoice approval (T-0040) and batch
 * billing (T-0044) call. Runs inside the caller's tenant transaction; the database enforces
 * the same rules (migration 0011), this layer gives clear errors and normalises input.
 */
import type { ContactRole, Database, PartyRole } from '@ledgerforce/db';
import type { Transaction } from 'kysely';
import { normaliseAbn, toSalesforceId18 } from './identifiers.ts';

export class PartyValidationError extends Error {
  readonly problems: readonly string[];
  constructor(problems: string[]) {
    super(`party is invalid:\n- ${problems.join('\n- ')}`);
    this.name = 'PartyValidationError';
    this.problems = problems;
  }
}

export interface AddressInput {
  kind: 'billing' | 'shipping';
  line1: string;
  line2?: string;
  city?: string;
  state?: string;
  postcode?: string;
  country?: string;
}

export interface PartyInput {
  legalName: string;
  tradingName?: string;
  abn?: string;
  roles: PartyRole[];
  deliveryPreference?: 'email' | 'peppol' | 'post';
  salesforceAccountId?: string;
  currency?: string;
  addresses?: AddressInput[];
}

export interface ContactInput {
  name: string;
  email?: string;
  phone?: string;
  salesforceContactId?: string;
}

/** Collect every problem in one error rather than failing on the first. */
function validateParty(input: PartyInput): { abn: string | null; sfId: string | null } {
  const problems: string[] = [];
  if (!input.legalName.trim()) problems.push('legal name is required');
  if (input.roles.length === 0)
    problems.push('at least one role (customer, supplier, employee) is required');
  if (new Set(input.roles).size !== input.roles.length) problems.push('roles must not repeat');
  let abn: string | null = null;
  if (input.abn !== undefined && input.abn.trim() !== '') {
    try {
      abn = normaliseAbn(input.abn);
    } catch (error) {
      problems.push((error as Error).message);
    }
  }
  if (input.deliveryPreference === 'peppol' && abn === null) {
    problems.push('Peppol delivery needs a valid ABN (participant ID 0151:<ABN>)');
  }
  let sfId: string | null = null;
  if (input.salesforceAccountId !== undefined) {
    try {
      sfId = toSalesforceId18(input.salesforceAccountId);
    } catch (error) {
      problems.push((error as Error).message);
    }
  }
  const kinds = (input.addresses ?? []).map((a) => a.kind);
  if (new Set(kinds).size !== kinds.length)
    problems.push('at most one billing and one shipping address');
  if (problems.length > 0) throw new PartyValidationError(problems);
  return { abn, sfId };
}

export async function createParty(
  trx: Transaction<Database>,
  companyId: string,
  input: PartyInput,
): Promise<string> {
  const { abn, sfId } = validateParty(input);
  const party = await trx
    .insertInto('app.party')
    .values({
      company_id: companyId,
      legal_name: input.legalName.trim(),
      trading_name: input.tradingName?.trim() ?? null,
      abn,
      currency: input.currency ?? null,
      delivery_preference: input.deliveryPreference ?? 'email',
      salesforce_account_id: sfId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await trx
    .insertInto('app.party_role')
    .values(input.roles.map((role) => ({ company_id: companyId, party_id: party.id, role })))
    .execute();
  const addresses = input.addresses ?? [];
  if (addresses.length > 0) {
    await trx
      .insertInto('app.party_address')
      .values(
        addresses.map((a) => ({
          company_id: companyId,
          party_id: party.id,
          kind: a.kind,
          line1: a.line1,
          line2: a.line2 ?? null,
          city: a.city ?? null,
          state: a.state ?? null,
          postcode: a.postcode ?? null,
          country: a.country ?? 'AU',
        })),
      )
      .execute();
  }
  return party.id;
}

export async function addContact(
  trx: Transaction<Database>,
  companyId: string,
  partyId: string,
  input: ContactInput,
): Promise<string> {
  const row = await trx
    .insertInto('app.party_contact')
    .values({
      company_id: companyId,
      party_id: partyId,
      name: input.name.trim(),
      email: input.email?.trim() ?? null,
      phone: input.phone ?? null,
      salesforce_contact_id:
        input.salesforceContactId === undefined
          ? null
          : toSalesforceId18(input.salesforceContactId),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** Give or take a contact role. Roles are deactivated, never deleted. */
export async function setContactRole(
  trx: Transaction<Database>,
  contactId: string,
  role: ContactRole,
  active: boolean,
): Promise<void> {
  const contact = await trx
    .selectFrom('app.party_contact')
    .select(['company_id', 'party_id'])
    .where('id', '=', contactId)
    .executeTakeFirstOrThrow();
  await trx
    .insertInto('app.party_contact_role')
    .values({
      company_id: contact.company_id,
      party_id: contact.party_id,
      contact_id: contactId,
      role,
      active,
    })
    .onConflict((oc) => oc.columns(['tenant_id', 'contact_id', 'role']).doUpdateSet({ active }))
    .execute();
}

export type ApprovalBlocker = 'party_archived' | 'not_a_customer' | 'no_billing_to_contact';

/**
 * Why an invoice for this party cannot be approved (design §4.2: "an invoice cannot be
 * approved for a customer with no Billing To contact"). [] means no party-side blocker.
 */
export async function invoiceApprovalBlockers(
  trx: Transaction<Database>,
  partyId: string,
): Promise<ApprovalBlocker[]> {
  const party = await trx
    .selectFrom('app.party')
    .select('status')
    .where('id', '=', partyId)
    .executeTakeFirstOrThrow();
  const customer = await trx
    .selectFrom('app.party_role')
    .select('role')
    .where('party_id', '=', partyId)
    .where('role', '=', 'customer')
    .where('active', '=', true)
    .executeTakeFirst();
  const recipients = await billingRecipients(trx, partyId);
  const blockers: ApprovalBlocker[] = [];
  if (party.status !== 'active') blockers.push('party_archived');
  if (!customer) blockers.push('not_a_customer');
  if (recipients.to.length === 0) blockers.push('no_billing_to_contact');
  return blockers;
}

/** Invoice email recipients: active Billing To contacts in To, Billing CC in CC (with email). */
export async function billingRecipients(
  trx: Transaction<Database>,
  partyId: string,
): Promise<{ to: string[]; cc: string[] }> {
  const rows = await trx
    .selectFrom('app.party_contact_role as r')
    .innerJoin('app.party_contact as c', (j) =>
      j.onRef('c.tenant_id', '=', 'r.tenant_id').onRef('c.id', '=', 'r.contact_id'),
    )
    .select(['r.role', 'c.email'])
    .where('r.party_id', '=', partyId)
    .where('r.active', '=', true)
    .where('c.status', '=', 'active')
    .where('c.email', 'is not', null)
    .where('r.role', 'in', ['billing_to', 'billing_cc'])
    .execute();
  const pick = (role: ContactRole) =>
    [...new Set(rows.filter((r) => r.role === role).map((r) => r.email ?? ''))].sort();
  return { to: pick('billing_to'), cc: pick('billing_cc') };
}
