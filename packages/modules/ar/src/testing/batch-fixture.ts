/**
 * Test helper (T-0043/T-0044): a company with tax codes, posting profiles, number series and N
 * billable customers — each with a Billing To (and optionally a Billing CC) contact and billing
 * lines on the given bill date. Test-only; runs through the public module functions.
 */
import { auServicesSmb } from '@ledgerforce/gl';
import { entrySeriesFor, SOURCE_TYPES } from '@ledgerforce/ledger';
import type { LedgerFixture } from '@ledgerforce/ledger/testing';
import { seedPostingProfiles, setPartyProfiles, type SeededProfiles } from '@ledgerforce/products';
import { seedTaxCodes } from '@ledgerforce/tax';
import { addBillingLine } from '../batch.ts';
import { INVOICE_NUMBER_SERIES } from '../invoices.ts';

export async function seedBillingCompany(f: LedgerFixture): Promise<SeededProfiles> {
  return f.inTenant(async (trx) => {
    const series = [...new Set(Object.keys(SOURCE_TYPES).map((s) => entrySeriesFor(s)))];
    for (const [i, code] of series.entries()) {
      await trx
        .insertInto('app.number_series')
        .values({ company_id: f.companyId, code, prefix: `J${String(i)}-` })
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
    await trx
      .insertInto('app.number_series')
      .values({ company_id: f.companyId, code: INVOICE_NUMBER_SERIES, prefix: 'INV-' })
      .onConflict((oc) => oc.doNothing())
      .execute();
    await seedTaxCodes(trx, f.companyId);
    return seedPostingProfiles(trx, f.companyId, auServicesSmb, new Map(Object.entries(f.acct)));
  });
}

/** N customers named "<prefix> NN Pty Ltd", each with lines billed on `billDate`. */
export async function seedBillableCustomers(
  f: LedgerFixture,
  profiles: SeededProfiles,
  o: { count: number; prefix: string; billDate: string; withCc?: boolean },
): Promise<string[]> {
  const ids: string[] = [];
  await f.inTenant(async (trx) => {
    for (let i = 1; i <= o.count; i++) {
      const tag = `${o.prefix.toLowerCase().replace(/[^a-z0-9]/g, '')}${String(i)}`;
      const p = await trx
        .insertInto('app.party')
        .values({
          company_id: f.companyId,
          legal_name: `${o.prefix} ${String(i).padStart(2, '0')} Pty Ltd`,
          status: 'active',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('app.party_role')
        .values({ company_id: f.companyId, party_id: p.id, role: 'customer' })
        .execute();
      await setPartyProfiles(trx, f.companyId, p.id, {
        customerProfileId: profiles.partyProfiles.get('DOMESTIC_CUSTOMER') ?? '',
      });
      for (const [role, mailbox] of [
        ['billing_to', 'ap'],
        ...(o.withCc ? [['billing_cc', 'cfo'] as const] : []),
      ] as const) {
        const c = await trx
          .insertInto('app.party_contact')
          .values({
            company_id: f.companyId,
            party_id: p.id,
            name: `${mailbox} ${tag}`,
            email: `${mailbox}@${tag}.example`,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('app.party_contact_role')
          .values({ company_id: f.companyId, party_id: p.id, contact_id: c.id, role })
          .execute();
      }
      await addBillingLine(trx, f.companyId, {
        partyId: p.id,
        productProfileId: profiles.productProfiles.get('SUBSCRIPTION') ?? '',
        description: `Subscription ${o.billDate.slice(0, 7)}`,
        quantity: '1',
        unitPrice: '250.00',
        billDate: o.billDate,
      });
      if (i % 2 === 0) {
        await addBillingLine(trx, f.companyId, {
          partyId: p.id,
          productProfileId: profiles.productProfiles.get('PROFESSIONAL_SERVICES') ?? '',
          description: 'Support hours',
          quantity: '2',
          unitPrice: '150.00',
          billDate: o.billDate,
        });
      }
      ids.push(p.id);
    }
  });
  return ids;
}
