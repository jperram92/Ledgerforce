/**
 * Security notice dispatcher (T-0197, ADR-0092, RQ-0174) against a real PostgreSQL as lf_app and a
 * real SMTP conversation (SmtpSink). The database writes the notices in the approving
 * transaction (0025 bank-detail changes, 0072 remittance account changes); the dispatcher sends
 * each due notice once, plain text with masked details and no links, records every attempt in
 * app.security_notice_delivery (0075) and moves the notice to sent or failed. Failures are retried
 * with backoff; one tenant's dispatch never reads another tenant's notices. Time is injected; the
 * superuser only seeds sessions and inspects.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  approveRemittanceAccountChange,
  requestRemittanceAccountChange,
} from '@ledgerforce/ar';
import { withTenant, type Database } from '@ledgerforce/db';
import { auServicesSmb, loadChartTemplate } from '@ledgerforce/gl';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import {
  addContact,
  createParty,
  requestBankDetailChange,
  setContactRole,
  verifyBankDetailChange,
} from '@ledgerforce/parties';
import { LocalKeyringKms } from '@ledgerforce/shared/crypto';
import { sql, type Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  dispatchSecurityNotices,
  securityNoticeRetryDelaySeconds,
} from './security-notice-email.ts';
import { SmtpSender } from './sender.ts';
import { SmtpSink, type SunkMessage } from './testing/smtp-sink.ts';

type Trx = Transaction<Database>;

const TENANT = '01900000-0000-7000-8000-000000019701';
const OTHER = '01900000-0000-7000-8000-000000019702';
const NOTE = 'Phoned the supplier on the number on file; they confirmed the new account.';

let f: LedgerFixture;
const sink = new SmtpSink();
let sender: SmtpSender;
const kms = LocalKeyringKms.fromJson(
  JSON.stringify({ active: 'k1', keys: { k1: randomBytes(32).toString('base64') } }),
);
let operating = '';
let reserve = '';
let owner = '';
let fa = '';
let clerk = '';

async function bankAccount(
  trx: Trx,
  companyId: string,
  glAccountId: string,
  name: string,
  last3: string,
): Promise<string> {
  const id = randomUUID();
  await trx
    .insertInto('app.bank_account')
    .values({
      id,
      company_id: companyId,
      gl_account_id: glAccountId,
      name,
      currency: 'AUD',
      bsb: '062-000',
      account_name: `Harbour ${name}`,
      account_number_last3: last3,
      account_number_ct: randomBytes(8),
      account_number_iv: randomBytes(12),
      account_number_tag: randomBytes(16),
      dek_wrapped: randomBytes(60),
      kek_id: 'k1',
      enc_version: 1,
    })
    .execute();
  return id;
}

async function person(trx: Trx, name: string, roles: readonly string[]): Promise<string> {
  const u = await trx
    .insertInto('app.app_user')
    .values({
      email: `${name.toLowerCase().replace(/ /g, '.')}@notice.test`,
      display_name: name,
      status: 'active',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  for (const role of roles)
    await trx.insertInto('app.user_role').values({ user_id: u.id, role }).execute();
  return u.id;
}

/** A fresh MFA session of a user (step-up for bank-detail writes, migration 0025). */
async function session(userId: string): Promise<string> {
  const { rows } = await f.admin.query<{ id: string }>(
    `INSERT INTO app.session (tenant_id, user_id, secret_sha256, created_at, last_seen_at,
                              absolute_expires_at, idle_timeout_seconds, user_session_epoch,
                              amr, acr, auth_time)
     VALUES ($1, $2, $3, clock_timestamp() - interval '1 hour', clock_timestamp(),
             clock_timestamp() + interval '11 hours', 1800,
             (SELECT session_epoch FROM app.app_user WHERE tenant_id = $1 AND id = $2),
             ARRAY['pwd','otp'], NULL, clock_timestamp() - interval '5 seconds')
     RETURNING id`,
    [f.tenantId, userId, randomBytes(32).toString('hex')],
  );
  return rows[0]?.id ?? '';
}

async function remittanceChange(
  tenant: string,
  companyId: string,
  bankAccountId: string,
  requestedBy: string,
  approvedBy: string,
): Promise<string> {
  const changeId = randomUUID();
  await withTenant(f.db, tenant, (trx) =>
    requestRemittanceAccountChange(trx, { companyId, changeId, bankAccountId, requestedBy }),
  );
  await withTenant(f.db, tenant, (trx) =>
    approveRemittanceAccountChange(trx, { companyId, changeId, approvedBy }),
  );
  return changeId;
}

async function bankDetailChange(partyId: string, accountNumber: string): Promise<string> {
  const requestSession = await session(clerk);
  const { changeId } = await f.inTenant((trx) =>
    requestBankDetailChange(trx, kms, {
      partyId,
      account: { bsb: '062-000', accountNumber, accountName: 'Supplier', source: 'ui' },
      requestedBy: clerk,
      sessionId: requestSession,
    }),
  );
  const verifySession = await session(owner);
  await f.inTenant((trx) =>
    verifyBankDetailChange(trx, {
      changeId,
      verifiedBy: owner,
      sessionId: verifySession,
      confirmationNote: NOTE,
    }),
  );
  return changeId;
}

async function supplier(legalName: string, remittanceEmail: string | null): Promise<string> {
  return f.inTenant(async (trx) => {
    const p = await createParty(trx, f.companyId, { legalName, roles: ['supplier'] });
    if (remittanceEmail) {
      const c = await addContact(trx, f.companyId, p, {
        name: 'Accounts Team',
        email: remittanceEmail,
      });
      await setContactRole(trx, c, 'remittance', true);
    }
    return p;
  });
}

interface NoticeRow {
  id: string;
  recipient_email: string | null;
  status: string;
  sent_at: Date | null;
}

const remittanceNotices = async (changeId: string): Promise<NoticeRow[]> =>
  (
    await f.admin.query<NoticeRow>(
      `SELECT id, recipient_email, status, sent_at FROM app.remittance_account_notice
        WHERE change_id = $1 ORDER BY recipient_email NULLS FIRST`,
      [changeId],
    )
  ).rows;

const bankNotices = async (changeId: string): Promise<NoticeRow[]> =>
  (
    await f.admin.query<NoticeRow>(
      `SELECT id, recipient_email, status, sent_at FROM app.bank_detail_change_notice
        WHERE change_id = $1 ORDER BY recipient_email NULLS FIRST`,
      [changeId],
    )
  ).rows;

interface DeliveryRow {
  notice_kind: string;
  attempt: number;
  outcome: string;
  to_addr: string;
  subject: string;
  smtp_code: number | null;
  error_message: string | null;
  next_attempt_at: Date | null;
}

const deliveriesOf = async (noticeId: string): Promise<DeliveryRow[]> =>
  (
    await f.admin.query<DeliveryRow>(
      `SELECT notice_kind, attempt, outcome, to_addr, subject, smtp_code, error_message,
              next_attempt_at
         FROM app.security_notice_delivery
        WHERE remittance_notice_id = $1 OR bank_detail_notice_id = $1
        ORDER BY attempt`,
      [noticeId],
    )
  ).rows;

/** Header block and decoded text body of a sunk message (7bit or quoted-printable). */
function parse(m: SunkMessage): { headers: string; body: string } {
  const i = m.raw.indexOf('\r\n\r\n');
  const headers = m.raw.slice(0, i);
  let body = m.raw.slice(i + 4);
  if (/Content-Transfer-Encoding: quoted-printable/i.test(headers)) {
    body = Buffer.from(
      body
        .replace(/=\r\n/g, '')
        .replace(/=([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))),
      'latin1',
    ).toString('utf8');
  }
  return { headers: headers.replace(/\r\n\s+/g, ' '), body };
}

const to = (addr: string) => sink.messages.filter((m) => m.to.includes(addr));

beforeAll(async () => {
  await sink.start();
  sender = new SmtpSender({ url: sink.url, from: 'LedgerForce <security@ledgerforce.example>' });
  f = await createLedgerFixture(TENANT);
  await f.inTenant(async (trx) => {
    operating = await bankAccount(trx, f.companyId, f.acct['1010'] ?? '', 'Operating', '678');
    reserve = await bankAccount(trx, f.companyId, f.acct['1020'] ?? '', 'Reserve', '321');
    owner = await person(trx, 'Oscar Owner', ['owner']);
    fa = await person(trx, 'Fiona Admin', ['finance_admin']);
    clerk = await person(trx, 'Ada Clerk', ['ap_clerk']);
  });
}, 180_000);

afterAll(async () => {
  await sink.stop();
  await (f as LedgerFixture | undefined)?.close();
});

describe('SS-PLAT-145: a remittance account notice is emailed once, masked, with no links', () => {
  let c2 = '';

  it('SS-PLAT-145 each Owner and Finance Admin gets one plain-text notice; the notice becomes sent [T-0197]', async () => {
    await remittanceChange(f.tenantId, f.companyId, operating, fa, owner);
    c2 = await remittanceChange(f.tenantId, f.companyId, reserve, fa, owner);
    const now = new Date();

    const r = await dispatchSecurityNotices(f.db, f.tenantId, { sender, now });

    expect(r).toEqual({ sent: 4, failed: 0 });
    expect(to('oscar.owner@notice.test')).toHaveLength(2);
    expect(to('fiona.admin@notice.test')).toHaveLength(2);
    const last = to('oscar.owner@notice.test').at(-1);
    if (!last) throw new Error('no message');
    const { headers, body } = parse(last);
    expect(headers).toContain(
      'Subject: Security notice: the remittance bank account of Harbour & Co Pty Ltd was changed',
    );
    expect(headers).toMatch(/Content-Type: text\/plain/i);
    expect(last.raw).not.toMatch(/text\/html|multipart/i);
    expect(body).toContain('Hello Oscar Owner');
    expect(body).toContain('New account:      Reserve, BSB 062-000, account ending in 321');
    expect(body).toContain('Previous account: Operating, BSB 062-000, account ending in 678');
    expect(body).toContain('Requested by:     Fiona Admin (fiona.admin@notice.test)');
    expect(body).toContain('Approved by:      Oscar Owner (oscar.owner@notice.test)');
    expect(body).toContain('Only the last 3 digits of account numbers are shown');
    expect(body).toContain('This email contains no links');
    expect(body).toContain('If you did not expect this change');
    expect(body).toContain('phone number you already know');
    // No link of any kind, no account holder name typed by the requester, no masked stars.
    expect(last.raw).not.toMatch(/https?:|www\.|<a\s|Harbour Reserve|\*\*\*/i);

    const notices = await remittanceNotices(c2);
    expect(notices.map((n) => [n.recipient_email, n.status])).toEqual([
      ['fiona.admin@notice.test', 'sent'],
      ['oscar.owner@notice.test', 'sent'],
    ]);
    expect(notices.every((n) => n.sent_at instanceof Date)).toBe(true);
    const [first] = notices;
    expect(await deliveriesOf(first?.id ?? '')).toEqual([
      expect.objectContaining({
        notice_kind: 'remittance_account_changed',
        attempt: 1,
        outcome: 'sent',
        to_addr: 'fiona.admin@notice.test',
        next_attempt_at: null,
      }),
    ]);
  });

  it('SS-PLAT-145 a redelivery sends nothing again [T-0197]', async () => {
    const before = sink.messages.length;
    const r = await dispatchSecurityNotices(f.db, f.tenantId, { sender, now: new Date() });
    expect(r).toEqual({ sent: 0, failed: 0 });
    expect(sink.messages).toHaveLength(before);
    for (const n of await remittanceNotices(c2)) expect(await deliveriesOf(n.id)).toHaveLength(1);
  });

  it('SS-PLAT-145 two dispatchers running at once send each notice exactly once [T-0197]', async () => {
    const before = sink.messages.length;
    const c3 = await remittanceChange(f.tenantId, f.companyId, operating, fa, owner);
    const now = new Date();
    const [a, b] = await Promise.all([
      dispatchSecurityNotices(f.db, f.tenantId, { sender, now }),
      dispatchSecurityNotices(f.db, f.tenantId, { sender, now }),
    ]);
    expect((a?.sent ?? 0) + (b?.sent ?? 0)).toBe(2);
    expect(sink.messages).toHaveLength(before + 2);
    for (const n of await remittanceNotices(c3)) {
      expect(n.status).toBe('sent');
      expect((await deliveriesOf(n.id)).map((d) => d.outcome)).toEqual(['sent']);
    }
  });
});

describe('SS-PLAT-146: a bank-detail change notice is emailed to the previous remittance contact', () => {
  it('SS-PLAT-146 the supplier contact gets one masked notice; a no_recipient notice is never sent [T-0197]', async () => {
    const office = await supplier('Office Supplies Pty Ltd', 'accounts@office-supplies.test');
    const first = await bankDetailChange(office, '111222333');
    const second = await bankDetailChange(office, '987654321');
    const lonely = await supplier('No Contact Pty Ltd', null);
    const silent = await bankDetailChange(lonely, '555666777');
    const before = sink.messages.length;

    const r = await dispatchSecurityNotices(f.db, f.tenantId, { sender, now: new Date() });

    expect(r).toEqual({ sent: 2, failed: 0 });
    expect(sink.messages).toHaveLength(before + 2);
    const mails = to('accounts@office-supplies.test');
    expect(mails).toHaveLength(2);
    const { headers, body } = parse(mails[1] as SunkMessage);
    expect(headers).toContain(
      'Subject: Security notice: the bank details Harbour & Co Pty Ltd holds for Office Supplies Pty Ltd were changed',
    );
    expect(headers).toMatch(/Content-Type: text\/plain/i);
    expect(body).toContain('Hello Accounts Team');
    expect(body).toContain('New account:      BSB 062-000, account ending in 321');
    expect(body).toContain('Previous account: BSB 062-000, account ending in 333');
    expect(body).toContain('Harbour & Co Pty Ltd will not pay into the new account before');
    expect(body).toContain('contact Harbour & Co Pty Ltd straight away on a phone number');
    expect(body).toContain('This email contains no links');
    expect(mails.map((m) => m.raw).join('\n')).not.toMatch(
      /987654321|111222333|https?:|www\.|\*\*\*/,
    );

    for (const id of [first, second]) {
      const [n] = await bankNotices(id);
      expect(n).toMatchObject({ recipient_email: 'accounts@office-supplies.test', status: 'sent' });
      expect(await deliveriesOf(n?.id ?? '')).toEqual([
        expect.objectContaining({ notice_kind: 'bank_details_changed', outcome: 'sent' }),
      ]);
    }
    const [none] = await bankNotices(silent);
    expect(none).toMatchObject({ recipient_email: null, status: 'no_recipient', sent_at: null });
    expect(await deliveriesOf(none?.id ?? '')).toEqual([]);
  });
});

describe('SS-PLAT-147: SMTP failures are recorded and retried with backoff; tenants stay apart', () => {
  it('SS-PLAT-147 the retry delay doubles from 1 minute and stops growing at 6 hours [T-0197]', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 50].map(securityNoticeRetryDelaySeconds)).toEqual([
      60, 120, 240, 480, 960, 1920, 3840, 7680, 15360, 21600, 21600, 21600,
    ]);
    expect(() => securityNoticeRetryDelaySeconds(0)).toThrow();
  });

  it('SS-PLAT-147 a refused send marks the notice failed, waits out the backoff, then sends it [T-0197]', async () => {
    const c4 = await remittanceChange(f.tenantId, f.companyId, reserve, fa, owner);
    const before = sink.messages.length;
    const t0 = new Date('2026-11-16T10:00:00.000Z');
    sink.rcptReply = '451 4.3.0 Mailbox temporarily unavailable';
    try {
      expect(await dispatchSecurityNotices(f.db, f.tenantId, { sender, now: t0 })).toEqual({
        sent: 0,
        failed: 2,
      });
    } finally {
      sink.rcptReply = null;
    }
    expect(sink.messages).toHaveLength(before);
    const failed = await remittanceNotices(c4);
    expect(failed.map((n) => [n.status, n.sent_at])).toEqual([
      ['failed', null],
      ['failed', null],
    ]);
    const [attempt1] = await deliveriesOf(failed[0]?.id ?? '');
    expect(attempt1).toMatchObject({ attempt: 1, outcome: 'failed', smtp_code: 451 });
    expect(attempt1?.error_message).toMatch(/451/);
    expect(attempt1?.next_attempt_at?.toISOString()).toBe('2026-11-16T10:01:00.000Z');

    // Not due yet: nothing is sent.
    const early = new Date('2026-11-16T10:00:30.000Z');
    expect(await dispatchSecurityNotices(f.db, f.tenantId, { sender, now: early })).toEqual({
      sent: 0,
      failed: 0,
    });
    expect(sink.messages).toHaveLength(before);

    // Due: sent on the second attempt.
    const due = new Date('2026-11-16T10:01:01.000Z');
    expect(await dispatchSecurityNotices(f.db, f.tenantId, { sender, now: due })).toEqual({
      sent: 2,
      failed: 0,
    });
    expect(sink.messages).toHaveLength(before + 2);
    for (const n of await remittanceNotices(c4)) {
      expect(n.status).toBe('sent');
      expect((await deliveriesOf(n.id)).map((d) => [d.attempt, d.outcome])).toEqual([
        [1, 'failed'],
        [2, 'sent'],
      ]);
    }
  });

  it("SS-PLAT-147 a tenant's dispatch never reads or sends another tenant's notices [T-0197]", async () => {
    const other = await withTenant(f.db, OTHER, async (trx) => {
      await trx.insertInto('app.tenant').values({ id: OTHER, name: 'Other Pty Ltd' }).execute();
      const c = await trx
        .insertInto('app.company')
        .values({ name: 'Other Pty Ltd', base_currency: 'AUD' })
        .returning('id')
        .executeTakeFirstOrThrow();
      const chart = await loadChartTemplate(trx, c.id, auServicesSmb);
      const gl = chart.accounts.get('1010') ?? '';
      return {
        companyId: c.id,
        account: await bankAccount(trx, c.id, gl, 'Other Operating', '999'),
        owner: await person(trx, 'Olga Other', ['owner']),
        fa: await person(trx, 'Felix Other', ['finance_admin']),
      };
    });
    const change = await remittanceChange(
      OTHER,
      other.companyId,
      other.account,
      other.fa,
      other.owner,
    );
    const before = sink.messages.length;

    expect(await dispatchSecurityNotices(f.db, f.tenantId, { sender, now: new Date() })).toEqual({
      sent: 0,
      failed: 0,
    });
    expect(sink.messages).toHaveLength(before);
    expect((await remittanceNotices(change)).map((n) => n.status)).toEqual(['pending', 'pending']);

    expect(await dispatchSecurityNotices(f.db, OTHER, { sender, now: new Date() })).toEqual({
      sent: 2,
      failed: 0,
    });
    const sent = sink.messages.slice(before);
    expect(sent.flatMap((m) => m.to).sort()).toEqual([
      'felix.other@notice.test',
      'olga.other@notice.test',
    ]);
    expect(sent.map((m) => m.raw).join('\n')).not.toContain('Harbour');
  });

  it('SS-PLAT-147 lf_app can only append delivery records, and only one sent record per notice [T-0197]', async () => {
    const [n] = await remittanceNotices(
      (
        await f.admin.query<{ change_id: string }>(
          `SELECT change_id FROM app.remittance_account_notice
            WHERE tenant_id = $1 AND status = 'sent' LIMIT 1`,
          [f.tenantId],
        )
      ).rows[0]?.change_id ?? '',
    );
    const noticeId = n?.id ?? '';
    const code = (p: Promise<unknown>) =>
      p.then(
        () => 'no error',
        (e: unknown) => (e as { code?: string }).code ?? String(e),
      );
    const run = (q: string) =>
      code(f.inTenant((trx) => sql.raw(q).execute(trx)));
    expect(await run(`UPDATE app.security_notice_delivery SET outcome = 'failed'`)).toBe('42501');
    expect(await run(`DELETE FROM app.security_notice_delivery`)).toBe('42501');
    expect(
      await run(
        `INSERT INTO app.security_notice_delivery
           (notice_kind, remittance_notice_id, attempt, outcome, to_addr, subject)
         VALUES ('remittance_account_changed', '${noticeId}', 9, 'sent', 'x@notice.test', 'again')`,
      ),
    ).toBe('23505');
  });
});
