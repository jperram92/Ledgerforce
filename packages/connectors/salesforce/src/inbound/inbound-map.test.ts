/**
 * Inbound field map and CDC body semantics (T-0065; design §5.5, §5.6 rule 1; ADR-0006; RQ-0101).
 *  - Ownership is data: every inbound (Salesforce-owned) field and every write-back
 *    (LedgerForce-owned) field has exactly one owner.
 *  - CREATE/UNDELETE apply the present fields; UPDATE applies only `changedFields`/`nulledFields`
 *    (an empty body value is "unchanged" unless named there); DELETE carries no values.
 *  - Compound fields are read by dotted path (`BillingAddress.City`) with a flat fallback.
 *  - A change touching a LedgerForce-owned field reports it as a conflict and never maps it.
 */
import { describe, expect, it } from 'vitest';
import type { DecodedEvent } from '../pubsub/avro.ts';
import {
  INBOUND_FIELD_MAP,
  inboundChanges,
  lfOwnedFields,
  ownershipClashes,
  planChange,
} from './inbound-map.ts';

/** The value, or a test failure when it is missing. */
function must<T>(x: T | null | undefined): T {
  if (x === null || x === undefined) throw new Error('expected a value');
  return x;
}

const ACC = '001000000000001AAA';
const ACC2 = '001000000000002AAA';

function event(
  over: Partial<NonNullable<DecodedEvent['header']>>,
  fields: Record<string, unknown>,
): DecodedEvent {
  return {
    replayId: Buffer.from([1]),
    eventId: 'e1',
    schemaId: 's1',
    header: {
      entityName: 'Account',
      recordIds: [ACC],
      changeType: 'UPDATE',
      changeOrigin: 'com/salesforce/api/rest/62.0',
      transactionKey: 'tx-1',
      sequenceNumber: 1,
      commitTimestamp: 1_761_350_000_000n,
      commitNumber: 42n,
      commitUser: '005000000000001AAA',
      changedFields: [],
      nulledFields: [],
      diffFields: [],
      ...over,
    },
    fields,
  };
}

describe('field ownership is data (ADR-0006)', () => {
  it('no Salesforce field is owned by both sides', () => {
    expect(ownershipClashes()).toEqual([]);
  });

  it('maps Account, Contact and Product2, and knows the LedgerForce-owned Account fields', () => {
    expect(INBOUND_FIELD_MAP.map((m) => [m.entity, m.target])).toEqual([
      ['Account', 'party'],
      ['Contact', 'contact'],
      ['Product2', 'product'],
    ]);
    expect([...lfOwnedFields('Account')]).toEqual(
      expect.arrayContaining(['LF_Balance_Due__c', 'LF_Credit_Status__c']),
    );
    expect(lfOwnedFields('Product2').size).toBe(0);
  });
});

describe('CDC body semantics (RQ-0101)', () => {
  it('splits a multi-record event into one change per record id', () => {
    const e = event({ recordIds: [ACC, ACC2], changedFields: ['Name'] }, { Name: 'Same name' });
    const changes = inboundChanges('/data/AccountChangeEvent', e, [ACC, ACC2]);
    expect(changes.map((c) => [c.recordId, c.commitNumber, c.sequenceNumber])).toEqual([
      [ACC, 42n, 1],
      [ACC2, 42n, 1],
    ]);
    expect(planChange(must(changes[1])).values.get('legal_name')).toBe('Same name');
  });

  it('UPDATE applies only the changed fields; empty unchanged fields are left alone', () => {
    const [c] = inboundChanges(
      'src',
      event(
        { changedFields: ['BillingAddress.City', 'LastModifiedDate'], nulledFields: [] },
        { Name: null, BillingAddress: { Street: null, City: 'Hobart', PostalCode: null } },
      ),
      [ACC],
    );
    const plan = planChange(must(c));
    expect([...plan.values.entries()]).toEqual([['billing.city', 'Hobart']]);
    expect(plan.missing).toEqual([]);
  });

  it('UPDATE clears a nulled optional field and flags a cleared required field', () => {
    const [c] = inboundChanges(
      'src',
      event(
        { changedFields: ['Name', 'CurrencyIsoCode'], nulledFields: ['Name', 'CurrencyIsoCode'] },
        {},
      ),
      [ACC],
    );
    const plan = planChange(must(c));
    expect(plan.values.get('currency')).toBeNull();
    expect(plan.missing).toEqual(['legal_name']);
  });

  it('CREATE reads compound and flat fields and reports missing required ones', () => {
    const [c] = inboundChanges(
      'src',
      event(
        { changeType: 'CREATE' },
        { Name: '  Harbour Freight Pty Ltd ', BillingCity: 'Sydney', Type: 'Customer - Direct' },
      ),
      [ACC],
    );
    const plan = planChange(must(c));
    expect(plan.values.get('legal_name')).toBe('Harbour Freight Pty Ltd');
    expect(plan.values.get('billing.city')).toBe('Sydney');
    expect(plan.values.get('account_type')).toBe('Customer - Direct');
    expect(plan.values.has('currency')).toBe(false);

    const [p] = inboundChanges(
      'src',
      event({ entityName: 'Product2', changeType: 'CREATE' }, { Name: 'Onboarding' }),
      [ACC],
    );
    expect(planChange(must(p)).missing).toEqual(['sku', 'family']);
  });

  it('DELETE carries no values', () => {
    const [c] = inboundChanges('src', event({ changeType: 'DELETE' }, { Name: null }), [ACC]);
    const plan = planChange(must(c));
    expect(plan.values.size).toBe(0);
    expect(plan.missing).toEqual([]);
  });

  it('a change to a LedgerForce-owned field is a conflict and is never mapped', () => {
    const [c] = inboundChanges(
      'src',
      event(
        { changedFields: ['Name', 'LF_Balance_Due__c'] },
        { Name: 'Renamed', LF_Balance_Due__c: 0 },
      ),
      [ACC],
    );
    const plan = planChange(must(c));
    expect(plan.conflicts).toEqual(['LF_Balance_Due__c']);
    expect([...plan.values.keys()]).toEqual(['legal_name']);

    const [created] = inboundChanges(
      'src',
      event({ changeType: 'CREATE' }, { Name: 'Clone', LF_Credit_Status__c: 'On hold' }),
      [ACC],
    );
    expect(planChange(must(created)).conflicts).toEqual(['LF_Credit_Status__c']);
  });

  it('an entity without a map plans nothing', () => {
    const [c] = inboundChanges(
      'src',
      event(
        { entityName: 'Opportunity', changedFields: ['StageName'] },
        { StageName: 'Closed Won' },
      ),
      [ACC],
    );
    expect(planChange(must(c))).toEqual({
      mapped: false,
      values: new Map(),
      conflicts: [],
      missing: [],
    });
  });
});
