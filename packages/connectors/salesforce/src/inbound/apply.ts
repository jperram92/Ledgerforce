/**
 * Applying inbound Salesforce changes to parties, contacts and products (T-0065; design §4.2,
 * §4.4, §5.5, §5.6 rules 1–2; ADR-0006; RQ-0098; migration 0034).
 *
 * Per change, inside the caller's tenant transaction (the CDC subscriber's batch transaction):
 *  1. Lock the record's sync row. A change whose version equals the stored one is a duplicate, an
 *     older one is stale: both are counted on the row and nothing else happens.
 *  2. Merge the patch onto the remembered Salesforce state (a CDC UPDATE carries only what
 *     changed) and map that full state (mapping.ts) — Salesforce-owned fields only.
 *  3. Write under a SAVEPOINT. A blocking problem, or a database refusal (trigger, constraint),
 *     rolls back to the savepoint: the record is `rejected`, the batch and the channel go on.
 *  4. Store the new state and version whatever the outcome (so a later fixing change merges onto
 *     the true Salesforce state), raise or refresh an inbound issue per problem, and resolve the
 *     record's issues that no longer occur. Problems are never silently dropped.
 *
 * DELETE archives the LedgerForce row (nothing is deleted); UNDELETE re-activates it. Connectors
 * produce master data only here: nothing in this module posts to the ledger.
 */
import type { ContactRole, Database } from '@ledgerforce/db';
import { setContactRole, toSalesforceId18 } from '@ledgerforce/parties';
import { sql, type Transaction } from 'kysely';
import type { CdcHandler } from '../pubsub/subscriber.ts';
import {
  changesFromCdcEvent,
  compareVersion,
  mergeState,
  type InboundChange,
  type InboundEntity,
  type RecordVersion,
  type SfState,
} from './changes.ts';
import { mapAccount, mapContact, mapProduct, type IssueCode, type Problem } from './mapping.ts';

type Trx = Transaction<Database>;

export type ApplyOutcome = 'applied' | 'duplicate' | 'stale' | 'rejected';

export interface ApplyResult {
  outcome: ApplyOutcome;
  /** The party / party contact / product id, when the record has one. */
  entityId: string | null;
  problems: Problem[];
}

export interface RecordSync {
  entity: InboundEntity;
  recordId: string;
  state: 'applied' | 'rejected' | 'deleted';
  lfId: string | null;
  fields: SfState;
  version: RecordVersion;
  lastKey: string;
  duplicates: number;
  stale: number;
  lastSkippedKey: string | null;
}

export interface InboundIssue {
  id: string;
  entity: InboundEntity;
  recordId: string;
  code: IssueCode;
  field: string | null;
  value: string | null;
  message: string;
  blocking: boolean;
  status: 'open' | 'resolved' | 'ignored';
  occurrences: number;
  lastKey: string;
  payload: SfState;
}

interface Written {
  entityId: string | null;
  problems: Problem[];
}

const ROLES: readonly ContactRole[] = [
  'billing_to',
  'billing_cc',
  'statements',
  'remittance',
  'ap_contact',
];

/** A refusal from PostgreSQL (has a SQLSTATE); anything else is a bug and is re-thrown. */
const isDatabaseError = (e: unknown): e is Error & { code: string } =>
  e instanceof Error && typeof (e as { code?: unknown }).code === 'string';

// --- sync state ---------------------------------------------------------------------------------

interface SyncRow {
  entity: InboundEntity;
  record_id: string;
  state: RecordSync['state'];
  lf_id: string | null;
  fields: SfState;
  commit_number: string | null;
  sequence_number: number;
  commit_at: Date;
  last_key: string;
  duplicates: number;
  stale: number;
  last_skipped_key: string | null;
}

const toRecordSync = (r: SyncRow): RecordSync => ({
  entity: r.entity,
  recordId: r.record_id,
  state: r.state,
  lfId: r.lf_id,
  fields: r.fields,
  version: {
    commitNumber: r.commit_number === null ? null : BigInt(r.commit_number),
    sequenceNumber: r.sequence_number,
    at: r.commit_at,
  },
  lastKey: r.last_key,
  duplicates: r.duplicates,
  stale: r.stale,
  lastSkippedKey: r.last_skipped_key,
});

async function loadSync(
  trx: Trx,
  companyId: string,
  entity: InboundEntity,
  recordId: string,
  lock: boolean,
): Promise<RecordSync | null> {
  const { rows } = await sql<SyncRow>`
    SELECT entity, record_id, state, lf_id, fields, commit_number::text AS commit_number,
           sequence_number, commit_at, last_key, duplicates, stale, last_skipped_key
      FROM app.salesforce_record_sync
     WHERE company_id = ${companyId} AND entity = ${entity} AND record_id = ${recordId}
     ${lock ? sql`FOR UPDATE` : sql``}`.execute(trx);
  const row = rows[0];
  return row ? toRecordSync(row) : null;
}

export function getRecordSync(
  trx: Trx,
  companyId: string,
  entity: InboundEntity,
  recordId: string,
): Promise<RecordSync | null> {
  return loadSync(trx, companyId, entity, recordId, false);
}

async function saveSync(
  trx: Trx,
  companyId: string,
  change: InboundChange,
  s: { state: RecordSync['state']; lfId: string | null; fields: SfState },
): Promise<void> {
  const v = change.version;
  await sql`
    INSERT INTO app.salesforce_record_sync
      (company_id, entity, record_id, state, lf_id, fields, commit_number, sequence_number,
       commit_at, last_key)
    VALUES (${companyId}, ${change.entity}, ${change.recordId}, ${s.state}, ${s.lfId},
            ${JSON.stringify(s.fields)}::jsonb, ${v.commitNumber?.toString() ?? null}::bigint,
            ${v.sequenceNumber}, ${v.at}, ${change.key})
    ON CONFLICT (tenant_id, company_id, entity, record_id) DO UPDATE SET
      state = EXCLUDED.state,
      lf_id = coalesce(EXCLUDED.lf_id, app.salesforce_record_sync.lf_id),
      fields = EXCLUDED.fields,
      commit_number = EXCLUDED.commit_number,
      sequence_number = EXCLUDED.sequence_number,
      commit_at = EXCLUDED.commit_at,
      last_key = EXCLUDED.last_key`.execute(trx);
}

async function countSkipped(
  trx: Trx,
  companyId: string,
  change: InboundChange,
  kind: 'duplicate' | 'stale',
): Promise<void> {
  const counter = kind === 'duplicate' ? sql`duplicates` : sql`stale`;
  await sql`
    UPDATE app.salesforce_record_sync
       SET ${counter} = ${counter} + 1, last_skipped_key = ${change.key},
           last_skipped_at = clock_timestamp()
     WHERE company_id = ${companyId} AND entity = ${change.entity}
       AND record_id = ${change.recordId}`.execute(trx);
}

// --- issues -------------------------------------------------------------------------------------

/** One problem per (code, field); values of repeats are joined. */
function dedupe(problems: Problem[]): Problem[] {
  const out = new Map<string, Problem>();
  for (const p of problems) {
    const k = `${p.code}\u0000${p.field ?? ''}`;
    const prev = out.get(k);
    if (!prev) out.set(k, { ...p });
    else {
      prev.value =
        [prev.value, p.value]
          .filter((x) => x !== null)
          .join(', ')
          .slice(0, 255) || null;
      prev.message = `${prev.message}; ${p.message}`.slice(0, 1000);
      prev.blocking ||= p.blocking;
    }
  }
  return [...out.values()];
}

async function recordIssues(
  trx: Trx,
  companyId: string,
  change: InboundChange,
  payload: SfState,
  problems: Problem[],
  resolveOthers: boolean,
): Promise<void> {
  const { rows: live } = await sql<{ id: string; code: IssueCode; field: string | null }>`
    SELECT id, code, field FROM app.salesforce_inbound_issue
     WHERE company_id = ${companyId} AND entity = ${change.entity}
       AND record_id = ${change.recordId} AND status IN ('open', 'ignored')
     FOR UPDATE`.execute(trx);
  const seen = new Set<string>();
  for (const p of dedupe(problems)) {
    const message = p.message.slice(0, 1000);
    const match = live.find((l) => l.code === p.code && l.field === p.field);
    if (match) {
      seen.add(match.id);
      await sql`
        UPDATE app.salesforce_inbound_issue
           SET occurrences = occurrences + 1, value = ${p.value}, message = ${message},
               blocking = ${p.blocking}, payload = ${JSON.stringify(payload)}::jsonb,
               last_key = ${change.key}, last_seen_at = clock_timestamp()
         WHERE id = ${match.id}`.execute(trx);
    } else {
      await sql`
        INSERT INTO app.salesforce_inbound_issue
          (company_id, entity, record_id, code, field, value, message, blocking, payload, last_key)
        VALUES (${companyId}, ${change.entity}, ${change.recordId}, ${p.code}, ${p.field},
                ${p.value}, ${message}, ${p.blocking}, ${JSON.stringify(payload)}::jsonb,
                ${change.key})`.execute(trx);
    }
  }
  if (!resolveOthers) return;
  for (const l of live.filter((x) => !seen.has(x.id))) {
    await sql`
      UPDATE app.salesforce_inbound_issue
         SET status = 'resolved', resolved_at = clock_timestamp(), last_key = ${change.key}
       WHERE id = ${l.id}`.execute(trx);
  }
}

export async function listInboundIssues(trx: Trx, companyId: string): Promise<InboundIssue[]> {
  const { rows } = await sql<{
    id: string;
    entity: InboundEntity;
    record_id: string;
    code: IssueCode;
    field: string | null;
    value: string | null;
    message: string;
    blocking: boolean;
    status: InboundIssue['status'];
    occurrences: number;
    last_key: string;
    payload: SfState;
  }>`
    SELECT id, entity, record_id, code, field, value, message, blocking, status, occurrences,
           last_key, payload
      FROM app.salesforce_inbound_issue
     WHERE company_id = ${companyId}
     ORDER BY first_seen_at, id`.execute(trx);
  return rows.map((r) => ({
    id: r.id,
    entity: r.entity,
    recordId: r.record_id,
    code: r.code,
    field: r.field,
    value: r.value,
    message: r.message,
    blocking: r.blocking,
    status: r.status,
    occurrences: r.occurrences,
    lastKey: r.last_key,
    payload: r.payload,
  }));
}

// --- entity writers -----------------------------------------------------------------------------

/** The configured mapping field: the default when mapped (or nothing is), else the custom one. */
async function profileField(
  trx: Trx,
  companyId: string,
  table: 'app.party_profile_mapping' | 'app.product_profile_mapping',
  dflt: string,
): Promise<string> {
  const rows =
    table === 'app.party_profile_mapping'
      ? await trx
          .selectFrom('app.party_profile_mapping')
          .select('sf_field')
          .distinct()
          .where('company_id', '=', companyId)
          .execute()
      : await trx
          .selectFrom('app.product_profile_mapping')
          .select('sf_field')
          .distinct()
          .where('company_id', '=', companyId)
          .execute();
  const fields = rows.map((r) => r.sf_field).sort();
  return fields.length === 0 || fields.includes(dflt) ? dflt : (fields[0] ?? dflt);
}

const unmapped = (object: string, field: string, value: string, what: string): Problem => ({
  code: 'unmapped_value',
  field,
  value: value.slice(0, 255),
  message: `${object} ${field} "${value}" is not mapped to a ${what} posting profile; the record was imported without one (map the value in Posting profiles, then the next change of the record picks it up)`,
  blocking: false,
});

async function writeAccount(
  trx: Trx,
  companyId: string,
  recordId: string,
  fields: SfState,
  lfId: string | null,
  archived: boolean,
): Promise<Written> {
  const field = await profileField(trx, companyId, 'app.party_profile_mapping', 'Type');
  const v = mapAccount(fields, field);
  const problems = [...v.problems];
  if (problems.some((p) => p.blocking)) return { entityId: lfId, problems };
  let profile: { id: string; party_kind: string } | undefined;
  if (v.profileValue !== null) {
    profile = await trx
      .selectFrom('app.party_profile_mapping as m')
      .innerJoin('app.party_posting_profile as p', 'p.id', 'm.party_posting_profile_id')
      .select(['p.id', 'p.party_kind'])
      .where('m.company_id', '=', companyId)
      .where('m.sf_field', '=', field)
      .where('m.sf_value', '=', v.profileValue)
      .executeTakeFirst();
    if (!profile) problems.push(unmapped('Account', field, v.profileValue, 'party'));
  }
  const values = {
    legal_name: v.legalName,
    abn: v.abn,
    currency: v.currency,
    status: archived ? ('archived' as const) : ('active' as const),
    customer_posting_profile_id: profile?.party_kind === 'customer' ? profile.id : null,
    supplier_posting_profile_id: profile?.party_kind === 'supplier' ? profile.id : null,
  };
  const existing = await trx
    .selectFrom('app.party')
    .select('id')
    .where('company_id', '=', companyId)
    .where((eb) =>
      lfId === null ? eb('salesforce_account_id', '=', recordId) : eb('id', '=', lfId),
    )
    .executeTakeFirst();
  let partyId: string;
  if (existing) {
    partyId = existing.id;
    await trx.updateTable('app.party').set(values).where('id', '=', partyId).execute();
  } else {
    const row = await trx
      .insertInto('app.party')
      .values({ company_id: companyId, salesforce_account_id: recordId, ...values })
      .returning('id')
      .executeTakeFirstOrThrow();
    partyId = row.id;
  }
  const roles: ('customer' | 'supplier')[] =
    profile?.party_kind === 'supplier' ? ['customer', 'supplier'] : ['customer'];
  await trx
    .insertInto('app.party_role')
    .values(roles.map((role) => ({ company_id: companyId, party_id: partyId, role })))
    .onConflict((oc) => oc.columns(['tenant_id', 'party_id', 'role']).doNothing())
    .execute();
  for (const a of v.addresses) {
    const { kind, ...rest } = a;
    await trx
      .insertInto('app.party_address')
      .values({ company_id: companyId, party_id: partyId, kind, ...rest })
      .onConflict((oc) => oc.columns(['tenant_id', 'party_id', 'kind']).doUpdateSet(rest))
      .execute();
  }
  return { entityId: partyId, problems };
}

async function writeContact(
  trx: Trx,
  companyId: string,
  recordId: string,
  fields: SfState,
  lfId: string | null,
  archived: boolean,
): Promise<Written> {
  const v = mapContact(fields);
  const problems = [...v.problems];
  if (problems.some((p) => p.blocking) || v.accountId === null) return { entityId: lfId, problems };
  let accountId: string;
  try {
    accountId = toSalesforceId18(v.accountId);
  } catch (e) {
    problems.push({
      code: 'invalid_value',
      field: 'AccountId',
      value: v.accountId.slice(0, 255),
      message: (e as Error).message,
      blocking: true,
    });
    return { entityId: lfId, problems };
  }
  const party = await trx
    .selectFrom('app.party')
    .select('id')
    .where('company_id', '=', companyId)
    .where('salesforce_account_id', '=', accountId)
    .executeTakeFirst();
  if (!party) {
    problems.push({
      code: 'missing_parent',
      field: 'AccountId',
      value: accountId,
      message: `Account ${accountId} is not in LedgerForce (not synced yet, or rejected); the contact is imported by the next change after its Account`,
      blocking: true,
    });
    return { entityId: lfId, problems };
  }
  const existing = await trx
    .selectFrom('app.party_contact')
    .select(['id', 'party_id'])
    .where('company_id', '=', companyId)
    .where((eb) =>
      lfId === null ? eb('salesforce_contact_id', '=', recordId) : eb('id', '=', lfId),
    )
    .executeTakeFirst();
  if (existing && existing.party_id !== party.id) {
    problems.push({
      code: 'moved_record',
      field: 'AccountId',
      value: accountId,
      message: `Contact moved to Account ${accountId}; moving a contact between parties is not supported (its roles and history stay with the old party) — create a new contact for the new Account`,
      blocking: true,
    });
    return { entityId: lfId, problems };
  }
  const values = {
    name: v.name,
    email: v.email,
    phone: v.phone,
    status: archived ? ('archived' as const) : ('active' as const),
  };
  let contactId: string;
  if (existing) {
    contactId = existing.id;
    await trx.updateTable('app.party_contact').set(values).where('id', '=', contactId).execute();
  } else {
    const row = await trx
      .insertInto('app.party_contact')
      .values({
        company_id: companyId,
        party_id: party.id,
        salesforce_contact_id: recordId,
        ...values,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    contactId = row.id;
  }
  const current = new Map(
    (
      await trx
        .selectFrom('app.party_contact_role')
        .select(['role', 'active'])
        .where('contact_id', '=', contactId)
        .execute()
    ).map((r) => [r.role, r.active]),
  );
  for (const role of ROLES) {
    const want = v.roles.includes(role);
    const has = current.get(role);
    if (want && has !== true) await setContactRole(trx, contactId, role, true);
    if (!want && has === true) await setContactRole(trx, contactId, role, false);
  }
  return { entityId: contactId, problems };
}

async function writeProduct(
  trx: Trx,
  companyId: string,
  recordId: string,
  fields: SfState,
  lfId: string | null,
  archived: boolean,
): Promise<Written> {
  const field = await profileField(trx, companyId, 'app.product_profile_mapping', 'Family');
  const v = mapProduct(fields, field);
  const problems = [...v.problems];
  if (problems.some((p) => p.blocking)) return { entityId: lfId, problems };
  let profileId: string | null = null;
  if (v.profileValue !== null) {
    const row = await trx
      .selectFrom('app.product_profile_mapping')
      .select('product_posting_profile_id')
      .where('company_id', '=', companyId)
      .where('sf_field', '=', field)
      .where('sf_value', '=', v.profileValue)
      .executeTakeFirst();
    if (row) profileId = row.product_posting_profile_id;
    else problems.push(unmapped('Product2', field, v.profileValue, 'product'));
  }
  const values = {
    name: v.name,
    code: v.code,
    description: v.description,
    product_posting_profile_id: profileId,
    default_tax_code: v.taxCode,
    salesforce_family: v.family,
    status: archived || !v.active ? ('archived' as const) : ('active' as const),
  };
  const existing = await trx
    .selectFrom('app.product')
    .select('id')
    .where('company_id', '=', companyId)
    .where((eb) =>
      lfId === null ? eb('salesforce_product_id', '=', recordId) : eb('id', '=', lfId),
    )
    .executeTakeFirst();
  if (existing) {
    await trx.updateTable('app.product').set(values).where('id', '=', existing.id).execute();
    return { entityId: existing.id, problems };
  }
  const row = await trx
    .insertInto('app.product')
    .values({ company_id: companyId, salesforce_product_id: recordId, ...values })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { entityId: row.id, problems };
}

const WRITERS = { Account: writeAccount, Contact: writeContact, Product2: writeProduct } as const;

async function archive(trx: Trx, entity: InboundEntity, lfId: string): Promise<void> {
  const set = { status: 'archived' as const };
  if (entity === 'Account')
    await trx.updateTable('app.party').set(set).where('id', '=', lfId).execute();
  else if (entity === 'Contact')
    await trx.updateTable('app.party_contact').set(set).where('id', '=', lfId).execute();
  else await trx.updateTable('app.product').set(set).where('id', '=', lfId).execute();
}

// --- entry points -------------------------------------------------------------------------------

export async function applyInboundChange(
  trx: Trx,
  companyId: string,
  change: InboundChange,
): Promise<ApplyResult> {
  let recordId: string;
  try {
    recordId = toSalesforceId18(change.recordId);
  } catch (e) {
    // Not a Salesforce Id: no sync row can hold it; the issue still records it.
    const problems: Problem[] = [
      {
        code: 'invalid_value',
        field: 'Id',
        value: change.recordId.slice(0, 255),
        message: (e as Error).message,
        blocking: true,
      },
    ];
    if (/^[A-Za-z0-9]{15,18}$/.test(change.recordId)) {
      await recordIssues(trx, companyId, change, change.fields, problems, false);
    }
    return { outcome: 'rejected', entityId: null, problems };
  }
  const c: InboundChange = { ...change, recordId };
  const prev = await loadSync(trx, companyId, c.entity, recordId, true);
  if (prev) {
    const order = compareVersion(c.version, prev.version);
    if (order !== 'newer') {
      const kind = order === 'same' ? 'duplicate' : 'stale';
      await countSkipped(trx, companyId, c, kind);
      return { outcome: kind, entityId: prev.lfId, problems: [] };
    }
  }
  const lfId = prev?.lfId ?? null;
  const deleted = c.op === 'delete' || (c.op === 'upsert' && prev?.state === 'deleted');
  const fields =
    c.op === 'delete' ? (prev?.fields ?? {}) : mergeState(prev?.fields ?? {}, c.fields);

  await sql`SAVEPOINT lf_inbound_record`.execute(trx);
  let written: Written;
  let failed = false;
  try {
    if (c.op === 'delete') {
      if (lfId !== null) await archive(trx, c.entity, lfId);
      written = { entityId: lfId, problems: [] };
    } else {
      written = await WRITERS[c.entity](trx, companyId, recordId, fields, lfId, deleted);
    }
    if (written.problems.some((p) => p.blocking)) {
      await sql`ROLLBACK TO SAVEPOINT lf_inbound_record`.execute(trx);
      written = { ...written, entityId: lfId };
    }
  } catch (e) {
    if (!isDatabaseError(e)) throw e;
    await sql`ROLLBACK TO SAVEPOINT lf_inbound_record`.execute(trx);
    failed = true;
    written = {
      entityId: lfId,
      problems: [
        {
          code: 'apply_failed',
          field: null,
          value: null,
          message: `LedgerForce refused the ${c.entity}: ${e.message}`.slice(0, 1000),
          blocking: true,
        },
      ],
    };
  }
  await sql`RELEASE SAVEPOINT lf_inbound_record`.execute(trx);

  const rejected = written.problems.some((p) => p.blocking);
  const state = deleted ? 'deleted' : rejected ? 'rejected' : 'applied';
  await saveSync(trx, companyId, c, { state, lfId: written.entityId, fields });
  await recordIssues(trx, companyId, c, fields, written.problems, !failed);
  return {
    outcome: rejected ? 'rejected' : 'applied',
    entityId: written.entityId,
    problems: written.problems,
  };
}

/**
 * The CDC subscriber handler (T-0064 `runSubscription`) for Account, Contact and Product2 channels
 * of one company: every record of the event the subscriber has not applied before is applied in
 * the batch transaction. Other entities are ignored here (Opportunity/Order are T-0069).
 */
export function salesforceInboundHandler(companyId: string): CdcHandler {
  return async (trx, event, recordIds) => {
    for (const change of changesFromCdcEvent(event, recordIds)) {
      await applyInboundChange(trx, companyId, change);
    }
  };
}
