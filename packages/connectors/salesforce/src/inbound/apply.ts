/**
 * Inbound mapping: Account → party, Contact → party contact, Product2 → product, upserted by
 * Salesforce Id with an idempotency key (T-0065; design §5.5, §5.6 rule 1; ADR-0006; RQ-0101;
 * migration 0050; DL-0169, DL-0284).
 *
 * `applyInboundChange` runs in the caller's tenant transaction (the subscriber's batch):
 *   1. inserts the processed-change row for (entity, record Id, commit number, sequence number);
 *      if it exists, the delivery is a duplicate — logged on the row, nothing else happens;
 *   2. maps the change inside a savepoint (a rejected value rolls back only this change);
 *   3. reports an unmappable change or an edit of a LedgerForce-owned field to the issue sink;
 *   4. settles the row: outcome, target, applied fields, conflicts, issue.
 * Nothing is deleted: a DELETE archives; UNDELETE re-activates. Ledger tables are never touched.
 */
import type { Database } from '@ledgerforce/db';
import { addContact, createParty, PartyValidationError } from '@ledgerforce/parties';
import {
  createProduct,
  productProfileForFamily,
  ProfileError,
  setPartyProfiles,
} from '@ledgerforce/products';
import { sql, type Transaction } from 'kysely';
import type { CdcHandler } from '../pubsub/subscriber.ts';
import type { DecodedEvent } from '../pubsub/avro.ts';
import {
  inboundChanges,
  inboundMapFor,
  planChange,
  SNAPSHOT_SEQUENCE_BASE,
  type InboundChange,
  type InboundTarget,
  type InboundValue,
  type PlannedChange,
} from './inbound-map.ts';
import {
  InboundIssueError,
  parseInboundIssuePayload,
  SALESFORCE_INBOUND_HANDLER,
  SALESFORCE_INBOUND_ISSUE_TOPIC,
  type InboundIssueSink,
} from './issues.ts';

type Trx = Transaction<Database>;

export type InboundOutcome = 'applied' | 'archived' | 'ignored' | 'issue';

interface Mapped {
  outcome: InboundOutcome;
  targetType: InboundTarget | null;
  targetId: string | null;
  applied: string[];
  issue?: { code: string; message: string };
}

export interface InboundResult extends Omit<Mapped, 'outcome'> {
  outcome: InboundOutcome | 'duplicate';
  rowId: string | null;
  conflicts: string[];
  /** Why an `ignored` change was not mapped: a newer state is already applied (RQ-0103). */
  skipped?: SkipCode;
}

export type SkipCode = 'ALREADY_CURRENT' | 'SUPERSEDED';

/**
 * Snapshots (polling, reconcile) and CDC changes converge by Salesforce timestamp (RQ-0103
 * finding 7). SystemModstamp has whole-second precision and a CDC commit timestamp is never before
 * the SystemModstamp of the same transaction, so only a strictly later second proves staleness:
 *  - a snapshot is ALREADY_CURRENT when a CDC change applied at or after the next second, or a
 *    snapshot with a later stamp, was applied;
 *  - a CDC change is SUPERSEDED when a snapshot stamped at or after its next second was applied.
 * Anything closer re-applies the same or newer state, which is harmless. Issues never count.
 */
async function staleBy(trx: Trx, companyId: string, c: InboundChange): Promise<SkipCode | null> {
  const at = new Date(Number(c.commitTimestamp));
  const { rows } = await sql<{ n: number }>`
    SELECT 1 AS n FROM app.salesforce_inbound_change
     WHERE company_id = ${companyId} AND entity_name = ${c.entityName} AND record_id = ${c.recordId}
       AND outcome IN ('applied', 'archived')
       AND ${
         c.snapshot
           ? sql`((sequence_number < ${SNAPSHOT_SEQUENCE_BASE}
                    AND commit_timestamp >= ${at}::timestamptz + interval '1 second')
                  OR (sequence_number >= ${SNAPSHOT_SEQUENCE_BASE} AND commit_timestamp > ${at}))`
           : sql`(sequence_number >= ${SNAPSHOT_SEQUENCE_BASE}
                  AND commit_timestamp >= ${at}::timestamptz + interval '1 second')`
       }
     LIMIT 1`.execute(trx);
  if (rows.length === 0) return null;
  return c.snapshot ? 'ALREADY_CURRENT' : 'SUPERSEDED';
}

export interface InboundContext {
  companyId: string;
  reportIssue: InboundIssueSink;
}

const keyOf = (c: InboundChange) => sql`
  entity_name = ${c.entityName} AND record_id = ${c.recordId}
  AND commit_number = ${c.commitNumber.toString()}::bigint AND sequence_number = ${c.sequenceNumber}`;

/** Log a further delivery of an already processed change; returns its row id (null if unseen). */
export async function logDuplicate(
  trx: Trx,
  companyId: string,
  c: InboundChange,
): Promise<string | null> {
  const { rows } = await sql<{ id: string }>`
    UPDATE app.salesforce_inbound_change
       SET duplicate_count = duplicate_count + 1, last_duplicate_at = clock_timestamp(),
           last_duplicate_source = ${c.source}
     WHERE company_id = ${companyId} AND ${keyOf(c)}
    RETURNING id`.execute(trx);
  return rows[0]?.id ?? null;
}

export async function applyInboundChange(
  trx: Trx,
  ctx: InboundContext,
  c: InboundChange,
): Promise<InboundResult> {
  const { rows } = await sql<{ id: string }>`
    INSERT INTO app.salesforce_inbound_change
           (company_id, entity_name, record_id, commit_number, sequence_number, change_type,
            transaction_key, commit_timestamp, source)
    VALUES (${ctx.companyId}, ${c.entityName}, ${c.recordId}, ${c.commitNumber.toString()}::bigint,
            ${c.sequenceNumber}, ${c.changeType}, ${c.transactionKey || null},
            ${new Date(Number(c.commitTimestamp))}, ${c.source})
    ON CONFLICT (tenant_id, company_id, entity_name, record_id, commit_number, sequence_number)
    DO NOTHING
    RETURNING id`.execute(trx);
  const rowId = rows[0]?.id;
  if (!rowId) {
    return {
      outcome: 'duplicate',
      rowId: await logDuplicate(trx, ctx.companyId, c),
      targetType: null,
      targetId: null,
      applied: [],
      conflicts: [],
    };
  }
  const skipped = await staleBy(trx, ctx.companyId, c);
  if (skipped) {
    const target = inboundMapFor(c.entityName)?.target ?? null;
    await sql`
      UPDATE app.salesforce_inbound_change
         SET outcome = 'ignored', target_type = ${target}, issue_code = ${skipped},
             issue_message = ${
               skipped === 'SUPERSEDED'
                 ? 'a newer polled or reconciled state of the record is already applied'
                 : 'a newer change of the record is already applied'
             }
       WHERE id = ${rowId}`.execute(trx);
    return {
      outcome: 'ignored',
      rowId,
      targetType: target,
      targetId: null,
      applied: [],
      conflicts: [],
      skipped,
    };
  }
  const plan = planChange(c);
  const m = await mapInSavepoint(trx, ctx.companyId, c, plan);
  let issueEventId: string | null = null;
  if (m.issue || plan.conflicts.length > 0) {
    issueEventId = await ctx.reportIssue(trx, {
      kind: m.issue ? 'unmappable' : 'conflict',
      code: m.issue?.code ?? 'LF_OWNED_FIELD',
      message:
        m.issue?.message ??
        `ignored a Salesforce edit of LedgerForce-owned ${plan.conflicts.join(', ')} on ${c.entityName} ${c.recordId}; the next write-back restores it`,
      changeRowId: rowId,
      conflicts: plan.conflicts,
      change: c,
    });
  }
  await settle(trx, rowId, m, plan.conflicts, issueEventId);
  return { ...m, rowId, conflicts: plan.conflicts };
}

async function settle(
  trx: Trx,
  rowId: string,
  m: Mapped,
  conflicts: string[] | null,
  issueEventId: string | null | undefined,
): Promise<void> {
  await sql`
    UPDATE app.salesforce_inbound_change
       SET outcome = ${m.outcome}, target_type = ${m.targetType}, target_id = ${m.targetId},
           applied_fields = ${m.applied}::text[],
           conflict_fields = coalesce(${conflicts}::text[], conflict_fields),
           issue_code = ${m.issue?.code ?? null}, issue_message = ${m.issue?.message.slice(0, 1000) ?? null}
           ${issueEventId === undefined ? sql`` : sql`, issue_event_id = ${issueEventId}`}
     WHERE id = ${rowId}`.execute(trx);
}

/** A value the database or a module refused: an unmappable change, not a crash. */
function isDataProblem(e: unknown): boolean {
  if (e instanceof PartyValidationError || e instanceof ProfileError || e instanceof RangeError)
    return true;
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^2[23][0-9A-Z]{3}$/.test(code);
}

async function mapInSavepoint(
  trx: Trx,
  companyId: string,
  c: InboundChange,
  plan: PlannedChange,
): Promise<Mapped> {
  await sql`SAVEPOINT lf_inbound_change`.execute(trx);
  let m: Mapped;
  try {
    m = await mapChange(trx, companyId, c, plan);
  } catch (e) {
    if (!isDataProblem(e)) throw e;
    const target = inboundMapFor(c.entityName)?.target ?? null;
    m = {
      outcome: 'issue',
      targetType: target,
      targetId: null,
      applied: [],
      issue: { code: 'INVALID_VALUE', message: (e as Error).message },
    };
  }
  // An issue leaves no partial effect (e.g. a party created before its profile was refused).
  if (m.outcome === 'issue') await sql`ROLLBACK TO SAVEPOINT lf_inbound_change`.execute(trx);
  await sql`RELEASE SAVEPOINT lf_inbound_change`.execute(trx);
  return m;
}

const issue = (target: InboundTarget, code: string, message: string): Mapped => ({
  outcome: 'issue',
  targetType: target,
  targetId: null,
  applied: [],
  issue: { code, message },
});

/** Required keys a create lacks, or an update clears. */
function lacking(c: InboundChange, plan: PlannedChange, creating: boolean): string[] {
  if (!creating) return plan.missing;
  const required = (inboundMapFor(c.entityName)?.fields ?? []).filter((r) => r.required);
  return required.map((r) => r.to).filter((t) => (plan.values.get(t) ?? null) === null);
}

function mapChange(
  trx: Trx,
  companyId: string,
  c: InboundChange,
  plan: PlannedChange,
): Promise<Mapped> {
  const target = inboundMapFor(c.entityName)?.target;
  if (!plan.mapped || !target) {
    return Promise.resolve({ outcome: 'ignored', targetType: null, targetId: null, applied: [] });
  }
  if (target === 'party') return mapParty(trx, companyId, c, plan);
  if (target === 'contact') return mapContact(trx, companyId, c, plan);
  return mapProduct(trx, companyId, c, plan);
}

const str = (v: InboundValue | undefined): string | null => (typeof v === 'string' ? v : null);

const missingIssue = (target: InboundTarget, c: InboundChange, keys: string[], creating: boolean) =>
  issue(
    target,
    creating ? 'MISSING_REQUIRED' : 'REQUIRED_CLEARED',
    `${c.entityName} ${c.recordId} (${c.changeType}) ${creating ? 'lacks' : 'clears'} required ${keys.join(', ')}`,
  );

async function mapParty(
  trx: Trx,
  companyId: string,
  c: InboundChange,
  plan: PlannedChange,
): Promise<Mapped> {
  const v = plan.values;
  const existing = await trx
    .selectFrom('app.party')
    .select(['id', 'status'])
    .where('company_id', '=', companyId)
    .where('salesforce_account_id', '=', c.recordId)
    .executeTakeFirst();
  if (c.changeType === 'DELETE') {
    if (!existing) return { outcome: 'ignored', targetType: 'party', targetId: null, applied: [] };
    await trx
      .updateTable('app.party')
      .set({ status: 'archived' })
      .where('id', '=', existing.id)
      .execute();
    return { outcome: 'archived', targetType: 'party', targetId: existing.id, applied: ['status'] };
  }
  const gaps = lacking(c, plan, !existing);
  if (gaps.length > 0) return missingIssue('party', c, gaps, !existing);

  // Account.Type → party posting profile (data: app.salesforce_profile_mapping); its kind is the role.
  const type = str(v.get('account_type'));
  const profile = type
    ? await sql<{ id: string; kind: 'customer' | 'supplier' }>`
        SELECT p.id, p.kind FROM app.salesforce_profile_mapping m
          JOIN app.party_posting_profile p ON p.id = m.party_profile_id
         WHERE m.company_id = ${companyId} AND m.kind = 'account_type' AND m.source_value = ${type}`
        .execute(trx)
        .then((r) => r.rows[0])
    : undefined;
  const role = profile?.kind ?? 'customer';
  const applied: string[] = [];
  const billing = new Map(
    [...v.entries()]
      .filter(([k]) => k.startsWith('billing.'))
      .map(([k, x]) => [k.slice('billing.'.length), str(x)]),
  );

  let partyId: string;
  if (!existing) {
    const line1 = billing.get('line1');
    partyId = await createParty(trx, companyId, {
      legalName: str(v.get('legal_name')) ?? '',
      roles: [role],
      salesforceAccountId: c.recordId,
      ...(str(v.get('currency')) ? { currency: str(v.get('currency')) as string } : {}),
      addresses: line1
        ? [
            {
              kind: 'billing',
              line1,
              ...(billing.get('city') ? { city: billing.get('city') as string } : {}),
              ...(billing.get('state') ? { state: billing.get('state') as string } : {}),
              ...(billing.get('postcode') ? { postcode: billing.get('postcode') as string } : {}),
              ...(billing.get('country') ? { country: billing.get('country') as string } : {}),
            },
          ]
        : [],
    });
    applied.push('legal_name', ...(v.has('currency') ? ['currency'] : []));
    if (line1) applied.push(...[...billing.keys()].map((k) => `billing.${k}`));
  } else {
    partyId = existing.id;
    const set: { legal_name?: string; currency?: string | null; status?: 'active' } = {};
    if (v.has('legal_name')) set.legal_name = str(v.get('legal_name')) as string;
    if (v.has('currency')) set.currency = str(v.get('currency'));
    if (c.changeType === 'UNDELETE') set.status = 'active';
    if (Object.keys(set).length > 0) {
      await trx.updateTable('app.party').set(set).where('id', '=', partyId).execute();
      applied.push(...Object.keys(set));
    }
    applied.push(...(await upsertBilling(trx, companyId, partyId, billing)));
    if (profile) {
      await trx
        .insertInto('app.party_role')
        .values({ company_id: companyId, party_id: partyId, role })
        .onConflict((oc) =>
          oc.columns(['tenant_id', 'party_id', 'role']).doUpdateSet({ active: true }),
        )
        .execute();
    }
  }
  if (profile) {
    await setPartyProfiles(
      trx,
      companyId,
      partyId,
      profile.kind === 'customer'
        ? { customerProfileId: profile.id }
        : { supplierProfileId: profile.id },
    );
    applied.push('account_type');
  }
  return { outcome: 'applied', targetType: 'party', targetId: partyId, applied };
}

/** Changed billing components onto the party's billing address; a new address needs a street. */
async function upsertBilling(
  trx: Trx,
  companyId: string,
  partyId: string,
  billing: Map<string, string | null>,
): Promise<string[]> {
  if (billing.size === 0) return [];
  const cols = {
    line1: 'line1',
    city: 'city',
    state: 'state',
    postcode: 'postcode',
    country: 'country',
  } as const;
  const set: Partial<Record<(typeof cols)[keyof typeof cols], string | null>> = {};
  for (const [k, x] of billing) if (k in cols) set[cols[k as keyof typeof cols]] = x;
  const current = await trx
    .selectFrom('app.party_address')
    .select('id')
    .where('party_id', '=', partyId)
    .where('kind', '=', 'billing')
    .executeTakeFirst();
  if (current) {
    await trx
      .updateTable('app.party_address')
      .set(set as Record<string, string>)
      .where('id', '=', current.id)
      .execute();
  } else {
    if (!set.line1) return [];
    await trx
      .insertInto('app.party_address')
      .values({
        company_id: companyId,
        party_id: partyId,
        kind: 'billing',
        line1: set.line1,
        city: set.city ?? null,
        state: set.state ?? null,
        postcode: set.postcode ?? null,
        country: set.country ?? 'AU',
      })
      .execute();
  }
  return [...billing.keys()].map((k) => `billing.${k}`);
}

async function mapContact(
  trx: Trx,
  companyId: string,
  c: InboundChange,
  plan: PlannedChange,
): Promise<Mapped> {
  const v = plan.values;
  const existing = await trx
    .selectFrom('app.party_contact')
    .select(['id', 'party_id'])
    .where('company_id', '=', companyId)
    .where('salesforce_contact_id', '=', c.recordId)
    .executeTakeFirst();
  if (c.changeType === 'DELETE') {
    if (!existing)
      return { outcome: 'ignored', targetType: 'contact', targetId: null, applied: [] };
    await trx
      .updateTable('app.party_contact')
      .set({ status: 'archived' })
      .where('id', '=', existing.id)
      .execute();
    return {
      outcome: 'archived',
      targetType: 'contact',
      targetId: existing.id,
      applied: ['status'],
    };
  }
  const gaps = lacking(c, plan, !existing);
  if (gaps.length > 0) return missingIssue('contact', c, gaps, !existing);

  let partyId = existing?.party_id ?? null;
  if (v.has('account')) {
    const accountId = str(v.get('account')) as string;
    const party = await trx
      .selectFrom('app.party')
      .select('id')
      .where('company_id', '=', companyId)
      .where('salesforce_account_id', '=', accountId)
      .executeTakeFirst();
    if (!party) {
      return issue(
        'contact',
        'UNKNOWN_ACCOUNT',
        `Contact ${c.recordId}: Account ${accountId} is not a LedgerForce party yet`,
      );
    }
    if (existing && existing.party_id !== party.id) {
      return issue(
        'contact',
        'ACCOUNT_CHANGED',
        `Contact ${c.recordId} moved to Account ${accountId}; a contact and its roles cannot move between parties`,
      );
    }
    partyId = party.id;
  }
  // Name is a compound field: an update of one component alone cannot rebuild the full name.
  let name: string | undefined;
  if (v.has('first_name') || v.has('last_name')) {
    if (existing && !(v.has('first_name') && v.has('last_name'))) {
      return issue(
        'contact',
        'PARTIAL_NAME',
        `Contact ${c.recordId}: only part of the name changed; the record must be re-read (reconcile)`,
      );
    }
    name = [str(v.get('first_name')), str(v.get('last_name'))].filter((x) => x !== null).join(' ');
  }
  const applied: string[] = [];
  let contactId: string;
  if (!existing) {
    contactId = await addContact(trx, companyId, partyId as string, {
      name: name ?? '',
      salesforceContactId: c.recordId,
      ...(str(v.get('email')) ? { email: str(v.get('email')) as string } : {}),
      ...(str(v.get('phone')) ? { phone: str(v.get('phone')) as string } : {}),
    });
    applied.push(...[...v.keys()]);
  } else {
    contactId = existing.id;
    const set: { name?: string; email?: string | null; phone?: string | null; status?: 'active' } =
      {};
    if (name !== undefined) set.name = name;
    if (v.has('email')) set.email = str(v.get('email'));
    if (v.has('phone')) set.phone = str(v.get('phone'));
    if (c.changeType === 'UNDELETE') set.status = 'active';
    if (Object.keys(set).length > 0) {
      await trx.updateTable('app.party_contact').set(set).where('id', '=', contactId).execute();
    }
    applied.push(...[...v.keys()], ...(set.status ? ['status'] : []));
  }
  return { outcome: 'applied', targetType: 'contact', targetId: contactId, applied };
}

async function mapProduct(
  trx: Trx,
  companyId: string,
  c: InboundChange,
  plan: PlannedChange,
): Promise<Mapped> {
  const v = plan.values;
  const existing = await trx
    .selectFrom('app.product')
    .select('id')
    .where('company_id', '=', companyId)
    .where('salesforce_product2_id', '=', c.recordId)
    .executeTakeFirst();
  if (c.changeType === 'DELETE') {
    if (!existing)
      return { outcome: 'ignored', targetType: 'product', targetId: null, applied: [] };
    await trx
      .updateTable('app.product')
      .set({ status: 'archived' })
      .where('id', '=', existing.id)
      .execute();
    return {
      outcome: 'archived',
      targetType: 'product',
      targetId: existing.id,
      applied: ['status'],
    };
  }
  const gaps = lacking(c, plan, !existing);
  if (gaps.length > 0) return missingIssue('product', c, gaps, !existing);

  let profileId: string | undefined;
  const family = str(v.get('family'));
  if (family !== null) {
    profileId = await productProfileForFamily(trx, companyId, family);
    if (!profileId) {
      return issue(
        'product',
        'UNMAPPED_FAMILY',
        `Product2 ${c.recordId}: Family "${family}" has no product posting profile mapping`,
      );
    }
  }
  const active = v.get('active');
  const status =
    active === false
      ? 'archived'
      : active === true || c.changeType === 'UNDELETE'
        ? 'active'
        : undefined;
  let productId: string;
  if (!existing) {
    productId = await createProduct(trx, companyId, {
      sku: str(v.get('sku')) as string,
      name: str(v.get('name')) as string,
      productProfileId: profileId as string,
      salesforceProduct2Id: c.recordId,
      ...(str(v.get('description')) ? { description: str(v.get('description')) as string } : {}),
    });
    if (status === 'archived') {
      await trx.updateTable('app.product').set({ status }).where('id', '=', productId).execute();
    }
  } else {
    productId = existing.id;
    const set: {
      name?: string;
      sku?: string;
      description?: string | null;
      product_profile_id?: string;
      status?: 'active' | 'archived';
    } = {};
    if (v.has('name')) set.name = str(v.get('name')) as string;
    if (v.has('sku')) set.sku = str(v.get('sku')) as string;
    if (v.has('description')) set.description = str(v.get('description'));
    if (profileId) set.product_profile_id = profileId;
    if (status) set.status = status;
    if (Object.keys(set).length > 0) {
      await trx.updateTable('app.product').set(set).where('id', '=', productId).execute();
    }
  }
  return { outcome: 'applied', targetType: 'product', targetId: productId, applied: [...v.keys()] };
}

/** Map an `issue` change again (Sync issues retry); settles the row unless it is still an issue. */
export async function retryInboundChange(
  trx: Trx,
  companyId: string,
  rowId: string,
  c: InboundChange,
): Promise<Mapped> {
  const { rows } = await sql<{ outcome: string }>`
    SELECT outcome FROM app.salesforce_inbound_change
     WHERE id = ${rowId} AND company_id = ${companyId} FOR UPDATE`.execute(trx);
  const row = rows[0];
  if (!row)
    throw new InboundIssueError(
      'unmappable',
      'CHANGE_NOT_FOUND',
      `inbound change ${rowId} not found`,
    );
  if (row.outcome !== 'issue') {
    return {
      outcome: row.outcome as InboundOutcome,
      targetType: null,
      targetId: null,
      applied: [],
    };
  }
  const m = await mapInSavepoint(trx, companyId, c, planChange(c));
  if (m.outcome !== 'issue') await settle(trx, rowId, m, null, undefined);
  return m;
}

export interface InboundChangeRow {
  id: string;
  entityName: string;
  recordId: string;
  commitNumber: bigint;
  sequenceNumber: number;
  changeType: string;
  source: string;
  outcome: InboundOutcome | 'pending';
  targetType: InboundTarget | null;
  targetId: string | null;
  appliedFields: string[];
  conflictFields: string[];
  issueCode: string | null;
  issueMessage: string | null;
  issueEventId: string | null;
  duplicateCount: number;
  lastDuplicateAt: Date | null;
  lastDuplicateSource: string | null;
  processedAt: Date;
}

export async function listInboundChanges(
  trx: Trx,
  companyId: string,
  filter: { recordId?: string } = {},
): Promise<InboundChangeRow[]> {
  const { rows } = await sql<Record<string, unknown>>`
    SELECT id, entity_name, record_id, commit_number::text AS commit_number, sequence_number,
           change_type, source, outcome, target_type, target_id, applied_fields, conflict_fields,
           issue_code, issue_message, issue_event_id, duplicate_count, last_duplicate_at,
           last_duplicate_source, processed_at
      FROM app.salesforce_inbound_change
     WHERE company_id = ${companyId}
       AND (${filter.recordId ?? null}::text IS NULL OR record_id = ${filter.recordId ?? null})
     ORDER BY commit_number, sequence_number, processed_at`.execute(trx);
  return rows.map((r) => ({
    id: r['id'] as string,
    entityName: r['entity_name'] as string,
    recordId: r['record_id'] as string,
    commitNumber: BigInt(r['commit_number'] as string),
    sequenceNumber: r['sequence_number'] as number,
    changeType: r['change_type'] as string,
    source: r['source'] as string,
    outcome: r['outcome'] as InboundChangeRow['outcome'],
    targetType: r['target_type'] as InboundTarget | null,
    targetId: r['target_id'] as string | null,
    appliedFields: r['applied_fields'] as string[],
    conflictFields: r['conflict_fields'] as string[],
    issueCode: r['issue_code'] as string | null,
    issueMessage: r['issue_message'] as string | null,
    issueEventId: r['issue_event_id'] as string | null,
    duplicateCount: r['duplicate_count'] as number,
    lastDuplicateAt: r['last_duplicate_at'] as Date | null,
    lastDuplicateSource: r['last_duplicate_source'] as string | null,
    processedAt: r['processed_at'] as Date,
  }));
}

/** Duplicate hook for the subscriber (`SubscriberOptions.onDuplicate`). */
export type CdcDuplicateHandler = (
  trx: Trx,
  event: DecodedEvent,
  recordIds: readonly string[],
) => Promise<void>;

/** The subscriber's `handler` and `onDuplicate` for one company and channel (source). */
export function inboundCdcHandlers(ctx: InboundContext & { source: string }): {
  handler: CdcHandler;
  onDuplicate: CdcDuplicateHandler;
} {
  return {
    handler: async (trx, event, recordIds) => {
      for (const c of inboundChanges(ctx.source, event, recordIds))
        await applyInboundChange(trx, ctx, c);
    },
    onDuplicate: async (trx, event, recordIds) => {
      for (const c of inboundChanges(ctx.source, event, recordIds))
        await logDuplicate(trx, ctx.companyId, c);
    },
  };
}

/** Outbox handler (`HandlerRegistry.register`) that turns inbound issues into Sync issues. */
export function salesforceInboundIssueHandler(): {
  name: string;
  topics: readonly string[];
  handle(
    trx: Trx,
    event: { companyId: string | null; aggregateId: string; payload: Record<string, unknown> },
  ): Promise<void>;
} {
  return {
    name: SALESFORCE_INBOUND_HANDLER,
    topics: [SALESFORCE_INBOUND_ISSUE_TOPIC],
    async handle(trx, event) {
      const p = parseInboundIssuePayload(event.payload);
      if (p.kind === 'conflict') throw new InboundIssueError('conflict', p.code, p.message);
      const m = await retryInboundChange(trx, event.companyId ?? '', event.aggregateId, p.change);
      if (m.issue) throw new InboundIssueError('unmappable', m.issue.code, m.issue.message);
    },
  };
}
