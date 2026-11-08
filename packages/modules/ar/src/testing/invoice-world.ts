/**
 * Test-only setup for sales invoices (T-0040): loads the AU GST codes and the AU services SMB
 * posting profiles into a company that already has the AU chart (createLedgerFixture or the
 * golden world), adds the two products of GP-001, the invoice and journal number series, and
 * customers with or without a Billing To contact. Runs inside the caller's tenant transaction.
 */
import type { Database } from '@ledgerforce/db';
import { addContact, createParty, setContactRole } from '@ledgerforce/parties';
import {
  createProduct,
  loadPostingProfileTemplate,
  auServicesSmbProfiles,
} from '@ledgerforce/products';
import { auTaxCodes, loadTaxCodes } from '@ledgerforce/tax';
import { sql, type Transaction } from 'kysely';

type Trx = Transaction<Database>;

export interface InvoiceWorld {
  /** Product ids by profile code: PROFESSIONAL_SERVICES, SUBSCRIPTION. */
  products: Record<'PROFESSIONAL_SERVICES' | 'SUBSCRIPTION', string>;
}

export async function setupInvoicing(trx: Trx, companyId: string): Promise<InvoiceWorld> {
  await loadTaxCodes(trx, companyId, auTaxCodes);
  await loadPostingProfileTemplate(trx, companyId, auServicesSmbProfiles);
  const ps = await createProduct(trx, {
    companyId,
    name: 'Professional services',
    code: 'PS',
    productPostingProfileCode: 'PROFESSIONAL_SERVICES',
  });
  const sub = await createProduct(trx, {
    companyId,
    name: 'Subscription',
    code: 'SUB',
    productPostingProfileCode: 'SUBSCRIPTION',
  });
  // The golden world already numbers je_ar_invoice; keep its series when present.
  await sql`
    INSERT INTO app.number_series (company_id, code, prefix)
    VALUES (${companyId}, 'ar_invoice', 'INV-'), (${companyId}, 'je_ar_invoice', 'ARJ-')
    ON CONFLICT DO NOTHING`.execute(trx);
  return { products: { PROFESSIONAL_SERVICES: ps.id, SUBSCRIPTION: sub.id } };
}

/** Give a party the DOMESTIC_CUSTOMER profile (or `profile`) and the customer role. */
export async function makeCustomer(
  trx: Trx,
  companyId: string,
  partyId: string,
  profile = 'DOMESTIC_CUSTOMER',
): Promise<void> {
  await sql`
    UPDATE app.party SET customer_posting_profile_id = (
      SELECT id FROM app.party_posting_profile WHERE company_id = ${companyId} AND code = ${profile})
     WHERE id = ${partyId}`.execute(trx);
  await sql`
    INSERT INTO app.party_role (company_id, party_id, role) VALUES (${companyId}, ${partyId}, 'customer')
    ON CONFLICT DO NOTHING`.execute(trx);
}

/** A Billing To contact with an email (design §4.2). Returns the contact id. */
export async function addBillingTo(
  trx: Trx,
  companyId: string,
  partyId: string,
  email = 'accounts@acme.example',
): Promise<string> {
  const contactId = await addContact(trx, companyId, partyId, { name: 'Accounts', email });
  await setContactRole(trx, contactId, 'billing_to', true);
  return contactId;
}

/** A new customer; with a Billing To contact unless `billingTo` is false. */
export async function newCustomer(
  trx: Trx,
  companyId: string,
  opts: { name: string; billingTo?: boolean; profile?: string },
): Promise<{ partyId: string; contactId: string | null }> {
  const partyId = await createParty(trx, companyId, { legalName: opts.name, roles: ['customer'] });
  await makeCustomer(trx, companyId, partyId, opts.profile);
  const contactId = opts.billingTo === false ? null : await addBillingTo(trx, companyId, partyId);
  return { partyId, contactId };
}
