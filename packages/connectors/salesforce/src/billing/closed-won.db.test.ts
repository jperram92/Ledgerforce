/**
 * Closed Won / Order activated → draft invoice (T-0069, UC-01, RQ-0106, migration 0052), against a
 * real PostgreSQL as lf_app. Every Salesforce record arrives through the inbound path of T-0065 /
 * T-0066 (`inboundCdcHandlers`, `applyInboundChange`, polled snapshots) — Account, Contact,
 * Product2, Opportunity, OpportunityLineItem, Order, OrderItem — so the idempotency key (record Id
 * + commit number + sequence number) and CDC/poll convergence are the same as for parties.
 *
 * The invoice is created by @ledgerforce/ar (`createDraftInvoice`; auto-approval and posting stay
 * there and go through the posting engine). The posted journal is compared line for line with the
 * Approved golden posting GP-001.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DocumentEvent, DocumentOutbox } from '@ledgerforce/ar';
import { setArSettings } from '@ledgerforce/ar';
import type { Database } from '@ledgerforce/db';
import { seedBillingFormats } from '@ledgerforce/documents';
import { auServicesSmb } from '@ledgerforce/gl';
import {
  DEFAULT_PERIOD_SETTINGS,
  entrySeriesFor,
  findPeriod,
  setPeriodSettings,
  setPeriodStatus,
  SOURCE_TYPES,
} from '@ledgerforce/ledger';
import { approvedTables, parsePostings, type GoldenJournal } from '@ledgerforce/ledger/golden';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { toSalesforceId18 } from '@ledgerforce/parties';
import { profileGaps, seedPostingProfiles } from '@ledgerforce/products';
import { seedTaxCodes } from '@ledgerforce/tax';
import { sql, type Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyInboundChange,
  inboundCdcHandlers,
  inboundChanges,
  inboundIssueMessage,
  listInboundChanges,
  retryInboundChange,
  type InboundIssue,
} from '../inbound/index.ts';
import { polledChange } from '../polling/delta.ts';
import type { ChangeEventHeader, DecodedEvent } from '../pubsub/avro.ts';
import { mapToRecords, parseWriteBackPayload } from '../writeback/mapping.ts';
import { setSalesforceBillingSettings } from './index.ts';

type Trx = Transaction<Database>;

function must<T>(x: T | null | undefined): T {
  if (x === null || x === undefined) throw new Error('expected a value');
  return x;
}

const TENANT = '01900000-0000-7000-8000-000000006901';
const SOURCE = '/data/ChangeEvents';
const sfId = (prefix: string, n: number) =>
  toSalesforceId18(`${prefix}${String(n).padStart(12, '0')}`);
const acc = (n: number) => sfId('001', n);
const con = (n: number) => sfId('003', n);
const prd = (n: number) => sfId('01t', n);
const opp = (n: number) => sfId('006', n);
const oli = (n: number) => sfId('00k', n);
const ord = (n: number) => sfId('801', n);
const ori = (n: number) => sfId('802', n);

const FILE = resolve(import.meta.dirname, '../../../../../Docs/accounting/postings.md');
const golden = (id: string): GoldenJournal =>
  must(approvedTables(parsePostings(readFileSync(FILE, 'utf8'))).find((t) => t.entryId === id));

let f: LedgerFixture;
let financeAdmin = '';
let commit = 69_000n;
const issues: InboundIssue[] = [];
const events: DocumentEvent[] = [];
const outbox: DocumentOutbox = {
  publish: async (_trx, e) => {
    events.push(e);
  },
};
const codeOf: Record<string, string> = {};

async function recordIssue(trx: Trx, issue: InboundIssue): Promise<string> {
  issues.push(issue);
  const m = inboundIssueMessage(f.companyId, issue);
  const { rows } = await sql<{ id: string }>`
    INSERT INTO app.outbox_event (company_id, topic, aggregate_type, aggregate_id, payload)
    VALUES (${m.companyId}, ${m.topic}, ${m.aggregateType}, ${m.aggregateId},
            ${JSON.stringify(m.payload)}::jsonb)
    RETURNING id`.execute(trx);
  return must(rows[0]).id;
}

const ctx = () => ({
  companyId: f.companyId,
  source: SOURCE,
  reportIssue: recordIssue,
  billing: { outbox },
});

function change(
  entityName: string,
  recordId: string,
  fields: Record<string, unknown>,
  header: Partial<ChangeEventHeader> = {},
): DecodedEvent {
  return {
    replayId: Buffer.from([0]),
    eventId: crypto.randomUUID(),
    schemaId: 'test',
    header: {
      entityName,
      recordIds: [recordId],
      changeType: 'CREATE',
      changeOrigin: 'com/salesforce/api/rest/62.0',
      transactionKey: `tx-${String(commit)}`,
      sequenceNumber: 1,
      commitTimestamp: 1_762_300_000_000n + commit * 1000n,
      commitNumber: (commit += 1n),
      commitUser: '005000000000001AAA',
      changedFields: [],
      nulledFields: [],
      diffFields: [],
      ...header,
    },
    fields,
  };
}

const update = (entityName: string, recordId: string, fields: Record<string, unknown>) =>
  change(entityName, recordId, fields, {
    changeType: 'UPDATE',
    changedFields: [...Object.keys(fields), 'LastModifiedDate'],
  });

/** Each event in its own tenant transaction, as the subscriber commits batches. */
async function deliver(...es: DecodedEvent[]): Promise<void> {
  const h = inboundCdcHandlers(ctx());
  for (const e of es) await f.inTenant((trx) => h.handler(trx, e, e.header?.recordIds ?? []));
}

const invoicesFor = (sourceKey: string) =>
  f.inTenant(
    async (trx) =>
      (
        await sql<{
          id: string;
          status: string;
          invoice_no: string | null;
          issue_date: string;
          entry_id: string | null;
          warnings: { code: string }[];
          note: string | null;
          billing_format_id: string | null;
        }>`
        SELECT id::text, status, invoice_no, to_char(issue_date, 'YYYY-MM-DD') AS issue_date,
               entry_id::text, warnings, note, billing_format_id::text
          FROM app.sales_invoice WHERE company_id = ${f.companyId} AND source_key = ${sourceKey}`.execute(
          trx,
        )
      ).rows,
  );

const linesOf = (invoiceId: string) =>
  f.inTenant(
    async (trx) =>
      (
        await sql<{ code: string; tax_code: string | null; amount: string; description: string }>`
        SELECT p.code, l.tax_code, l.amount::text, l.description
          FROM app.sales_invoice_line l
          JOIN app.product_posting_profile p ON p.tenant_id = l.tenant_id AND p.id = l.product_profile_id
         WHERE l.invoice_id = ${invoiceId}::uuid ORDER BY l.line_no`.execute(trx)
      ).rows,
  );

const journalOf = (entryId: string) =>
  f.inTenant(
    async (trx) =>
      (
        await sql<{ code: string; debit: string; credit: string; party: boolean }>`
        SELECT a.code, l.debit::text, l.credit::text, l.party_id IS NOT NULL AS party
          FROM app.journal_line l JOIN app.account a ON a.id = l.account_id
         WHERE l.entry_id = ${entryId}::uuid ORDER BY l.line_no`.execute(trx)
      ).rows,
  );

const money4 = (s: string) => {
  const [i = '0', d = ''] = s.replace(/,/g, '').split('.');
  return `${i}.${(d + '0000').slice(0, 4)}`;
};

const countEntries = () => f.countEntries();

/** Account (+ Billing To contact) through the inbound path. */
async function customer(n: number, name: string): Promise<string> {
  await deliver(
    change('Account', acc(n), { Name: `${name} Pty Ltd`, Type: 'Customer - Direct' }),
    change('Contact', con(n), {
      AccountId: acc(n),
      Name: { FirstName: name, LastName: 'Accounts' },
      Email: `accounts@${name.toLowerCase()}.example`,
    }),
  );
  return f.inTenant(async (trx) => {
    const c = await trx
      .selectFrom('app.party_contact')
      .select(['id', 'party_id'])
      .where('salesforce_contact_id', '=', con(n))
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('app.party_contact_role')
      .values({
        company_id: f.companyId,
        party_id: c.party_id,
        contact_id: c.id,
        role: 'billing_to',
      })
      .execute();
    return c.party_id;
  });
}

/** An Opportunity (stage Prospecting) with the GP-001 lines, as separate CDC changes. */
function gp001Opportunity(n: number, account: number, closeDate = '2026-11-05'): DecodedEvent[] {
  return [
    change('Opportunity', opp(n), {
      Name: `Deal ${String(n)}`,
      AccountId: acc(account),
      StageName: 'Prospecting',
      CloseDate: closeDate,
      Amount: 1250,
    }),
    change('OpportunityLineItem', oli(n * 10 + 1), {
      OpportunityId: opp(n),
      Product2Id: prd(1),
      Quantity: 1,
      UnitPrice: 1000,
      TotalPrice: 1000,
    }),
    change('OpportunityLineItem', oli(n * 10 + 2), {
      OpportunityId: opp(n),
      Product2Id: prd(2),
      Quantity: 1,
      UnitPrice: 250,
      TotalPrice: 250,
    }),
  ];
}

const closedWon = (n: number) =>
  update('Opportunity', opp(n), { StageName: 'Closed Won', IsWon: true, IsClosed: true });

beforeAll(async () => {
  f = await createLedgerFixture(TENANT);
  financeAdmin = await f.addUser('finance_admin');
  await f.inTenant(async (trx) => {
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
      .values({ company_id: f.companyId, code: 'ar_invoice_document', prefix: 'INV-' })
      .execute();
    await seedTaxCodes(trx, f.companyId);
    await seedPostingProfiles(trx, f.companyId, auServicesSmb, new Map(Object.entries(f.acct)));
    await seedBillingFormats(trx, f.companyId);
    const roles = await trx
      .selectFrom('app.account_system_role as r')
      .innerJoin('app.account as a', 'a.id', 'r.account_id')
      .select(['r.role', 'a.code'])
      .where('r.company_id', '=', f.companyId)
      .execute();
    for (const r of roles) codeOf[`system:${r.role}`] = r.code;
    codeOf['tax:GST.collected'] = codeOf['system:GST_COLLECTED'] ?? '?';
    codeOf['product:PROFESSIONAL_SERVICES.revenue'] = '4110';
    codeOf['product:SUBSCRIPTION.revenue'] = '4120';
  });
  await deliver(
    change('Product2', prd(1), {
      Name: 'Professional services',
      ProductCode: 'PS-HOUR',
      Family: 'Professional Services',
      IsActive: true,
    }),
    change('Product2', prd(2), {
      Name: 'Subscription',
      ProductCode: 'SUB-MONTH',
      Family: 'Subscription',
      IsActive: true,
    }),
    change('Product2', prd(3), {
      Name: 'Router',
      ProductCode: 'HW-RTR',
      Family: 'Hardware',
      IsActive: true,
    }),
  );
  await customer(1, 'Acme');
}, 120_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

describe('SS-UC01-01: Closed Won creates a draft invoice from the template', () => {
  it('SS-UC01-01 an Opportunity with 2 line items moving to Closed Won creates exactly one Draft invoice mapped to PROFESSIONAL_SERVICES and SUBSCRIPTION with tax code GST', async () => {
    await f.inTenant((trx) => setArSettings(trx, f.companyId, { autoApprove: false }));
    await deliver(...gp001Opportunity(1, 1));
    expect(await invoicesFor(`salesforce:Opportunity:${opp(1)}`)).toEqual([]);

    const before = await countEntries();
    await deliver(closedWon(1));
    const inv = await invoicesFor(`salesforce:Opportunity:${opp(1)}`);
    expect(inv).toHaveLength(1);
    const draft = must(inv[0]);
    expect(draft).toMatchObject({
      status: 'draft',
      invoice_no: null,
      issue_date: '2026-11-05',
      entry_id: null,
      warnings: [],
    });
    // Issued under the tenant's STANDARD billing format (line source opportunity_line_items).
    const format = await f.inTenant((trx) =>
      trx
        .selectFrom('app.billing_format')
        .select('code')
        .where('id', '=', must(draft.billing_format_id))
        .executeTakeFirstOrThrow(),
    );
    expect(format.code).toBe('STANDARD');
    expect(await linesOf(draft.id)).toEqual([
      {
        code: 'PROFESSIONAL_SERVICES',
        tax_code: 'GST',
        amount: '1000.0000',
        description: 'Professional services',
      },
      { code: 'SUBSCRIPTION', tax_code: 'GST', amount: '250.0000', description: 'Subscription' },
    ]);
    expect(await countEntries()).toBe(before);

    // SS-UC01-02 (LedgerForce half): the draft is announced for the write-back, which sets
    // Opportunity.LF_Invoice_Status__c = "Draft".
    const drafted = events.filter(
      (e) => e.topic === 'invoice.drafted' && e.aggregateId === draft.id,
    );
    expect(drafted).toHaveLength(1);
    const records = mapToRecords(parseWriteBackPayload(must(drafted[0]).payload));
    expect(records).toContainEqual({
      op: 'update',
      sobject: 'Opportunity',
      key: opp(1),
      fields: { LF_Invoice_Status__c: 'Draft' },
    });
  });

  it('line items arriving after Closed Won complete the invoice: no draft until the lines add up to the Amount', async () => {
    const [header, line1, line2] = gp001Opportunity(2, 1);
    await deliver(must(header), closedWon(2), must(line1));
    expect(await invoicesFor(`salesforce:Opportunity:${opp(2)}`)).toEqual([]);
    await deliver(must(line2));
    const inv = await invoicesFor(`salesforce:Opportunity:${opp(2)}`);
    expect(inv).toHaveLength(1);
    expect(await linesOf(must(inv[0]).id)).toHaveLength(2);
  });

  it('with invoice trigger "order", Closed Won does not invoice; an activated Order does (§11.2 setting)', async () => {
    await f.inTenant((trx) =>
      setSalesforceBillingSettings(trx, f.companyId, { invoiceTrigger: 'order' }),
    );
    await deliver(...gp001Opportunity(3, 1), closedWon(3));
    expect(await invoicesFor(`salesforce:Opportunity:${opp(3)}`)).toEqual([]);

    await deliver(
      change('Order', ord(1), {
        AccountId: acc(1),
        EffectiveDate: '2026-11-06',
        Status: 'Draft',
        StatusCode: 'Draft',
        TotalAmount: 1250,
      }),
      change('OrderItem', ori(1), {
        OrderId: ord(1),
        Product2Id: prd(1),
        Quantity: 4,
        UnitPrice: 250,
        TotalPrice: 1000,
      }),
      change('OrderItem', ori(2), {
        OrderId: ord(1),
        Product2Id: prd(2),
        Quantity: 1,
        UnitPrice: 250,
        TotalPrice: 250,
      }),
    );
    expect(await invoicesFor(`salesforce:Order:${ord(1)}`)).toEqual([]);
    // The AU catalogue has no order_items format: activation is a Sync issue until the tenant
    // clones one (billing formats are data, design §4.3).
    issues.length = 0;
    const activated = update('Order', ord(1), { Status: 'Activated', StatusCode: 'Activated' });
    await deliver(activated);
    expect(issues.map((i) => i.code)).toEqual(['NO_BILLING_FORMAT']);
    expect(await invoicesFor(`salesforce:Order:${ord(1)}`)).toEqual([]);
    await f.inTenant((trx) =>
      trx
        .insertInto('app.billing_format')
        .values({
          company_id: f.companyId,
          code: 'ORDER',
          name: 'Order invoice',
          posted: true,
          line_source: 'order_items',
          grouping: 'per_opportunity',
          tax_treatment: 'exclusive',
          number_series: 'ar_invoice_document',
          pdf_layout: 'invoice-v1',
          email_template: 'invoice',
          payment_link: 'none',
        })
        .execute(),
    );
    // Sync issues "Retry" re-runs the mapping of the same processed change (no new key).
    const row = must(
      (await f.inTenant((trx) => listInboundChanges(trx, f.companyId, { recordId: ord(1) }))).find(
        (r) => r.outcome === 'issue',
      ),
    );
    await f.inTenant((trx) =>
      retryInboundChange(
        trx,
        f.companyId,
        row.id,
        must(inboundChanges(SOURCE, activated, [ord(1)])[0]),
        { outbox },
      ),
    );
    const inv = await invoicesFor(`salesforce:Order:${ord(1)}`);
    expect(inv).toHaveLength(1);
    expect(must(inv[0]).issue_date).toBe('2026-11-06');
    expect((await linesOf(must(inv[0]).id)).map((l) => l.amount)).toEqual([
      '1000.0000',
      '250.0000',
    ]);
    await f.inTenant((trx) =>
      setSalesforceBillingSettings(trx, f.companyId, { invoiceTrigger: 'opportunity' }),
    );
  });
});

describe('SS-UC01-03: Auto-approve under threshold posts GP-001 and emails', () => {
  it('SS-UC01-03 with auto-approve on and threshold $2,000, Closed Won posts exactly GP-001, numbered INV-…, and notifies the Billing To contact once', async () => {
    await f.inTenant((trx) =>
      setArSettings(trx, f.companyId, { autoApprove: true, autoApproveThreshold: '2000.00' }),
    );
    await deliver(...gp001Opportunity(4, 1), closedWon(4));
    const inv = await invoicesFor(`salesforce:Opportunity:${opp(4)}`);
    expect(inv).toHaveLength(1);
    const posted = must(inv[0]);
    expect(posted.status).toBe('posted');
    expect(posted.invoice_no).toMatch(/^INV-/);

    const rows = await journalOf(must(posted.entry_id));
    const gp = golden('GP-001');
    expect(rows).toHaveLength(gp.lines.length);
    gp.lines.forEach((g, i) => {
      const at = `GP-001 line ${String(i + 1)} (${g.binding})`;
      expect(rows[i]?.code, at).toBe(codeOf[g.binding]);
      expect(rows[i]?.debit, at).toBe(money4(g.debit));
      expect(rows[i]?.credit, at).toBe(money4(g.credit));
      expect(rows[i]?.party, at).toBe(Boolean(g.party));
    });

    const notices = events.filter(
      (e) => e.topic === 'ar.invoice.posted' && e.aggregateId === posted.id,
    );
    expect(notices).toHaveLength(1);
    expect(must(notices[0]).payload['recipients']).toEqual(['accounts@acme.example']);
    // Write-back: the Opportunity shows Posted and the invoiced amount.
    const wb = events.filter((e) => e.topic === 'invoice.posted' && e.aggregateId === posted.id);
    expect(wb).toHaveLength(1);
    expect(mapToRecords(parseWriteBackPayload(must(wb[0]).payload))).toContainEqual({
      op: 'update',
      sobject: 'Opportunity',
      key: opp(4),
      fields: expect.objectContaining({ LF_Invoice_Status__c: 'Posted' }) as unknown,
    });
  });
});

describe('SS-UC01-04: Above threshold stays Draft', () => {
  it('SS-UC01-04 threshold $1,000 and a $1,375 invoice: status remains Draft and no journal is written', async () => {
    await f.inTenant((trx) =>
      setArSettings(trx, f.companyId, { autoApprove: true, autoApproveThreshold: '1000.00' }),
    );
    const before = await countEntries();
    await deliver(...gp001Opportunity(5, 1), closedWon(5));
    const inv = await invoicesFor(`salesforce:Opportunity:${opp(5)}`);
    expect(inv.map((i) => [i.status, i.entry_id])).toEqual([['draft', null]]);
    expect(await countEntries()).toBe(before);
  });
});

describe('SS-UC01-06: Posting-profile gap flagged, not posted', () => {
  it('SS-UC01-06 a product × party profile combination with no revenue account: the draft carries PROFILE_GAP, nothing posts, the gap check lists it', async () => {
    await f.inTenant((trx) =>
      setArSettings(trx, f.companyId, { autoApprove: true, autoApproveThreshold: '100000.00' }),
    );
    // Hardware sales account archived: DOMESTIC_CUSTOMER × HARDWARE has no revenue account.
    await f.inTenant((trx) =>
      trx
        .updateTable('app.account')
        .set({ status: 'archived' })
        .where('id', '=', f.acct['4140'] ?? '')
        .execute(),
    );
    const before = await countEntries();
    await deliver(
      change('Opportunity', opp(6), {
        AccountId: acc(1),
        StageName: 'Prospecting',
        CloseDate: '2026-11-07',
        Amount: 400,
      }),
      change('OpportunityLineItem', oli(61), {
        OpportunityId: opp(6),
        Product2Id: prd(3),
        Quantity: 2,
        UnitPrice: 200,
        TotalPrice: 400,
      }),
      closedWon(6),
    );
    const inv = await invoicesFor(`salesforce:Opportunity:${opp(6)}`);
    expect(inv).toHaveLength(1);
    expect(must(inv[0]).status).toBe('draft');
    expect(must(inv[0]).warnings.map((w) => w.code)).toEqual(['PROFILE_GAP']);
    expect(await countEntries()).toBe(before);
    const gaps = await f.inTenant((trx) => profileGaps(trx, f.companyId, '2026-11-07'));
    expect(gaps.map((g) => `${g.partyProfile}×${g.productProfile}:${g.reason}`)).toContain(
      'DOMESTIC_CUSTOMER×HARDWARE:account',
    );
  });
});

describe('SS-UC01-07: Duplicate CDC event is idempotent', () => {
  it('SS-UC01-07 the same Closed Won change (same record Id + commit number) delivered twice: one draft invoice, the second delivery logged as duplicate', async () => {
    await f.inTenant((trx) => setArSettings(trx, f.companyId, { autoApprove: false }));
    await deliver(...gp001Opportunity(7, 1));
    const won = closedWon(7);
    await deliver(won);
    await deliver(won); // redelivery (another channel / replay): same key
    const inv = await invoicesFor(`salesforce:Opportunity:${opp(7)}`);
    expect(inv).toHaveLength(1);
    const rows = await f.inTenant((trx) =>
      listInboundChanges(trx, f.companyId, { recordId: opp(7) }),
    );
    const wonRow = must(rows.find((r) => r.commitNumber === won.header?.commitNumber));
    expect(wonRow).toMatchObject({ outcome: 'applied', duplicateCount: 1 });
    expect(rows.filter((r) => r.commitNumber === won.header?.commitNumber)).toHaveLength(1);
  });

  it('SS-UC01-07 a polled snapshot of the won Opportunity converges: no second invoice', async () => {
    const before = await invoicesFor(`salesforce:Opportunity:${opp(7)}`);
    await f.inTenant((trx) =>
      applyInboundChange(
        trx,
        ctx(),
        polledChange('poll:Opportunity', 'Opportunity', {
          Id: opp(7),
          SystemModstamp: '2026-11-05T09:00:00.000+0000',
          IsDeleted: false,
          AccountId: acc(1),
          StageName: 'Closed Won',
          IsWon: true,
          CloseDate: '2026-11-05',
          Amount: 1250,
          Name: 'Deal 7',
        }),
      ),
    );
    expect(await invoicesFor(`salesforce:Opportunity:${opp(7)}`)).toEqual(before);
  });
});

describe('SS-UC01-08: Closed Won dated in a hard-locked period follows lock policy', () => {
  const setPolicy = (policy: 'reject' | 'post_to_first_open_date_with_note') =>
    f.inTenant((trx) =>
      setPeriodSettings(trx, {
        settings: { ...DEFAULT_PERIOD_SETTINGS, lockDatePolicy: policy },
        setBy: financeAdmin,
        reason: `policy ${policy} for the scenario`,
      }),
    );

  it('SS-UC01-08 October hard-locked, closed 2026-10-30: "reject" → Sync issue PERIOD_LOCKED and no draft; "first open date" → invoice dated 2026-11-01 with a note', async () => {
    await f.inTenant((trx) => setArSettings(trx, f.companyId, { autoApprove: false }));
    await f.inTenant(async (trx) => {
      const october = must(await findPeriod(trx, f.companyId, '2026-10-15'));
      await setPeriodStatus(trx, {
        periodId: october.id,
        status: 'hard_locked',
        actorId: financeAdmin,
      });
    });

    await setPolicy('reject');
    issues.length = 0;
    await deliver(...gp001Opportunity(8, 1, '2026-10-30'), closedWon(8));
    expect(await invoicesFor(`salesforce:Opportunity:${opp(8)}`)).toEqual([]);
    expect(issues.map((i) => [i.code, i.change.recordId])).toEqual([['PERIOD_LOCKED', opp(8)]]);
    const rows = await f.inTenant((trx) =>
      listInboundChanges(trx, f.companyId, { recordId: opp(8) }),
    );
    expect(rows.at(-1)).toMatchObject({ outcome: 'issue', issueCode: 'PERIOD_LOCKED' });

    await setPolicy('post_to_first_open_date_with_note');
    await deliver(...gp001Opportunity(9, 1, '2026-10-30'), closedWon(9));
    const inv = await invoicesFor(`salesforce:Opportunity:${opp(9)}`);
    expect(inv).toHaveLength(1);
    expect(must(inv[0]).issue_date).toBe('2026-11-01');
    expect(must(inv[0]).note).toMatch(/^Dated 2026-10-30 in period 2026-10 \(hard_locked\)/);
    await setPolicy('reject');
  });
});
