/**
 * SS-PLAT-36 — the party model (T-0036, design §4.2): one Party with several roles, addresses,
 * contacts and contact roles, enforced by the database.
 * SS-PLAT-37 — the Billing To rule: an invoice cannot be approved for a customer with no active
 * Billing To contact; recipients come from the contact roles.
 */
import { createDb, withTenant, type Database } from '@ledgerforce/db';
import { createTestDatabase, type TestDatabase } from '@ledgerforce/db/testing';
import fc from 'fast-check';
import { sql, type Kysely, type Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { abnIsValid } from './identifiers.ts';
import {
  addContact,
  billingRecipients,
  createParty,
  invoiceApprovalBlockers,
  PartyValidationError,
  setContactRole,
} from './parties.ts';

const T = '01900000-0000-7000-8000-0000000009aa';
let tdb: TestDatabase;
let db: Kysely<Database>;
let companyId: string;
const inTenant = <R>(fn: (trx: Transaction<Database>) => Promise<R>) => withTenant(db, T, fn);

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: true });
  db = createDb(tdb.url('lf_app'), 2);
  companyId = await inTenant(async (trx) => {
    await trx.insertInto('app.tenant').values({ id: T, name: 'Harbour & Co Pty Ltd' }).execute();
    const c = await trx
      .insertInto('app.company')
      .values({ name: 'Harbour & Co Pty Ltd', base_currency: 'AUD', abn: '51824753556' })
      .returning('id')
      .executeTakeFirstOrThrow();
    return c.id;
  });
});

afterAll(async () => {
  await db.destroy();
  await tdb.close();
});

describe('SS-PLAT-36: One party with roles, addresses, contacts and contact roles', () => {
  it('one party can be both customer and supplier, with billing and shipping addresses', async () => {
    const id = await inTenant((trx) =>
      createParty(trx, companyId, {
        legalName: 'Northwind Traders Pty Ltd',
        tradingName: 'Northwind',
        abn: '51 824 753 556',
        roles: ['customer', 'supplier'],
        addresses: [
          {
            kind: 'billing',
            line1: '1 George St',
            city: 'Sydney',
            state: 'NSW',
            postcode: '2000',
            country: 'AU',
          },
          {
            kind: 'shipping',
            line1: '9 Dock Rd',
            city: 'Botany',
            state: 'NSW',
            postcode: '2019',
            country: 'AU',
          },
        ],
      }),
    );
    const roles = await inTenant((trx) =>
      trx
        .selectFrom('app.party_role')
        .select('role')
        .where('party_id', '=', id)
        .orderBy('role')
        .execute(),
    );
    expect(roles.map((r) => r.role)).toEqual(['customer', 'supplier']);
    const party = await inTenant((trx) =>
      trx
        .selectFrom('app.party')
        .select(['abn', 'delivery_preference'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
    );
    expect(party).toEqual({ abn: '51824753556', delivery_preference: 'email' });
  });

  it('the database refuses an ABN that fails the checksum, even when written directly', async () => {
    await expect(
      inTenant((trx) =>
        trx
          .insertInto('app.party')
          .values({ company_id: companyId, legal_name: 'Bad ABN Pty Ltd', abn: '51824753557' })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      inTenant((trx) =>
        createParty(trx, companyId, {
          legalName: 'Bad ABN Pty Ltd',
          abn: '51824753557',
          roles: ['customer'],
        }),
      ),
    ).rejects.toBeInstanceOf(PartyValidationError);
  });

  it('property: the SQL ABN check agrees with the TypeScript one, on random and on valid ABNs', async () => {
    const digit = fc.constantFrom(...'0123456789'.split(''));
    const random11 = fc.string({ unit: digit, minLength: 11, maxLength: 11 });
    // A valid ABN: a random 9-digit body with the first 2-digit prefix (10..99) that passes mod 89.
    const valid = fc
      .string({ unit: digit, minLength: 9, maxLength: 9 })
      .map((body) =>
        Array.from({ length: 90 }, (_, i) => `${String(10 + i)}${body}`).find(abnIsValid),
      )
      .filter((abn): abn is string => abn !== undefined);
    let validSeen = 0;
    await fc.assert(
      fc.asyncProperty(fc.oneof(random11, valid), async (abn) => {
        const r = await sql<{ ok: boolean }>`SELECT app.abn_is_valid(${abn}) AS ok`.execute(db);
        if (abnIsValid(abn)) validSeen += 1;
        expect(r.rows[0]?.ok).toBe(abnIsValid(abn));
      }),
      { numRuns: 200 },
    );
    expect(validSeen, 'valid ABNs must be exercised, not only random strings').toBeGreaterThan(50);
  });

  it('Peppol delivery needs an ABN', async () => {
    await expect(
      inTenant((trx) =>
        trx
          .insertInto('app.party')
          .values({
            company_id: companyId,
            legal_name: 'No ABN Ltd',
            delivery_preference: 'peppol',
          })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('the Salesforce Account Id is stored 18-char and is unique per company (15-char input finds the same party)', async () => {
    const id = await inTenant((trx) =>
      createParty(trx, companyId, {
        legalName: 'Contoso Pty Ltd',
        roles: ['customer'],
        salesforceAccountId: '001G000001SUbc4',
      }),
    );
    const row = await inTenant((trx) =>
      trx
        .selectFrom('app.party')
        .select('salesforce_account_id')
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
    );
    expect(row.salesforce_account_id).toHaveLength(18);
    await expect(
      inTenant((trx) =>
        createParty(trx, companyId, {
          legalName: 'Contoso duplicate',
          roles: ['customer'],
          salesforceAccountId: row.salesforce_account_id ?? '',
        }),
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('contact roles follow party roles: remittance needs a supplier, billing roles need a customer', async () => {
    const supplierOnly = await inTenant((trx) =>
      createParty(trx, companyId, { legalName: 'Supplies Co', roles: ['supplier'] }),
    );
    const contact = await inTenant((trx) =>
      addContact(trx, companyId, supplierOnly, {
        name: 'Sam Supplier',
        email: 'sam@supplies.example',
      }),
    );
    await inTenant((trx) => setContactRole(trx, contact, 'remittance', true));
    await expect(
      inTenant((trx) => setContactRole(trx, contact, 'billing_to', true)),
    ).rejects.toThrow(/customer/);
  });

  it("a contact role must name a contact of the same party (no borrowing another party's contact)", async () => {
    const a = await inTenant((trx) =>
      createParty(trx, companyId, { legalName: 'Party A', roles: ['customer'] }),
    );
    const b = await inTenant((trx) =>
      createParty(trx, companyId, { legalName: 'Party B', roles: ['customer'] }),
    );
    const contactOfA = await inTenant((trx) =>
      addContact(trx, companyId, a, { name: 'Ada', email: 'ada@a.example' }),
    );
    await expect(
      inTenant((trx) =>
        trx
          .insertInto('app.party_contact_role')
          .values({
            company_id: companyId,
            party_id: b,
            contact_id: contactOfA,
            role: 'billing_to',
          })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('nothing is deleted: lf_app has no DELETE on any party table', async () => {
    for (const table of [
      'app.party',
      'app.party_role',
      'app.party_address',
      'app.party_contact',
      'app.party_contact_role',
    ]) {
      await expect(
        inTenant((trx) => sql`DELETE FROM ${sql.raw(table)}`.execute(trx)),
        table,
      ).rejects.toMatchObject({ code: '42501' });
    }
  });
});

describe('SS-PLAT-37: An invoice cannot be approved for a customer with no Billing To contact', () => {
  it('a customer without a Billing To contact is blocked; adding one clears the blocker', async () => {
    const p = await inTenant((trx) =>
      createParty(trx, companyId, { legalName: 'Fabrikam Pty Ltd', roles: ['customer'] }),
    );
    expect(await inTenant((trx) => invoiceApprovalBlockers(trx, p))).toEqual([
      'no_billing_to_contact',
    ]);
    const c = await inTenant((trx) =>
      addContact(trx, companyId, p, { name: 'Fran Finance', email: 'fran@fabrikam.example' }),
    );
    await inTenant((trx) => setContactRole(trx, c, 'billing_to', true));
    expect(await inTenant((trx) => invoiceApprovalBlockers(trx, p))).toEqual([]);
  });

  it('an inactive role or an archived contact does not count', async () => {
    const p = await inTenant((trx) =>
      createParty(trx, companyId, { legalName: 'Tailspin Pty Ltd', roles: ['customer'] }),
    );
    const c = await inTenant((trx) =>
      addContact(trx, companyId, p, { name: 'Tom', email: 'tom@tailspin.example' }),
    );
    await inTenant((trx) => setContactRole(trx, c, 'billing_to', true));
    await inTenant((trx) => setContactRole(trx, c, 'billing_to', false));
    expect(await inTenant((trx) => invoiceApprovalBlockers(trx, p))).toEqual([
      'no_billing_to_contact',
    ]);
    await inTenant((trx) => setContactRole(trx, c, 'billing_to', true));
    await inTenant((trx) =>
      trx
        .updateTable('app.party_contact')
        .set({ status: 'archived' })
        .where('id', '=', c)
        .execute(),
    );
    expect(await inTenant((trx) => invoiceApprovalBlockers(trx, p))).toEqual([
      'no_billing_to_contact',
    ]);
  });

  it('a party that is not a customer, or is archived, is blocked for its own reason', async () => {
    const s = await inTenant((trx) =>
      createParty(trx, companyId, { legalName: 'Only Supplier', roles: ['supplier'] }),
    );
    expect(await inTenant((trx) => invoiceApprovalBlockers(trx, s))).toEqual([
      'not_a_customer',
      'no_billing_to_contact',
    ]);
    const p = await inTenant((trx) =>
      createParty(trx, companyId, { legalName: 'Gone Pty Ltd', roles: ['customer'] }),
    );
    await inTenant((trx) =>
      trx.updateTable('app.party').set({ status: 'archived' }).where('id', '=', p).execute(),
    );
    expect(await inTenant((trx) => invoiceApprovalBlockers(trx, p))).toContain('party_archived');
  });

  it('recipients: Billing To in To, Billing CC in CC, sorted, only active contacts with email', async () => {
    const p = await inTenant((trx) =>
      createParty(trx, companyId, { legalName: 'Litware Pty Ltd', roles: ['customer'] }),
    );
    const [to1, to2, cc, noEmail] = await inTenant(async (trx) => [
      await addContact(trx, companyId, p, { name: 'Zed', email: 'zed@litware.example' }),
      await addContact(trx, companyId, p, { name: 'Amy', email: 'amy@litware.example' }),
      await addContact(trx, companyId, p, { name: 'Cal', email: 'cal@litware.example' }),
      await addContact(trx, companyId, p, { name: 'Phone only', phone: '+61 2 9999 0000' }),
    ]);
    await inTenant(async (trx) => {
      await setContactRole(trx, to1 ?? '', 'billing_to', true);
      await setContactRole(trx, to2 ?? '', 'billing_to', true);
      await setContactRole(trx, cc ?? '', 'billing_cc', true);
      await setContactRole(trx, noEmail ?? '', 'billing_cc', true);
    });
    expect(await inTenant((trx) => billingRecipients(trx, p))).toEqual({
      to: ['amy@litware.example', 'zed@litware.example'],
      cc: ['cal@litware.example'],
    });
  });
});
