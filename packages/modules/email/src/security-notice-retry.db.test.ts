/**
 * Failed security notices and retry-now (T-0209, ADR-0097, RQ-0179) against a real PostgreSQL as
 * lf_app. Notices are written by the approving transaction (0072 remittance account changes) and
 * fail through the real dispatcher (T-0197) with a refusing sender; time is injected. The
 * superuser only seeds sessions and inspects.
 *
 * SS-PLAT-162 (db) — a failed notice is listed in its own tenant with attempts, the last SMTP
 *   code and the next attempt time; the recipient is masked, also inside the error text.
 * SS-PLAT-163 (db) — retry-now appends one app.security_notice_retry row (nothing updated or
 *   deleted); the next dispatch sends the notice although its backoff has not run out; other
 *   failed notices keep their backoff; a second request adds nothing; a sent notice is refused.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { approveRemittanceAccountChange, requestRemittanceAccountChange } from '@ledgerforce/ar';
import { withTenant, type Database } from '@ledgerforce/db';
import { auServicesSmb, loadChartTemplate } from '@ledgerforce/gl';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { sql, type Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatchSecurityNotices } from './security-notice-email.ts';
import {
  listFailedSecurityNotices,
  maskEmailAddress,
  requestSecurityNoticeRetry,
  SecurityNoticeRetryRefused,
} from './security-notice-retry.ts';
import type { EmailMessage, EmailSender } from './sender.ts';

type Trx = Transaction<Database>;

const TENANT = '01900000-0000-7000-8000-000000020901';
const OTHER = '01900000-0000-7000-8000-000000020902';

/** A sender that refuses every recipient as an SMTP server would (nodemailer error shape). */
class RefusingSender implements EmailSender {
  readonly tried: string[] = [];
  async send(m: EmailMessage): Promise<string> {
    this.tried.push(...m.to);
    const e = new Error(
      `Can't send mail - all recipients were rejected: 550 5.1.1 <${m.to.join(',')}>: Recipient address rejected`,
    ) as Error & { code: string; responseCode: number };
    e.code = 'EENVELOPE';
    e.responseCode = 550;
    return Promise.reject(e);
  }
}

class AcceptingSender implements EmailSender {
  readonly sent: string[] = [];
  async send(m: EmailMessage): Promise<string> {
    this.sent.push(...m.to);
    return Promise.resolve(`<${randomUUID()}@sink.test>`);
  }
}

let f: LedgerFixture;
let account1 = '';
let account2 = '';
let owner = '';
let fa = '';

async function bankAccount(trx: Trx, companyId: string, glAccountId: string, last3: string) {
  const id = randomUUID();
  await trx
    .insertInto('app.bank_account')
    .values({
      id,
      company_id: companyId,
      gl_account_id: glAccountId,
      name: `Account ${last3}`,
      currency: 'AUD',
      bsb: '062-000',
      account_name: 'Harbour',
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

async function person(trx: Trx, email: string, role: string): Promise<string> {
  const u = await trx
    .insertInto('app.app_user')
    .values({ email, display_name: email.split('@')[0] ?? 'x', status: 'active' })
    .returning('id')
    .executeTakeFirstOrThrow();
  await trx.insertInto('app.user_role').values({ user_id: u.id, role }).execute();
  return u.id;
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

const noticeOf = async (changeId: string, email: string): Promise<string> =>
  (
    await f.admin.query<{ id: string }>(
      `SELECT id FROM app.remittance_account_notice WHERE change_id = $1 AND recipient_email = $2`,
      [changeId, email],
    )
  ).rows[0]?.id ?? '';

const attempts = async (noticeId: string) =>
  (
    await f.admin.query<{ attempt: number; outcome: string; next_attempt_at: Date | null }>(
      `SELECT attempt, outcome, next_attempt_at FROM app.security_notice_delivery
        WHERE remittance_notice_id = $1 ORDER BY attempt`,
      [noticeId],
    )
  ).rows;

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'no error',
    (e: unknown) => (e as { code?: string }).code ?? String(e),
  );

let changeId = '';
let ownerNotice = '';
let faNotice = '';
const T0 = new Date('2026-11-20T00:00:00.000Z');

beforeAll(async () => {
  f = await createLedgerFixture(TENANT);
  await f.inTenant(async (trx) => {
    account1 = await bankAccount(trx, f.companyId, f.acct['1010'] ?? '', '678');
    account2 = await bankAccount(trx, f.companyId, f.acct['1020'] ?? '', '321');
    owner = await person(trx, 'oscar.owner@retry.test', 'owner');
    fa = await person(trx, 'fiona.admin@retry.test', 'finance_admin');
  });
  await remittanceChange(f.tenantId, f.companyId, account1, fa, owner);
  // The first change's notices are sent; the second change's fail eleven times (backoff at 6 h).
  await dispatchSecurityNotices(f.db, f.tenantId, { sender: new AcceptingSender(), now: T0 });
  changeId = await remittanceChange(f.tenantId, f.companyId, account2, fa, owner);
  ownerNotice = await noticeOf(changeId, 'oscar.owner@retry.test');
  faNotice = await noticeOf(changeId, 'fiona.admin@retry.test');
  let t = T0.getTime();
  for (let i = 0; i < 11; i += 1) {
    const r = await dispatchSecurityNotices(f.db, f.tenantId, {
      sender: new RefusingSender(),
      now: new Date(t),
    });
    expect(r).toEqual({ sent: 0, failed: 2 });
    t += 6 * 60 * 60 * 1000;
  }
}, 180_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

describe('SS-PLAT-162: failed security notices are listed in their tenant, masked', () => {
  it('SS-PLAT-162 masks an address to its first character and domain [T-0209]', () => {
    expect(maskEmailAddress('oscar.owner@retry.test')).toBe('o•••@retry.test');
    expect(maskEmailAddress('a@b.test')).toBe('a•••@b.test');
  });

  it('SS-PLAT-162 lists each failed notice with attempts, last SMTP code and next attempt time [T-0209]', async () => {
    const list = await withTenant(f.db, f.tenantId, (trx) => listFailedSecurityNotices(trx));
    expect(list.map((n) => n.id).sort()).toEqual([faNotice, ownerNotice].sort());
    const n = list.find((x) => x.id === ownerNotice);
    const last = (await attempts(ownerNotice)).at(-1);
    expect(n).toEqual({
      kind: 'remittance_account_changed',
      id: ownerNotice,
      context: 'Harbour & Co Pty Ltd',
      accountLast3: '321',
      recipient: 'o•••@retry.test',
      createdAt: expect.any(Date) as Date,
      attempts: 11,
      lastAttemptAt: expect.any(Date) as Date,
      lastSmtpCode: 550,
      lastErrorCode: 'EENVELOPE',
      lastErrorMessage:
        "Can't send mail - all recipients were rejected: 550 5.1.1 <o•••@retry.test>: Recipient address rejected",
      nextAttemptAt: last?.next_attempt_at,
      retryRequested: false,
    });
    // Nothing in the list carries a clear address.
    expect(JSON.stringify(list)).not.toMatch(/oscar\.owner|fiona\.admin/);
  });

  it("SS-PLAT-162 another tenant lists none of this tenant's notices [T-0209]", async () => {
    await withTenant(f.db, OTHER, async (trx) => {
      await trx.insertInto('app.tenant').values({ id: OTHER, name: 'Other Pty Ltd' }).execute();
      const c = await trx
        .insertInto('app.company')
        .values({ name: 'Other Pty Ltd', base_currency: 'AUD' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await loadChartTemplate(trx, c.id, auServicesSmb);
    });
    expect(await withTenant(f.db, OTHER, (trx) => listFailedSecurityNotices(trx))).toEqual([]);
    await expect(
      withTenant(f.db, OTHER, (trx) =>
        requestSecurityNoticeRetry(trx, {
          kind: 'remittance_account_changed',
          noticeId: ownerNotice,
          requestedBy: owner,
        }),
      ),
    ).rejects.toMatchObject({ reason: 'NOT_FOUND' });
  });
});

describe('SS-PLAT-163: retry-now makes a failed notice due at the next dispatch, append-only', () => {
  it('SS-PLAT-163 a request appends one row; the next dispatch sends that notice only [T-0209]', async () => {
    const before = await attempts(ownerNotice);
    const latest = before.at(-1);
    if (!latest?.next_attempt_at) throw new Error('no failed attempt');
    // One minute after the last failure: the 6 h backoff has not run out.
    const soon = new Date(latest.next_attempt_at.getTime() - 6 * 60 * 60 * 1000 + 60_000);
    const quiet = new AcceptingSender();
    expect(await dispatchSecurityNotices(f.db, f.tenantId, { sender: quiet, now: soon })).toEqual({
      sent: 0,
      failed: 0,
    });

    const r = await withTenant(f.db, f.tenantId, (trx) =>
      requestSecurityNoticeRetry(trx, {
        kind: 'remittance_account_changed',
        noticeId: ownerNotice,
        requestedBy: fa,
      }),
    );
    expect(r.created).toBe(true);
    expect(r.notice).toMatchObject({ id: ownerNotice, attempts: 11, retryRequested: true });
    const rows = await f.admin.query<{
      notice_kind: string;
      remittance_notice_id: string;
      after_attempt: number;
      requested_by: string;
    }>(
      `SELECT notice_kind, remittance_notice_id, after_attempt, requested_by
         FROM app.security_notice_retry WHERE tenant_id = $1`,
      [f.tenantId],
    );
    expect(rows.rows).toEqual([
      {
        notice_kind: 'remittance_account_changed',
        remittance_notice_id: ownerNotice,
        after_attempt: 11,
        requested_by: fa,
      },
    ]);
    // History unchanged: the same attempts, the notice still failed.
    expect(await attempts(ownerNotice)).toEqual(before);

    const sender = new AcceptingSender();
    expect(await dispatchSecurityNotices(f.db, f.tenantId, { sender, now: soon })).toEqual({
      sent: 1,
      failed: 0,
    });
    expect(sender.sent).toEqual(['oscar.owner@retry.test']);
    expect((await attempts(ownerNotice)).map((a) => [a.attempt, a.outcome]).at(-1)).toEqual([
      12,
      'sent',
    ]);
    // The Finance Admin's notice was not released: it keeps its backoff and stays listed.
    const list = await withTenant(f.db, f.tenantId, (trx) => listFailedSecurityNotices(trx));
    expect(list.map((n) => n.id)).toEqual([faNotice]);
  });

  it('SS-PLAT-163 a second request for the same failed attempt adds nothing [T-0209]', async () => {
    const first = await withTenant(f.db, f.tenantId, (trx) =>
      requestSecurityNoticeRetry(trx, {
        kind: 'remittance_account_changed',
        noticeId: faNotice,
        requestedBy: owner,
      }),
    );
    const again = await withTenant(f.db, f.tenantId, (trx) =>
      requestSecurityNoticeRetry(trx, {
        kind: 'remittance_account_changed',
        noticeId: faNotice,
        requestedBy: fa,
      }),
    );
    expect([first.created, again.created]).toEqual([true, false]);
    expect(again.notice).toMatchObject({ id: faNotice, retryRequested: true });
    const n = await f.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.security_notice_retry WHERE remittance_notice_id = $1`,
      [faNotice],
    );
    expect(n.rows[0]?.n).toBe(1);
  });

  it('SS-PLAT-163 a sent notice cannot be retried; unknown ids are not found [T-0209]', async () => {
    const asTenant = (noticeId: string) =>
      withTenant(f.db, f.tenantId, (trx) =>
        requestSecurityNoticeRetry(trx, {
          kind: 'remittance_account_changed',
          noticeId,
          requestedBy: owner,
        }),
      );
    await expect(asTenant(ownerNotice)).rejects.toBeInstanceOf(SecurityNoticeRetryRefused);
    await expect(asTenant(ownerNotice)).rejects.toMatchObject({ reason: 'NOT_FAILED' });
    await expect(asTenant(randomUUID())).rejects.toMatchObject({ reason: 'NOT_FOUND' });
  });

  it('SS-PLAT-163 lf_app can only append retry rows, and only for the latest failed attempt [T-0209]', async () => {
    const run = (q: string) => code(f.inTenant((trx) => sql.raw(q).execute(trx)));
    expect(await run(`UPDATE app.security_notice_retry SET after_attempt = 1`)).toBe('42501');
    expect(await run(`DELETE FROM app.security_notice_retry`)).toBe('42501');
    // An older failed attempt of a still-failed notice: refused by the guard.
    const stale = await run(
      `INSERT INTO app.security_notice_retry
         (notice_kind, remittance_notice_id, after_attempt, requested_by)
       VALUES ('remittance_account_changed', '${faNotice}', 3, '${owner}')`,
    );
    expect(stale).toBe('23514');
    // A sent notice: refused by the guard.
    const sent = await run(
      `INSERT INTO app.security_notice_retry
         (notice_kind, remittance_notice_id, after_attempt, requested_by)
       VALUES ('remittance_account_changed', '${ownerNotice}', 12, '${owner}')`,
    );
    expect(sent).toBe('23514');
  });
});
