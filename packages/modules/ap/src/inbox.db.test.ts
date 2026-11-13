/**
 * Bills inbox (T-0051, UC-05, RQ-0111, ADR-0053, DL-0289), against a real PostgreSQL as lf_app: a
 * raw RFC 5322 message with a PDF becomes a draft (inbox item with the PDF attached), matched to
 * the supplier by sender address; nothing posts; coding turns it into a draft bill that keeps the
 * PDF. The message is built with nodemailer's composer, as a real mail client would send it.
 */
import { createHash } from 'node:crypto';
import { seedBillingCompany } from '@ledgerforce/ar/testing';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codeInboxItem, ingestBillEmail, type InboxError } from './inbox.ts';

let f: LedgerFixture;
let supplier = '';
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n',
  'latin1',
);

function message(o: {
  from: string;
  messageId?: string;
  attachments?: { filename: string; content: Buffer; contentType: string }[];
}) {
  return new MailComposer({
    from: o.from,
    to: 'bills@harbour.example',
    subject: 'Invoice SUP-INV-991',
    text: 'Please find our invoice attached.',
    ...(o.messageId ? { messageId: o.messageId } : {}),
    attachments: o.attachments ?? [
      { filename: 'SUP-INV-991.pdf', content: PDF, contentType: 'application/pdf' },
    ],
  })
    .compile()
    .build();
}

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000005101');
  await seedBillingCompany(f);
  supplier = await f.inTenant(async (trx) => {
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
    return p.id;
  });
}, 180_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

describe('SS-UC05-01: Emailed PDF becomes a draft bill', () => {
  it('SS-UC05-01 ingest stores a draft with the PDF attached, matched to the supplier; nothing posts; re-ingest is idempotent', async () => {
    const raw = await message({
      from: 'Paper Co <Accounts@PaperCo.example>',
      messageId: '<inv-991@paperco.example>',
    });
    const before = await f.countEntries();
    const item = await f.inTenant((trx) => ingestBillEmail(trx, { companyId: f.companyId, raw }));
    expect(item).toMatchObject({
      status: 'new',
      replayed: false,
      partyId: supplier,
      fromAddress: 'accounts@paperco.example',
      subject: 'Invoice SUP-INV-991',
      attachments: [
        {
          fileName: 'SUP-INV-991.pdf',
          contentType: 'application/pdf',
          sizeBytes: PDF.length,
          sha256: createHash('sha256').update(PDF).digest('hex'),
        },
      ],
    });
    expect(await f.countEntries()).toBe(before);
    const again = await f.inTenant((trx) => ingestBillEmail(trx, { companyId: f.companyId, raw }));
    expect(again).toMatchObject({ id: item.id, replayed: true });
    const stored = await f.inTenant((trx) =>
      trx
        .selectFrom('app.document_attachment')
        .select(['content'])
        .where('owner_id', '=', item.id)
        .executeTakeFirstOrThrow(),
    );
    expect(Buffer.from(stored.content).equals(PDF)).toBe(true);
  });

  it('SS-UC05-01 coding the inbox item creates a draft bill that keeps the PDF', async () => {
    const item = await f.inTenant((trx) =>
      trx
        .selectFrom('app.bill_inbox_item')
        .select('id')
        .where('message_id', '=', '<inv-991@paperco.example>')
        .executeTakeFirstOrThrow(),
    );
    const bill = await f.inTenant((trx) =>
      codeInboxItem(trx, {
        companyId: f.companyId,
        itemId: item.id,
        supplierRef: 'SUP-INV-991',
        billDate: '2026-11-08',
        lines: [
          {
            accountId: f.acct['6230'] ?? '',
            description: 'Paper',
            amount: '90.00',
            taxCode: 'GST',
          },
        ],
      }),
    );
    expect(bill).toMatchObject({ status: 'draft', gross: '99.0000' });
    const att = await f.inTenant((trx) =>
      trx
        .selectFrom('app.document_attachment')
        .select(['owner_type'])
        .where('owner_id', '=', bill.billId)
        .execute(),
    );
    expect(att).toEqual([{ owner_type: 'supplier_bill' }]);
    const status = await f.inTenant((trx) =>
      trx
        .selectFrom('app.bill_inbox_item')
        .select(['status', 'bill_id'])
        .where('id', '=', item.id)
        .executeTakeFirstOrThrow(),
    );
    expect(status).toEqual({ status: 'coded', bill_id: bill.billId });
  });

  it('an unknown sender is kept for a person to assign; a message without a PDF is kept as no_attachment', async () => {
    const stranger = await f.inTenant(async (trx) =>
      ingestBillEmail(trx, {
        companyId: f.companyId,
        raw: await message({ from: 'someone@else.example', messageId: '<x1@else.example>' }),
      }),
    );
    expect(stranger).toMatchObject({ status: 'new', partyId: null });
    const noPdf = await f.inTenant(async (trx) =>
      ingestBillEmail(trx, {
        companyId: f.companyId,
        raw: await message({
          from: 'accounts@paperco.example',
          messageId: '<x2@paperco.example>',
          attachments: [
            { filename: 'note.txt', content: Buffer.from('hi'), contentType: 'text/plain' },
          ],
        }),
      }),
    );
    expect(noPdf).toMatchObject({ status: 'no_attachment', attachments: [] });
    const err = await f
      .inTenant((trx) =>
        codeInboxItem(trx, {
          companyId: f.companyId,
          itemId: noPdf.id,
          supplierRef: 'X',
          billDate: '2026-11-08',
          lines: [],
        }),
      )
      .then(
        () => undefined,
        (e: unknown) => e as InboxError,
      );
    expect(err?.code).toBe('NOT_CODABLE');
  });
});
