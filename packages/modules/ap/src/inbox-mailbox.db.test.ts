/**
 * Bills inbox IMAP polling (T-0127 AC-1, ADR-0095, RQ-0177, DL-0812/DL-0813) against a real
 * PostgreSQL as lf_app and the in-process fake IMAP server (no network, no live mail server).
 * A message placed in the mailbox becomes one inbox item; re-polling, a UIDVALIDITY reset and
 * concurrent polls add nothing; oversize and invalid mail is refused without blocking the inbox;
 * the password is sealed and AAD-bound; failures are recorded as a fixed error class.
 */
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { DecryptionError, LocalKeyringKms, openField } from '@ledgerforce/shared/crypto';
import { sql } from 'kysely';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  listBillsMailboxes,
  pollBillsMailbox,
  pollTenantMailboxes,
  saveBillsMailbox,
  type PollDeps,
} from './inbox-mailbox.ts';
import { FakeImapServer } from './testing/fake-imap-server.ts';

const kms = LocalKeyringKms.fromJson(
  JSON.stringify({ active: 'k1', keys: { k1: Buffer.alloc(32, 7).toString('base64') } }),
);
const PASSWORD = 'app-password-7f3a';
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n',
  'latin1',
);
const MUTATING =
  /^(STORE|UID STORE|EXPUNGE|UID EXPUNGE|COPY|UID COPY|MOVE|UID MOVE|APPEND|SELECT)\b/i;

let f: LedgerFixture;

function mail(id: string, pdf: Buffer = PDF): Promise<Buffer> {
  return new MailComposer({
    from: 'Paper Co <accounts@paperco.example>',
    to: 'bills@harbour.example',
    subject: `Invoice ${id}`,
    text: 'Invoice attached.',
    messageId: `<${id}@paperco.example>`,
    attachments: [{ filename: `${id}.pdf`, content: pdf, contentType: 'application/pdf' }],
  })
    .compile()
    .build();
}

function fake(): FakeImapServer {
  return new FakeImapServer({
    user: 'bills@harbour.example',
    pass: PASSWORD,
    folders: { INBOX: { uidValidity: 101, messages: [] } },
  });
}

const deps = (s: FakeImapServer, extra: Partial<PollDeps> = {}): PollDeps => ({
  kms,
  connector: () => () => s.connect(),
  ...extra,
});

async function newMailbox(companyId = f.companyId, password = PASSWORD): Promise<string> {
  return f.inTenant((trx) =>
    saveBillsMailbox(trx, kms, companyId, {
      host: 'imap.harbour.example',
      username: 'bills@harbour.example',
      password,
    }),
  );
}

const items = async (companyId = f.companyId) =>
  (
    await f.admin.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM app.bill_inbox_item WHERE company_id = $1',
      [companyId],
    )
  ).rows[0]?.n;

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000012701');
}, 180_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

describe('SS-PLAT-154: A message in the bills mailbox becomes one inbox item', () => {
  it('SS-PLAT-154 one item per message; re-poll, a UIDVALIDITY reset and concurrent polls add nothing; the mailbox is untouched', async () => {
    const company = await f.addCompany('Mailbox Co A');
    const s = fake();
    s.deliver('INBOX', await mail('inv-1'));
    const id = await newMailbox(company);

    const first = await pollBillsMailbox(f.db, deps(s), { tenantId: f.tenantId, mailboxId: id });
    expect(first).toMatchObject({ status: 'ok', ingested: 1, replayed: 0, refused: [] });
    expect(await items(company)).toBe('1');

    const again = await pollBillsMailbox(f.db, deps(s), { tenantId: f.tenantId, mailboxId: id });
    expect(again).toMatchObject({ status: 'ok', ingested: 0, replayed: 0 });
    expect(await items(company)).toBe('1');

    s.deliver('INBOX', await mail('inv-2'));
    const [a, b] = await Promise.all([
      pollBillsMailbox(f.db, deps(s), { tenantId: f.tenantId, mailboxId: id }),
      pollBillsMailbox(f.db, deps(s), { tenantId: f.tenantId, mailboxId: id }),
    ]);
    expect((a?.ingested ?? 0) + (b?.ingested ?? 0)).toBe(1);
    expect(await items(company)).toBe('2');

    // The server renumbers the folder (new UIDVALIDITY): everything is re-read, nothing is new.
    s.folder('INBOX').uidValidity = 202;
    const reset = await pollBillsMailbox(f.db, deps(s), { tenantId: f.tenantId, mailboxId: id });
    expect(reset).toMatchObject({ status: 'ok', ingested: 0, replayed: 2 });
    expect(await items(company)).toBe('2');

    const [view] = await f.inTenant((trx) => listBillsMailboxes(trx, company));
    expect(view).toMatchObject({ uidValidity: 202, lastUid: 2, lastError: null, status: 'active' });
    expect(view?.lastPolledAt).toBeInstanceOf(Date);
    expect(s.commands.some((c) => MUTATING.test(c))).toBe(false);
    expect(s.commands.some((c) => /^EXAMINE /i.test(c))).toBe(true);
  });

  it('SS-PLAT-154 the tenant poll covers every active mailbox of the tenant and only those', async () => {
    const c1 = await f.addCompany('Mailbox Co T1');
    const c2 = await f.addCompany('Mailbox Co T2');
    const s1 = fake();
    const s2 = fake();
    s1.deliver('INBOX', await mail('t1-a'));
    s2.deliver('INBOX', await mail('t2-a'));
    await f.inTenant((trx) =>
      saveBillsMailbox(trx, kms, c1, {
        host: 's1.example',
        username: 'bills@harbour.example',
        password: PASSWORD,
      }),
    );
    await f.inTenant((trx) =>
      saveBillsMailbox(trx, kms, c2, {
        host: 's2.example',
        username: 'bills@harbour.example',
        password: PASSWORD,
      }),
    );
    const results = await pollTenantMailboxes(
      f.db,
      { kms, connector: (m) => () => (m.host === 's1.example' ? s1 : s2).connect() },
      f.tenantId,
    );
    const mine = results.filter((r) => r.ingested > 0);
    expect(mine.length).toBeGreaterThanOrEqual(2);
    expect(await items(c1)).toBe('1');
    expect(await items(c2)).toBe('1');
  });
});

describe('SS-PLAT-155: Oversize or invalid mail is refused without blocking the inbox', () => {
  it('SS-PLAT-155 a too-large message is not downloaded, a 10 MB+ PDF is refused, later mail still arrives; batches resume', async () => {
    const company = await f.addCompany('Mailbox Co B');
    const s = fake();
    s.deliver(
      'INBOX',
      await mail('big-pdf', Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024 + 10, 0x20)])),
    );
    s.deliver('INBOX', await mail('ok-1'));
    s.deliver('INBOX', await mail('ok-2'));
    const id = await newMailbox(company);

    // Batch of 2: the PDF over 10 MB (InboxError) is refused and the cursor moves on.
    const p1 = await pollBillsMailbox(f.db, deps(s, { maxPerPoll: 2 }), {
      tenantId: f.tenantId,
      mailboxId: id,
    });
    expect(p1).toMatchObject({ status: 'ok', ingested: 1, remaining: true });
    expect(p1.refused).toEqual([{ uid: 1, reason: 'invalid_email' }]);
    const p2 = await pollBillsMailbox(f.db, deps(s, { maxPerPoll: 2 }), {
      tenantId: f.tenantId,
      mailboxId: id,
    });
    expect(p2).toMatchObject({ status: 'ok', ingested: 1, remaining: false });

    // Over the message ceiling: refused from RFC822.SIZE, the body is never fetched.
    const uid = s.deliver(
      'INBOX',
      await mail('huge', Buffer.concat([PDF, Buffer.alloc(300_000, 0x20)])),
    );
    const p3 = await pollBillsMailbox(f.db, deps(s, { maxMessageBytes: 200_000 }), {
      tenantId: f.tenantId,
      mailboxId: id,
    });
    expect(p3.refused).toEqual([{ uid, reason: 'too_large' }]);
    expect(s.commands.some((c) => c.includes(`FETCH ${String(uid)} (UID BODY.PEEK[])`))).toBe(
      false,
    );
    expect(await items(company)).toBe('2');
    const [view] = await f.inTenant((trx) => listBillsMailboxes(trx, company));
    expect(view).toMatchObject({ lastUid: uid, refusedCount: 2 });
  });
});

describe('SS-PLAT-156: Mailbox credentials are sealed and failures never leak them', () => {
  it('SS-PLAT-156 the password is envelope-encrypted, AAD-bound to its row, never returned; a change supersedes', async () => {
    const company = await f.addCompany('Mailbox Co C');
    const first = await newMailbox(company);
    const second = await newMailbox(company, 'rotated-password-91');
    const rows = (
      await f.admin.query<{
        id: string;
        status: string;
        password_ct: Buffer;
        password_iv: Buffer;
        password_tag: Buffer;
        password_dek_wrapped: Buffer;
        password_kek_id: string;
        password_enc_version: number;
      }>('SELECT * FROM app.bill_inbox_mailbox WHERE company_id = $1 ORDER BY created_at, id', [
        company,
      ])
    ).rows;
    expect(rows.map((r) => [r.id, r.status])).toEqual([
      [first, 'superseded'],
      [second, 'active'],
    ]);
    for (const r of rows) {
      expect(r.password_ct.includes(Buffer.from(PASSWORD))).toBe(false);
      expect(r.password_ct.includes(Buffer.from('rotated-password-91'))).toBe(false);
    }
    const r2 = rows[1];
    if (!r2) throw new Error('missing row');
    const sealed = {
      ciphertext: r2.password_ct,
      iv: r2.password_iv,
      tag: r2.password_tag,
      wrappedDek: r2.password_dek_wrapped,
      keyId: r2.password_kek_id,
      version: r2.password_enc_version,
    };
    const aad = (id: string) =>
      `lf-field-v1|${f.tenantId}|${company}|app.bill_inbox_mailbox|${id}|password`;
    expect(await openField(kms, sealed, aad(second))).toBe('rotated-password-91');
    await expect(openField(kms, sealed, aad(first))).rejects.toBeInstanceOf(DecryptionError);

    const views = await f.inTenant((trx) => listBillsMailboxes(trx, company));
    expect(JSON.stringify(views)).not.toMatch(/password|rotated/i);
    expect(views.map((v) => v.status)).toEqual(['active', 'superseded']);
  });

  it('SS-PLAT-156 a refused login is recorded as auth_failed without server text; the cursor stays; the poll does not throw', async () => {
    const company = await f.addCompany('Mailbox Co D');
    const s = fake();
    s.deliver('INBOX', await mail('d-1'));
    const id = await newMailbox(company, 'wrong-password');
    const r = await pollBillsMailbox(f.db, deps(s), { tenantId: f.tenantId, mailboxId: id });
    expect(r).toMatchObject({ status: 'failed', error: 'auth_failed', ingested: 0 });
    const [view] = await f.inTenant((trx) => listBillsMailboxes(trx, company));
    expect(view).toMatchObject({ lastError: 'auth_failed', lastUid: 0 });
    expect(await items(company)).toBe('0');
  });

  it('SS-PLAT-156 lf_app cannot rewrite the identity or secret columns, and input is validated', async () => {
    const company = await f.addCompany('Mailbox Co E');
    const id = await newMailbox(company);
    await expect(
      f.inTenant((trx) =>
        sql`UPDATE app.bill_inbox_mailbox SET host = 'evil.example' WHERE id = ${id}::uuid`.execute(
          trx,
        ),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      f.inTenant((trx) =>
        sql`UPDATE app.bill_inbox_mailbox SET password_ct = '\\x01' WHERE id = ${id}::uuid`.execute(
          trx,
        ),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      f.inTenant((trx) =>
        saveBillsMailbox(trx, kms, company, {
          host: 'imap.example\r\nX',
          username: 'u',
          password: 'p',
        }),
      ),
    ).rejects.toThrow(/host/);
    await expect(
      f.inTenant((trx) =>
        saveBillsMailbox(trx, kms, company, { host: 'imap.example', username: 'u', password: '' }),
      ),
    ).rejects.toThrow(/password/);
  });
});
