/**
 * T-0065 — contract tests for the inbound master-data mapping (design §5.5, §5.6 rule 1; RQ-0098).
 * Account / Contact / Product2 change events are Avro-encoded with the documented fixture schemas
 * (fixtures/documented/pubsub-master-data-change-events.json), decoded by the production decoder
 * (header bitmaps → field names) and turned into per-record changes and mapped values. No org.
 *
 * SS-UC01-12 (mapping), SS-UC01-13 (versions: ordering, delete/undelete), SS-UC01-14 (problems).
 */
import { describe, expect, it } from 'vitest';
import { decodeConsumerEvent, parseEventSchema } from '../pubsub/avro.ts';
import {
  commitTimeOf,
  encodeMasterDataChange,
  masterDataSchemaJson,
  sfId,
  type MasterDataChange,
} from '../testing/master-data-events.ts';
import {
  changeFromSnapshot,
  changesFromCdcEvent,
  compareVersion,
  mergeState,
  type InboundChange,
} from './changes.ts';
import { mapAccount, mapContact, mapProduct } from './mapping.ts';

const ACC = sfId('001', 1);
const ACC2 = sfId('001', 2);
const CON = sfId('003', 1);
const PRD = sfId('01t', 1);

function decode(c: MasterDataChange) {
  const schema = parseEventSchema(masterDataSchemaJson(c.entity));
  return decodeConsumerEvent(schema, {
    replayId: Buffer.from('0000000000000001', 'hex'),
    event: { id: crypto.randomUUID(), schemaId: 'x', payload: encodeMasterDataChange(c) },
  });
}
const changes = (c: MasterDataChange): InboundChange[] => {
  const e = decode(c);
  return changesFromCdcEvent(e, e.header?.recordIds ?? []);
};

describe('SS-UC01-12: CDC events become per-record field patches [T-0065]', () => {
  it('a CREATE carries every non-null field, compound components as Parent.Child', () => {
    const [c] = changes({
      entity: 'Account',
      recordIds: [ACC],
      changeType: 'CREATE',
      commitNumber: 1082985383811n,
      fields: {
        Name: 'Harbour Freight Pty Ltd',
        Type: 'Customer - Direct',
        BillingAddress: { Street: '1 George St\nLevel 2', City: 'Sydney', CountryCode: 'AU' },
        CurrencyIsoCode: 'AUD',
        LF_ABN__c: '51 824 753 556',
        LastModifiedDate: 1761350000000n,
      },
    });
    expect(c).toEqual({
      entity: 'Account',
      recordId: ACC,
      op: 'upsert',
      fields: {
        Name: 'Harbour Freight Pty Ltd',
        Type: 'Customer - Direct',
        'BillingAddress.Street': '1 George St\nLevel 2',
        'BillingAddress.City': 'Sydney',
        'BillingAddress.CountryCode': 'AU',
        CurrencyIsoCode: 'AUD',
        LF_ABN__c: '51 824 753 556',
        LastModifiedDate: '1761350000000',
      },
      version: {
        commitNumber: 1082985383811n,
        sequenceNumber: 1,
        at: commitTimeOf(1082985383811n),
      },
      key: `cdc:Account:${ACC}:1082985383811:1`,
    });
  });

  it('an UPDATE carries only the header-named fields; a body null that is not named is "unchanged"', () => {
    const list = changes({
      entity: 'Account',
      recordIds: [ACC, ACC2],
      changeType: 'UPDATE',
      commitNumber: 9007199254740993n,
      sequenceNumber: 2,
      fields: { Name: 'Harbour Freight Group', BillingAddress: { City: 'Parramatta' } },
      changed: ['Name', 'BillingAddress.City', 'LF_ABN__c'],
      nulled: ['LF_ABN__c', 'ShippingAddress'],
    });
    expect(list.map((c) => c.recordId)).toEqual([ACC, ACC2]);
    expect(list[0]?.fields).toEqual({
      Name: 'Harbour Freight Group',
      'BillingAddress.City': 'Parramatta',
      LF_ABN__c: null,
      ShippingAddress: null,
    });
    expect(list[1]?.key).toBe(`cdc:Account:${ACC2}:9007199254740993:2`);
    expect(list[0]?.version.commitNumber).toBe(9007199254740993n);
  });

  it('DELETE and UNDELETE are their own operations; only the records still to apply are returned', () => {
    const del = decode({
      entity: 'Product2',
      recordIds: [PRD],
      changeType: 'DELETE',
      commitNumber: 5n,
    });
    expect(changesFromCdcEvent(del, [PRD]).map((c) => [c.op, c.fields])).toEqual([['delete', {}]]);
    expect(changesFromCdcEvent(del, [])).toEqual([]);
    const [und] = changes({
      entity: 'Product2',
      recordIds: [PRD],
      changeType: 'UNDELETE',
      commitNumber: 6n,
      fields: { Name: 'Onboarding', IsActive: true },
    });
    expect([und?.op, und?.fields]).toEqual(['undelete', { Name: 'Onboarding', IsActive: true }]);
  });

  it('a polled record (SystemModstamp delta, T-0066) is a full snapshot keyed on SystemModstamp', () => {
    const at = new Date('2026-11-08T01:02:03.000Z');
    const c = changeFromSnapshot('Contact', CON, { Email: 'ap@harbour.example', Phone: null }, at);
    expect(c).toEqual({
      entity: 'Contact',
      recordId: CON,
      op: 'upsert',
      fields: { Email: 'ap@harbour.example', Phone: null },
      version: { commitNumber: null, sequenceNumber: 0, at },
      key: `poll:Contact:${CON}:2026-11-08T01:02:03.000Z`,
    });
  });

  it('mergeState applies a patch over the last known state; a nulled compound clears its components', () => {
    const state = { Name: 'A', 'BillingAddress.Street': '1 X St', 'BillingAddress.City': 'Sydney' };
    expect(mergeState(state, { Name: 'B', 'BillingAddress.City': null })).toEqual({
      Name: 'B',
      'BillingAddress.Street': '1 X St',
      'BillingAddress.City': null,
    });
    expect(mergeState(state, { BillingAddress: null })).toEqual({ Name: 'A' });
    expect(state.Name).toBe('A'); // not mutated
  });
});

describe('SS-UC01-13: record versions order CDC commits and polled snapshots [T-0065]', () => {
  const v = (commitNumber: bigint | null, sequenceNumber: number, at: string) => ({
    commitNumber,
    sequenceNumber,
    at: new Date(at),
  });
  it('orders CDC changes by (commit number, sequence number)', () => {
    const base = v(100n, 2, '2026-11-08T00:00:00Z');
    expect(compareVersion(v(100n, 2, '2026-11-08T00:00:00Z'), base)).toBe('same');
    expect(compareVersion(v(100n, 1, '2026-11-08T00:00:00Z'), base)).toBe('older');
    expect(compareVersion(v(99n, 9, '2026-11-08T00:00:09Z'), base)).toBe('older');
    expect(compareVersion(v(101n, 1, '2026-11-07T00:00:00Z'), base)).toBe('newer');
  });
  it('orders a polled snapshot against anything by time', () => {
    const cdc = v(100n, 1, '2026-11-08T00:00:00Z');
    expect(compareVersion(v(null, 0, '2026-11-08T00:00:00Z'), cdc)).toBe('same');
    expect(compareVersion(v(null, 0, '2026-11-07T23:59:59Z'), cdc)).toBe('older');
    expect(compareVersion(v(null, 0, '2026-11-08T00:00:01Z'), cdc)).toBe('newer');
    expect(compareVersion(cdc, v(null, 0, '2026-11-08T00:00:01Z'))).toBe('older');
  });
});

describe('SS-UC01-12 / SS-UC01-14: mapping Salesforce-owned fields, problems never dropped [T-0065]', () => {
  it('Account → party values, addresses and the profile picklist value', () => {
    const m = mapAccount(
      {
        Name: '  Harbour Freight Pty Ltd ',
        Type: 'Customer - Direct',
        'BillingAddress.Street': '1 George St\nLevel 2',
        'BillingAddress.City': 'Sydney',
        'BillingAddress.State': 'NSW',
        'BillingAddress.PostalCode': '2000',
        'BillingAddress.CountryCode': 'AU',
        CurrencyIsoCode: 'AUD',
        LF_ABN__c: '51 824 753 556',
      },
      'Type',
    );
    expect(m).toEqual({
      legalName: 'Harbour Freight Pty Ltd',
      currency: 'AUD',
      abn: '51824753556',
      profileValue: 'Customer - Direct',
      addresses: [
        {
          kind: 'billing',
          line1: '1 George St',
          line2: 'Level 2',
          city: 'Sydney',
          state: 'NSW',
          postcode: '2000',
          country: 'AU',
        },
      ],
      problems: [],
    });
  });

  it('Account validation failures block the record; an address problem does not', () => {
    const m = mapAccount(
      {
        Name: ' ',
        LF_ABN__c: '51 824 753 557',
        CurrencyIsoCode: 'aud',
        'ShippingAddress.City': 'Auckland',
        'ShippingAddress.Country': 'New Zealand',
      },
      'Type',
    );
    expect(m.problems.map((p) => [p.code, p.field, p.blocking])).toEqual([
      ['invalid_value', 'Name', true],
      ['invalid_value', 'LF_ABN__c', true],
      ['invalid_value', 'CurrencyIsoCode', true],
      ['invalid_value', 'ShippingAddress', false],
    ]);
    expect(m.addresses).toEqual([]);
  });

  it('Contact → name from compound Name, email, phone and billing roles from the multi-select', () => {
    const m = mapContact({
      AccountId: ACC,
      'Name.Salutation': 'Ms',
      'Name.FirstName': 'Priya',
      'Name.LastName': 'Shah',
      Email: 'ap@harbour.example',
      Phone: '+61 2 9000 0000',
      LF_Billing_Role__c: 'Billing To;Statements;Fax Me',
    });
    expect(m).toEqual({
      accountId: ACC,
      name: 'Priya Shah',
      email: 'ap@harbour.example',
      phone: '+61 2 9000 0000',
      roles: ['billing_to', 'statements'],
      problems: [
        {
          code: 'unmapped_value',
          field: 'LF_Billing_Role__c',
          value: 'Fax Me',
          blocking: false,
          message: expect.stringContaining('Fax Me') as string,
        },
      ],
    });
  });

  it('Contact without Account, name or with a bad email is refused', () => {
    const m = mapContact({ 'Name.FirstName': null, Email: 'not-an-email' });
    expect(m.problems.map((p) => [p.code, p.field, p.blocking])).toEqual([
      ['missing_parent', 'AccountId', true],
      ['invalid_value', 'Name', true],
      ['invalid_value', 'Email', true],
    ]);
  });

  it('Product2 → product; IsActive false archives; Family is the default profile field', () => {
    expect(
      mapProduct(
        {
          Name: 'Onboarding',
          ProductCode: 'ONB-01',
          Description: 'Fixed-fee onboarding',
          Family: 'Professional Services',
          IsActive: false,
          LF_Tax_Code__c: 'GST',
        },
        'Family',
      ),
    ).toEqual({
      name: 'Onboarding',
      code: 'ONB-01',
      description: 'Fixed-fee onboarding',
      family: 'Professional Services',
      profileValue: 'Professional Services',
      active: false,
      taxCode: 'GST',
      problems: [],
    });
    expect(mapProduct({ Name: '' }, 'Family').problems.map((p) => p.field)).toEqual(['Name']);
  });
});
