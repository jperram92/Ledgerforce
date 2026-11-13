/**
 * Bills inbox over HTTP (T-0136, UC-05, SS-UC05-09, RQ-0148, DL-0510–DL-0512), against a real
 * PostgreSQL as lf_app with real sessions:
 * - GET /ap/inbox lists the emailed bills (status, sender, subject, suggested supplier, PDFs) under
 *   ap.read.
 * - GET /ap/inbox/:id/attachments/:n downloads the PDF (attachment, nosniff, sandbox CSP).
 * - POST /ap/inbox/:id/code (ap.bill.enter, Idempotency-Key, client-chosen bill id) turns the item
 *   into a draft bill. A replay is 200 with the same bill. SoD `bill.enter` is recorded and the
 *   coding audited.
 * - 403 without the permission; another tenant's item is 404.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { codeInboxItem, ingestBillEmail } from '@ledgerforce/ap';
import { seedBillingCompany } from '@ledgerforce/ar/testing';
import { withTenant } from '@ledgerforce/db';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';

const OTHER_TENANT = '01900000-0000-7000-8000-000000013602';
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n',
  'latin1',
);

let f: LedgerFixture;
let api: Api;
let supplier = '';
let item = '';
let bare = '';
let foreign = { companyId: '', itemId: '' };
const cookies = new Map<string, string>();
const people: Record<string, { id: string; roles: string[] }> = {
  clerk: { id: randomUUID(), roles: ['ap_clerk'] },
  approver: { id: randomUUID(), roles: ['approver'] },
  sales: { id: randomUUID(), roles: ['ar_clerk'] },
};

/** A raw RFC 5322 message as a mail client sends it (multipart/mixed, base64 PDF). */
function email(o: { from: string; messageId: string; subject: string; pdf?: Buffer }): string {
  const b = 'lf-boundary-136';
  const parts = [
    `From: ${o.from}`,
    'To: bills@harbour.example',
    `Subject: ${o.subject}`,
    `Message-ID: ${o.messageId}`,
    'Date: Tue, 03 Nov 2026 09:15:00 +1100',
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${b}"`,
    '',
    `--${b}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Please find our invoice attached.',
  ];
  if (o.pdf) {
    parts.push(
      `--${b}`,
      'Content-Type: application/pdf; name="SUP-INV-991.pdf"',
      'Content-Disposition: attachment; filename="SUP-INV-991.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      o.pdf.toString('base64'),
    );
  }
  parts.push(`--${b}--`, '');
  return parts.join('\r\n');
}

async function call(
  method: string,
  path: string,
  who: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const h: Record<string, string> = { ...headers };
  const c = cookies.get(who);
  if (c) h.cookie = `lf_session=${c}`;
  if (body !== undefined) h['content-type'] = 'application/json';
  return fetch(`${api.url}${path}`, {
    method,
    headers: h,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000013601');
  for (const [who, p] of Object.entries(people)) {
    await f.admin.query(
      `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, $3, $4, 'active')`,
      [p.id, f.tenantId, `${who}@inbox.test`, who],
    );
    for (const role of p.roles) {
      await f.admin.query(
        'INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, $3)',
        [f.tenantId, p.id, role],
      );
    }
  }
  await seedBillingCompany(f);
  ({ supplier, item, bare } = await f.inTenant(async (trx) => {
    const p = await trx
      .insertInto('app.party')
      .values({ company_id: f.companyId, legal_name: 'Paper Co Pty Ltd', status: 'active' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('app.party_role')
      .values({ company_id: f.companyId, party_id: p.id, role: 'supplier' })
      .execute();
    await trx
      .insertInto('app.party_contact')
      .values({
        company_id: f.companyId,
        party_id: p.id,
        name: 'Paper Co Accounts',
        email: 'accounts@paperco.example',
      })
      .execute();
    await trx
      .insertInto('app.number_series')
      .values({ company_id: f.companyId, code: 'ap_bill_document', prefix: 'BILL-' })
      .execute();
    const withPdf = await ingestBillEmail(trx, {
      companyId: f.companyId,
      raw: email({
        from: 'Paper Co <accounts@paperco.example>',
        messageId: '<inv-991@paperco.example>',
        subject: 'Invoice SUP-INV-991',
        pdf: PDF,
      }),
    });
    const noPdf = await ingestBillEmail(trx, {
      companyId: f.companyId,
      raw: email({
        from: 'someone@unknown.example',
        messageId: '<hello@unknown.example>',
        subject: 'Our invoice is on its way',
      }),
    });
    return { supplier: p.id, item: withPdf.id, bare: noPdf.id };
  }));
  // Another tenant in the same database with its own emailed bill.
  foreign = await withTenant(f.db, OTHER_TENANT, async (trx) => {
    await trx
      .insertInto('app.tenant')
      .values({ id: OTHER_TENANT, name: 'Other Pty Ltd' })
      .execute();
    const c = await trx
      .insertInto('app.company')
      .values({ name: 'Other Pty Ltd', base_currency: 'AUD' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const it = await ingestBillEmail(trx, {
      companyId: c.id,
      raw: email({
        from: 'billing@other.example',
        messageId: '<other-1@other.example>',
        subject: 'Other tenant invoice',
        pdf: PDF,
      }),
    });
    return { companyId: c.id, itemId: it.id };
  });
  api = await createApi({ databaseUrl: f.tdb.url('lf_app'), sessions: {} });
  if (!api.sessions) throw new Error('sessions not configured');
  for (const [who, p] of Object.entries(people)) {
    cookies.set(
      who,
      await api.sessions.create(f.tenantId, {
        userId: p.id,
        amr: ['pwd', 'otp'],
        acr: null,
        authTime: new Date(Date.now() - 30 * 60 * 1000),
      }),
    );
  }
}, 180_000);

afterAll(async () => {
  await (api as Api | undefined)?.close();
  await (f as LedgerFixture | undefined)?.close();
});

const q = () => `company_id=${f.companyId}`;
/** The GP-008 coding: 500.00 stationery (GST) + 2,000.00 laptop (GST-CAP) = 2,750.00 gross. */
const coding = (billId: string) => ({
  company_id: f.companyId,
  bill_id: billId,
  supplier_ref: 'SUP-INV-991',
  bill_date: '2026-11-03',
  due_date: '2026-11-30',
  lines: [
    {
      account_id: f.acct['6230'],
      description: 'Stationery and consumables',
      amount: '500.00',
      tax_code: 'GST',
    },
    { account_id: f.acct['1500'], description: 'Laptop', amount: '2000.00', tax_code: 'GST-CAP' },
  ],
});
const code = (itemId: string, who: string, body: unknown, key: string | null) =>
  call('POST', `/ap/inbox/${itemId}/code`, who, body, key ? { 'idempotency-key': key } : {});

async function auditMark(): Promise<string> {
  const { rows } = await f.admin.query<{ m: string }>(
    'SELECT coalesce(max(id), 0)::text AS m FROM audit.audit_log',
  );
  return rows[0]?.m ?? '0';
}

describe('SS-UC05-09: Emailed bill coded into a draft from the inbox', () => {
  it('SS-UC05-09 lists the emailed bill with its suggested supplier and PDF, downloads the PDF, and codes it into one draft bill (idempotent replay, SoD bill.enter, audited)', async () => {
    const list = await call('GET', `/ap/inbox?${q()}`, 'clerk');
    expect(list.status).toBe(200);
    const items = ((await list.json()) as { items: Record<string, unknown>[] }).items;
    expect(items).toEqual(
      expect.arrayContaining([
        {
          id: item,
          status: 'new',
          from_address: 'accounts@paperco.example',
          subject: 'Invoice SUP-INV-991',
          received_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) as unknown,
          party_id: supplier,
          supplier_name: 'Paper Co Pty Ltd',
          bill_id: null,
          attachments: [
            { n: 1, file_name: 'SUP-INV-991.pdf', content_type: 'application/pdf', size_bytes: 77 },
          ],
        },
        expect.objectContaining({
          id: bare,
          status: 'no_attachment',
          party_id: null,
          supplier_name: null,
          attachments: [],
        }),
      ]),
    );
    expect(items.map((i) => i.id)).not.toContain(foreign.itemId);

    const pdf = await call('GET', `/ap/inbox/${item}/attachments/1?${q()}`, 'clerk');
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    expect(pdf.headers.get('content-disposition')).toBe('attachment; filename="SUP-INV-991.pdf"');
    expect(pdf.headers.get('content-length')).toBe(String(PDF.length));
    expect(pdf.headers.get('x-content-type-options')).toBe('nosniff');
    expect(pdf.headers.get('cache-control')).toBe('no-store');
    expect(pdf.headers.get('content-security-policy')).toBe(
      "default-src 'none'; frame-ancestors 'none'; sandbox",
    );
    expect(Buffer.from(await pdf.arrayBuffer()).equals(PDF)).toBe(true);
    expect((await call('GET', `/ap/inbox/${item}/attachments/2?${q()}`, 'clerk')).status).toBe(
      404,
    );

    const billId = randomUUID();
    const noKey = await code(item, 'clerk', coding(billId), null);
    expect(noKey.status).toBe(400);
    expect(await noKey.json()).toMatchObject({ error: 'idempotency_key_required' });

    const before = await f.countEntries();
    const mark = await auditMark();
    const key = randomUUID();
    const first = await code(item, 'clerk', coding(billId), key);
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({
      item_id: item,
      status: 'coded',
      replayed: false,
      bill: {
        id: billId,
        status: 'draft',
        bill_no: null,
        entry_id: null,
        net: '2500.0000',
        tax: '250.0000',
        gross: '2750.0000',
      },
    });
    expect(await f.countEntries()).toBe(before);
    const { rows: audit } = await f.admin.query<{
      action: string;
      entity_type: string;
      entity_id: string;
      actor_user_id: string;
    }>(
      `SELECT action, entity_type, entity_id, actor_user_id FROM audit.audit_log
        WHERE tenant_id = $1 AND id > $2::bigint ORDER BY id`,
      [f.tenantId, mark],
    );
    expect(audit).toEqual([
      {
        action: 'POST /ap/inbox/:id/code',
        entity_type: 'bill_inbox_item',
        entity_id: item,
        actor_user_id: people.clerk?.id,
      },
    ]);
    const { rows: sod } = await f.admin.query<{ step: string; actor_user_id: string }>(
      `SELECT step, actor_user_id FROM app.sod_action WHERE subject_id = $1`,
      [billId],
    );
    expect(sod).toContainEqual({ step: 'bill.enter', actor_user_id: people.clerk?.id });

    const replay = await code(item, 'clerk', coding(billId), key);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      item_id: item,
      status: 'coded',
      replayed: true,
      bill: { id: billId, status: 'draft', gross: '2750.0000' },
    });
    const { rows: bills } = await f.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.supplier_bill WHERE tenant_id = $1 AND supplier_ref = 'SUP-INV-991'`,
      [f.tenantId],
    );
    expect(bills[0]?.n).toBe(1);
    const { rows: copied } = await f.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.document_attachment WHERE owner_type = 'supplier_bill' AND owner_id = $1`,
      [billId],
    );
    expect(copied[0]?.n).toBe(1);

    const again = await code(item, 'clerk', coding(randomUUID()), randomUUID());
    expect(again.status).toBe(422);
    expect(await again.json()).toMatchObject({ error: 'NOT_CODABLE' });

    const after = (await (await call('GET', `/ap/inbox?${q()}`, 'clerk')).json()) as {
      items: { id: string; status: string; bill_id: string | null }[];
    };
    expect(after.items.find((i) => i.id === item)).toMatchObject({
      status: 'coded',
      bill_id: billId,
    });
    const listed = (await (await call('GET', `/ap/bills?${q()}`, 'clerk')).json()) as {
      bills: { id: string; status: string; supplier_name: string }[];
    };
    expect(listed.bills).toContainEqual(
      expect.objectContaining({ id: billId, status: 'draft', supplier_name: 'Paper Co Pty Ltd' }),
    );
  });

  it('SS-UC05-09 an email without a PDF is listed but cannot be coded (422, nothing entered)', async () => {
    const billId = randomUUID();
    const r = await code(
      bare,
      'clerk',
      { ...coding(billId), party_id: supplier, supplier_ref: 'NO-PDF-1' },
      randomUUID(),
    );
    expect(r.status).toBe(422);
    expect(await r.json()).toMatchObject({ error: 'NOT_CODABLE' });
    const { rows } = await f.admin.query('SELECT 1 FROM app.supplier_bill WHERE id = $1', [billId]);
    expect(rows).toEqual([]);
  });

  it('SS-UC05-09 a bill id that is already a bill is refused, not attached to the item', async () => {
    const other = await f.inTenant((trx) =>
      ingestBillEmail(trx, {
        companyId: f.companyId,
        raw: email({
          from: 'accounts@paperco.example',
          messageId: '<inv-992@paperco.example>',
          subject: 'Invoice SUP-INV-992',
          pdf: PDF,
        }),
      }),
    );
    const taken = randomUUID();
    const first = await code(
      other.id,
      'clerk',
      { ...coding(taken), supplier_ref: 'SUP-INV-992' },
      randomUUID(),
    );
    expect(first.status).toBe(201);
    const third = await f.inTenant((trx) =>
      ingestBillEmail(trx, {
        companyId: f.companyId,
        raw: email({
          from: 'accounts@paperco.example',
          messageId: '<inv-993@paperco.example>',
          subject: 'Invoice SUP-INV-993',
          pdf: PDF,
        }),
      }),
    );
    const reuse = await code(
      third.id,
      'clerk',
      { ...coding(taken), supplier_ref: 'SUP-INV-993' },
      randomUUID(),
    );
    expect(reuse.status).toBe(422);
    expect(await reuse.json()).toMatchObject({ error: 'NOT_CODABLE' });
    // The module refuses it too (not only the route).
    await expect(
      f.inTenant((trx) =>
        codeInboxItem(trx, {
          companyId: f.companyId,
          itemId: third.id,
          billId: taken,
          supplierRef: 'SUP-INV-993',
          billDate: '2026-11-03',
          lines: [
            { accountId: f.acct['6230'] ?? '', description: 'x', amount: '1.00', taxCode: 'GST' },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_CODABLE' });
  });
});

describe('T-0136: permissions and tenant isolation', () => {
  it('T-0136 403 without ap.read (list, PDF) or ap.bill.enter (code)', async () => {
    expect((await call('GET', `/ap/inbox?${q()}`, 'sales')).status).toBe(403);
    expect((await call('GET', `/ap/inbox/${item}/attachments/1?${q()}`, 'sales')).status).toBe(
      403,
    );
    const approver = await code(bare, 'approver', coding(randomUUID()), randomUUID());
    expect(approver.status).toBe(403);
    expect(await approver.json()).toMatchObject({ permission: 'ap.bill.enter' });
    expect((await call('GET', `/ap/inbox?${q()}`, 'approver')).status).toBe(200);
  });

  it("T-0136 another tenant's inbox item is 404 (PDF and coding) and never listed", async () => {
    const pdf = await call(
      'GET',
      `/ap/inbox/${foreign.itemId}/attachments/1?company_id=${foreign.companyId}`,
      'clerk',
    );
    expect(pdf.status).toBe(404);
    expect(
      (await call('GET', `/ap/inbox/${foreign.itemId}/attachments/1?${q()}`, 'clerk')).status,
    ).toBe(404);
    const r = await code(foreign.itemId, 'clerk', coding(randomUUID()), randomUUID());
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ error: 'not_found' });
    const list = await call('GET', `/ap/inbox?company_id=${foreign.companyId}`, 'clerk');
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ items: [] });
  });
});
