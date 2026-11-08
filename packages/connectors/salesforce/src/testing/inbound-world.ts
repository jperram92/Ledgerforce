/**
 * Test-only world for the inbound mapping db tests (T-0065): a tenant and company with the AU
 * chart, AU tax codes and the AU services posting profiles (whose Salesforce mapping sends
 * Account.Type "Customer - Direct"/"Customer - Channel" to DOMESTIC_CUSTOMER and five Product2
 * families to product profiles), plus helpers that build changes the way production does
 * (Avro encode → decode → changesFromCdcEvent). Not used in production.
 */
import { auServicesSmb, loadChartTemplate } from '@ledgerforce/gl';
import { createDb, withTenant, type Database } from '@ledgerforce/db';
import { createTestDatabase, type TestDatabase } from '@ledgerforce/db/testing';
import { auServicesSmbProfiles, loadPostingProfileTemplate } from '@ledgerforce/products';
import { auTaxCodes, loadTaxCodes } from '@ledgerforce/tax';
import type { Kysely, Transaction } from 'kysely';
import { applyInboundChange, type ApplyResult } from '../inbound/apply.ts';
import { changesFromCdcEvent, type InboundChange } from '../inbound/changes.ts';
import { decodeConsumerEvent, parseEventSchema } from '../pubsub/avro.ts';
import {
  encodeMasterDataChange,
  masterDataSchemaJson,
  type MasterDataChange,
} from './master-data-events.ts';

export interface InboundWorld {
  tdb: TestDatabase;
  db: Kysely<Database>;
  tenantId: string;
  companyId: string;
  inTenant: <R>(fn: (trx: Transaction<Database>) => Promise<R>) => Promise<R>;
  /** Apply one change in its own tenant transaction. */
  apply: (c: InboundChange) => Promise<ApplyResult>;
  close: () => Promise<void>;
}

export async function startInboundWorld(tenantId: string): Promise<InboundWorld> {
  const tdb = await createTestDatabase({ migrate: true });
  const db = createDb(tdb.url('lf_app'), 4);
  const inTenant = <R>(fn: (trx: Transaction<Database>) => Promise<R>) =>
    withTenant(db, tenantId, fn);
  const companyId = await inTenant(async (trx) => {
    await trx.insertInto('app.tenant').values({ id: tenantId, name: 'Harbour & Co' }).execute();
    const c = await trx
      .insertInto('app.company')
      .values({ name: 'Harbour & Co Pty Ltd', base_currency: 'AUD' })
      .returning('id')
      .executeTakeFirstOrThrow();
    return c.id;
  });
  await inTenant((trx) => loadChartTemplate(trx, companyId, auServicesSmb));
  await inTenant((trx) => loadTaxCodes(trx, companyId, auTaxCodes));
  await inTenant((trx) => loadPostingProfileTemplate(trx, companyId, auServicesSmbProfiles));
  return {
    tdb,
    db,
    tenantId,
    companyId,
    inTenant,
    apply: (c) => inTenant((trx) => applyInboundChange(trx, companyId, c)),
    close: async () => {
      await db.destroy();
      await tdb.close();
    },
  };
}

/** The changes production would build from this event (all of its records). */
export function cdc(c: MasterDataChange): InboundChange[] {
  const e = decodeConsumerEvent(parseEventSchema(masterDataSchemaJson(c.entity)), {
    replayId: Buffer.from('0000000000000001', 'hex'),
    event: { id: crypto.randomUUID(), schemaId: 'x', payload: encodeMasterDataChange(c) },
  });
  return changesFromCdcEvent(e, e.header?.recordIds ?? []);
}

/** The single change of a one-record event. */
export function cdc1(c: MasterDataChange): InboundChange {
  const [one] = cdc(c);
  if (!one) throw new Error('event produced no change');
  return one;
}
