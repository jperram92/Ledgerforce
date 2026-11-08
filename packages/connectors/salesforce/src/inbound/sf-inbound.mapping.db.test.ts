/**
 * T-0065 — Account / Contact / Product2 → party, party contact, product (design §4.2, §4.4, §5.5,
 * ADR-0006; RQ-0098; migrations 0011, 0032, 0034). Runs as lf_app in tenant transactions.
 *
 * SS-UC01-12: mapping and field ownership (Salesforce-owned fields only; LedgerForce-owned fields
 * are never overwritten). SS-UC01-14: unmapped picklist values and validation failures raise
 * inbound sync issues — never silently dropped — without blocking the channel.
 */
import { billingRecipients, invoiceApprovalBlockers } from '@ledgerforce/parties';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cdc1, startInboundWorld, type InboundWorld } from '../testing/inbound-world.ts';
import { sfId } from '../testing/master-data-events.ts';
import { applyInboundChange, getRecordSync, listInboundIssues } from './apply.ts';

const T = '01900000-0000-7000-8000-0000000065b1';
let w: InboundWorld;
let commit = 10_000n;
const next = () => (commit += 1n);

const createAccount = (n: number, fields: Record<string, unknown>) =>
  cdc1({
    entity: 'Account',
    recordIds: [sfId('001', n)],
    changeType: 'CREATE',
    commitNumber: next(),
    fields,
  });
const updateAccount = (
  n: number,
  fields: Record<string, unknown>,
  changed: string[],
  nulled: string[] = [],
) =>
  cdc1({
    entity: 'Account',
    recordIds: [sfId('001', n)],
    changeType: 'UPDATE',
    commitNumber: next(),
    fields,
    changed,
    nulled,
  });

const party = (sfAccountId: string) =>
  w.inTenant((trx) =>
    trx
      .selectFrom('app.party as p')
      .leftJoin('app.party_posting_profile as c', 'c.id', 'p.customer_posting_profile_id')
      .leftJoin('app.party_posting_profile as s', 's.id', 'p.supplier_posting_profile_id')
      .select([
        'p.id',
        'p.legal_name',
        'p.abn',
        'p.currency',
        'p.status',
        'p.credit_limit',
        'p.delivery_preference',
        'p.tax_status',
        'c.code as customer_profile',
        's.code as supplier_profile',
      ])
      .where('p.company_id', '=', w.companyId)
      .where('p.salesforce_account_id', '=', sfAccountId)
      .executeTakeFirst(),
  );
const roles = (partyId: string) =>
  w.inTenant((trx) =>
    trx
      .selectFrom('app.party_role')
      .select(['role', 'active'])
      .where('party_id', '=', partyId)
      .orderBy('role')
      .execute(),
  );
const addresses = (partyId: string) =>
  w.inTenant((trx) =>
    trx
      .selectFrom('app.party_address')
      .select(['kind', 'line1', 'line2', 'city', 'state', 'postcode', 'country'])
      .where('party_id', '=', partyId)
      .orderBy('kind')
      .execute(),
  );
const issuesFor = async (recordId: string) =>
  (await w.inTenant((trx) => listInboundIssues(trx, w.companyId))).filter(
    (i) => i.recordId === recordId,
  );

beforeAll(async () => {
  w = await startInboundWorld(T);
  // A supplier-kind mapping next to the template's customer ones.
  await w.inTenant(async (trx) => {
    const p = await trx
      .selectFrom('app.party_posting_profile')
      .select('id')
      .where('company_id', '=', w.companyId)
      .where('code', '=', 'DOMESTIC_SUPPLIER')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('app.party_profile_mapping')
      .values({
        company_id: w.companyId,
        sf_field: 'Type',
        sf_value: 'Vendor',
        party_posting_profile_id: p.id,
      })
      .execute();
  });
});

afterAll(async () => {
  await w.close();
});

describe('SS-UC01-12: Salesforce Account, Contact and Product2 map onto parties and products [T-0065]', () => {
  it('Account → customer party with the Type-mapped profile, ABN, currency and addresses', async () => {
    const ACC = sfId('001', 1);
    const r = await w.apply(
      createAccount(1, {
        Name: 'Harbour Freight Pty Ltd',
        Type: 'Customer - Direct',
        BillingAddress: {
          Street: '1 George St\nLevel 2',
          City: 'Sydney',
          State: 'NSW',
          PostalCode: '2000',
          CountryCode: 'AU',
        },
        ShippingAddress: { Street: '9 Wharf Rd', City: 'Botany', CountryCode: 'AU' },
        CurrencyIsoCode: 'AUD',
        LF_ABN__c: '51 824 753 556',
      }),
    );
    expect(r).toMatchObject({ outcome: 'applied', problems: [] });
    const p = await party(ACC);
    expect(p).toMatchObject({
      id: r.entityId,
      legal_name: 'Harbour Freight Pty Ltd',
      abn: '51824753556',
      currency: 'AUD',
      status: 'active',
      customer_profile: 'DOMESTIC_CUSTOMER',
      supplier_profile: null,
    });
    expect(await roles(p?.id ?? '')).toEqual([{ role: 'customer', active: true }]);
    expect(await addresses(p?.id ?? '')).toEqual([
      {
        kind: 'billing',
        line1: '1 George St',
        line2: 'Level 2',
        city: 'Sydney',
        state: 'NSW',
        postcode: '2000',
        country: 'AU',
      },
      {
        kind: 'shipping',
        line1: '9 Wharf Rd',
        line2: null,
        city: 'Botany',
        state: null,
        postcode: null,
        country: 'AU',
      },
    ]);
  });

  it('a partial UPDATE changes only what Salesforce changed; LedgerForce-owned fields are kept', async () => {
    const ACC = sfId('001', 1);
    const before = await party(ACC);
    await w.inTenant((trx) =>
      trx
        .updateTable('app.party')
        .set({ credit_limit: '5000.0000', delivery_preference: 'post', tax_status: 'registered' })
        .where('id', '=', before?.id ?? '')
        .execute(),
    );
    const r = await w.apply(
      updateAccount(1, { BillingAddress: { City: 'Parramatta' } }, ['BillingAddress.City']),
    );
    expect(r.outcome).toBe('applied');
    expect(await party(ACC)).toMatchObject({
      legal_name: 'Harbour Freight Pty Ltd',
      abn: '51824753556',
      credit_limit: '5000.0000',
      delivery_preference: 'post',
      tax_status: 'registered',
      customer_profile: 'DOMESTIC_CUSTOMER',
    });
    expect((await addresses(before?.id ?? ''))[0]).toMatchObject({
      line1: '1 George St',
      city: 'Parramatta',
      postcode: '2000',
    });
  });

  it('a party created in LedgerForce with the Account Id is linked, not duplicated', async () => {
    const ACC = sfId('001', 2);
    const id = await w.inTenant(async (trx) => {
      const p = await trx
        .insertInto('app.party')
        .values({
          company_id: w.companyId,
          legal_name: 'Typed by hand',
          salesforce_account_id: ACC,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return p.id;
    });
    const r = await w.apply(
      createAccount(2, { Name: 'Balmain Tiles', Type: 'Customer - Channel' }),
    );
    expect(r.entityId).toBe(id);
    expect(await party(ACC)).toMatchObject({ id, legal_name: 'Balmain Tiles' });
  });

  it('a Type mapped to a supplier profile adds the supplier role and moves the profile', async () => {
    const ACC = sfId('001', 1);
    await w.apply(updateAccount(1, { Type: 'Vendor' }, ['Type']));
    const p = await party(ACC);
    expect(p).toMatchObject({ customer_profile: null, supplier_profile: 'DOMESTIC_SUPPLIER' });
    expect(await roles(p?.id ?? '')).toEqual([
      { role: 'customer', active: true },
      { role: 'supplier', active: true },
    ]);
    await w.apply(updateAccount(1, { Type: 'Customer - Direct' }, ['Type']));
    expect(await party(ACC)).toMatchObject({
      customer_profile: 'DOMESTIC_CUSTOMER',
      supplier_profile: null,
    });
  });

  it('Contact → party contact with billing roles; a removed role is deactivated, never deleted', async () => {
    const ACC = sfId('001', 1);
    const CON = sfId('003', 1);
    const created = await w.apply(
      cdc1({
        entity: 'Contact',
        recordIds: [CON],
        changeType: 'CREATE',
        commitNumber: next(),
        fields: {
          AccountId: ACC,
          Name: { Salutation: 'Ms', FirstName: 'Priya', LastName: 'Shah' },
          Email: 'ap@harbour.example',
          Phone: '+61 2 9000 0000',
          LF_Billing_Role__c: 'Billing To;Billing CC',
        },
      }),
    );
    expect(created).toMatchObject({ outcome: 'applied', problems: [] });
    const partyId = (await party(ACC))?.id ?? '';
    const contact = await w.inTenant((trx) =>
      trx
        .selectFrom('app.party_contact')
        .select(['id', 'party_id', 'name', 'email', 'phone', 'status'])
        .where('salesforce_contact_id', '=', CON)
        .executeTakeFirstOrThrow(),
    );
    expect(contact).toEqual({
      id: created.entityId,
      party_id: partyId,
      name: 'Priya Shah',
      email: 'ap@harbour.example',
      phone: '+61 2 9000 0000',
      status: 'active',
    });
    expect(await w.inTenant((trx) => billingRecipients(trx, partyId))).toEqual({
      to: ['ap@harbour.example'],
      cc: ['ap@harbour.example'],
    });
    expect(await w.inTenant((trx) => invoiceApprovalBlockers(trx, partyId))).toEqual([]);

    await w.apply(
      cdc1({
        entity: 'Contact',
        recordIds: [CON],
        changeType: 'UPDATE',
        commitNumber: next(),
        fields: { LF_Billing_Role__c: 'Billing To' },
        changed: ['LF_Billing_Role__c'],
      }),
    );
    const contactRoles = await w.inTenant((trx) =>
      trx
        .selectFrom('app.party_contact_role')
        .select(['role', 'active'])
        .where('contact_id', '=', contact.id)
        .orderBy('role')
        .execute(),
    );
    expect(contactRoles).toEqual([
      { role: 'billing_cc', active: false },
      { role: 'billing_to', active: true },
    ]);
  });

  it('Product2 → product with the Family-mapped profile, code, tax code; IsActive false archives', async () => {
    const PRD = sfId('01t', 1);
    const r = await w.apply(
      cdc1({
        entity: 'Product2',
        recordIds: [PRD],
        changeType: 'CREATE',
        commitNumber: next(),
        fields: {
          Name: 'Onboarding',
          ProductCode: 'ONB-01',
          Description: 'Fixed-fee onboarding',
          Family: 'Professional Services',
          IsActive: true,
          LF_Tax_Code__c: 'GST',
        },
      }),
    );
    expect(r).toMatchObject({ outcome: 'applied', problems: [] });
    const product = () =>
      w.inTenant((trx) =>
        trx
          .selectFrom('app.product as p')
          .leftJoin('app.product_posting_profile as pp', 'pp.id', 'p.product_posting_profile_id')
          .select([
            'p.id',
            'p.name',
            'p.code',
            'p.description',
            'p.default_tax_code',
            'p.salesforce_family',
            'p.status',
            'pp.code as profile',
          ])
          .where('p.salesforce_product_id', '=', PRD)
          .executeTakeFirstOrThrow(),
      );
    expect(await product()).toEqual({
      id: r.entityId,
      name: 'Onboarding',
      code: 'ONB-01',
      description: 'Fixed-fee onboarding',
      default_tax_code: 'GST',
      salesforce_family: 'Professional Services',
      status: 'active',
      profile: 'PROFESSIONAL_SERVICES',
    });
    await w.apply(
      cdc1({
        entity: 'Product2',
        recordIds: [PRD],
        changeType: 'UPDATE',
        commitNumber: next(),
        fields: { IsActive: false },
        changed: ['IsActive'],
      }),
    );
    expect(await product()).toMatchObject({ status: 'archived', name: 'Onboarding' });
  });
});

describe('SS-UC01-14: unmapped values and validation failures raise sync issues [T-0065]', () => {
  it('an unmapped Account.Type imports the party without a profile and raises one issue until mapped', async () => {
    const ACC = sfId('001', 20);
    const r = await w.apply(createAccount(20, { Name: 'Prospect Hill Pty Ltd', Type: 'Prospect' }));
    expect(r.outcome).toBe('applied');
    expect(await party(ACC)).toMatchObject({ customer_profile: null, supplier_profile: null });
    await w.apply(updateAccount(20, { Name: 'Prospect Hill Group' }, ['Name']));
    const [issue, ...more] = await issuesFor(ACC);
    expect(more).toEqual([]);
    expect(issue).toMatchObject({
      entity: 'Account',
      code: 'unmapped_value',
      field: 'Type',
      value: 'Prospect',
      blocking: false,
      status: 'open',
      occurrences: 2,
      payload: expect.objectContaining({ Name: 'Prospect Hill Group', Type: 'Prospect' }) as object,
    });
    expect(issue?.message).toMatch(/Prospect/);

    // The admin maps the value; the next change of the record resolves the issue.
    await w.inTenant(async (trx) => {
      const p = await trx
        .selectFrom('app.party_posting_profile')
        .select('id')
        .where('company_id', '=', w.companyId)
        .where('code', '=', 'DOMESTIC_CUSTOMER')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('app.party_profile_mapping')
        .values({
          company_id: w.companyId,
          sf_field: 'Type',
          sf_value: 'Prospect',
          party_posting_profile_id: p.id,
        })
        .execute();
    });
    await w.apply(updateAccount(20, { Name: 'Prospect Hill Group Pty Ltd' }, ['Name']));
    expect(await party(ACC)).toMatchObject({ customer_profile: 'DOMESTIC_CUSTOMER' });
    expect((await issuesFor(ACC)).map((i) => i.status)).toEqual(['resolved']);
  });

  it('an invalid ABN rejects the record with a blocking issue; the fixing UPDATE applies it', async () => {
    const ACC = sfId('001', 21);
    const r = await w.apply(
      createAccount(21, {
        Name: 'Checksum Fail Pty Ltd',
        Type: 'Customer - Direct',
        LF_ABN__c: '51 824 753 557',
      }),
    );
    expect(r).toMatchObject({ outcome: 'rejected', entityId: null });
    expect(await party(ACC)).toBeUndefined();
    expect(await issuesFor(ACC)).toEqual([
      expect.objectContaining({
        code: 'invalid_value',
        field: 'LF_ABN__c',
        value: '51 824 753 557',
        blocking: true,
        status: 'open',
        payload: expect.objectContaining({ Name: 'Checksum Fail Pty Ltd' }) as object,
      }),
    ]);
    expect(
      await w.inTenant((trx) => getRecordSync(trx, w.companyId, 'Account', ACC)),
    ).toMatchObject({
      state: 'rejected',
      lfId: null,
    });
    // Only the ABN changes in Salesforce; the name comes from the remembered state.
    const fixed = await w.apply(updateAccount(21, { LF_ABN__c: '51 824 753 556' }, ['LF_ABN__c']));
    expect(fixed.outcome).toBe('applied');
    expect(await party(ACC)).toMatchObject({
      legal_name: 'Checksum Fail Pty Ltd',
      abn: '51824753556',
    });
    expect((await issuesFor(ACC)).map((i) => [i.code, i.status])).toEqual([
      ['invalid_value', 'resolved'],
    ]);
  });

  it('a Contact of an Account that is not synced is a blocking missing_parent issue', async () => {
    const CON = sfId('003', 21);
    const r = await w.apply(
      cdc1({
        entity: 'Contact',
        recordIds: [CON],
        changeType: 'CREATE',
        commitNumber: next(),
        fields: { AccountId: sfId('001', 99), Name: { LastName: 'Orphan' } },
      }),
    );
    expect(r.outcome).toBe('rejected');
    expect(await issuesFor(CON)).toEqual([
      expect.objectContaining({ code: 'missing_parent', field: 'AccountId', blocking: true }),
    ]);
  });

  it('an unknown Family imports the product without a profile; an unknown tax code rejects it', async () => {
    const PRD = sfId('01t', 21);
    const r = await w.apply(
      cdc1({
        entity: 'Product2',
        recordIds: [PRD],
        changeType: 'CREATE',
        commitNumber: next(),
        fields: { Name: 'Mystery box', Family: 'Gadgets', IsActive: true },
      }),
    );
    expect(r.outcome).toBe('applied');
    expect(r.problems.map((p) => [p.code, p.field, p.value])).toEqual([
      ['unmapped_value', 'Family', 'Gadgets'],
    ]);
    const PRD2 = sfId('01t', 22);
    const bad = await w.apply(
      cdc1({
        entity: 'Product2',
        recordIds: [PRD2],
        changeType: 'CREATE',
        commitNumber: next(),
        fields: { Name: 'Taxed oddly', IsActive: true, LF_Tax_Code__c: 'NOPE' },
      }),
    );
    expect(bad.outcome).toBe('rejected');
    expect(await issuesFor(PRD2)).toEqual([
      expect.objectContaining({ code: 'apply_failed', blocking: true, status: 'open' }),
    ]);
  });

  it('a rejected record does not abort the transaction: the next change in it still applies', async () => {
    const BAD = sfId('001', 30);
    const GOOD = sfId('001', 31);
    const outcomes = await w.inTenant(async (trx) => [
      (await applyInboundChange(trx, w.companyId, createAccount(30, { Name: ' ' }))).outcome,
      // The database refuses this one (a supplier-only contact role on a customer).
      (
        await applyInboundChange(
          trx,
          w.companyId,
          cdc1({
            entity: 'Contact',
            recordIds: [sfId('003', 30)],
            changeType: 'CREATE',
            commitNumber: next(),
            fields: {
              AccountId: sfId('001', 2),
              Name: { LastName: 'Remit' },
              LF_Billing_Role__c: 'Remittance',
            },
          }),
        )
      ).outcome,
      (
        await applyInboundChange(
          trx,
          w.companyId,
          createAccount(31, { Name: 'Still Fine Pty Ltd' }),
        )
      ).outcome,
    ]);
    expect(outcomes).toEqual(['rejected', 'rejected', 'applied']);
    expect(await party(BAD)).toBeUndefined();
    expect(await party(GOOD)).toMatchObject({ legal_name: 'Still Fine Pty Ltd' });
    const contactIssue = await issuesFor(sfId('003', 30));
    expect(contactIssue).toEqual([
      expect.objectContaining({ code: 'apply_failed', blocking: true }),
    ]);
    expect(contactIssue[0]?.message).toMatch(/supplier/);
  });

  it('issues are append-only rows: lf_app cannot delete them', async () => {
    await expect(
      w.inTenant((trx) => sql`DELETE FROM app.salesforce_inbound_issue`.execute(trx)),
    ).rejects.toThrow(/permission denied|never/);
  });
});
