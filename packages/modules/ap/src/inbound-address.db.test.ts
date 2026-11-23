/**
 * Inbound addresses (T-0215, ADR-0099 addendum, security review r11 F5), against a real
 * PostgreSQL as lf_app: a superseded address can never become active again (trigger), the token
 * and company are immutable, and creating or rotating an address writes an audit row that does
 * not contain the token.
 */
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureInboxAddress, rotateInboxAddress } from './inbound-webhook.ts';

let f: LedgerFixture;

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000021502');
}, 180_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

// audit.audit_log is insert-only for lf_app: read it as superuser (verification only).
const audit = async () =>
  (
    await f.admin.query<{ action: string; entity_id: string; after: Record<string, unknown> }>(
      `SELECT action, entity_id, after FROM audit.audit_log
        WHERE tenant_id = $1 AND entity_type = 'bill_inbox_address' ORDER BY id`,
      [f.tenantId],
    )
  ).rows;

describe('SS-PLAT-180 inbound addresses only move forward and every change is audited', () => {
  it('SS-PLAT-180 ensure audits the first creation only; rotate audits the new address; tokens never appear in audit', async () => {
    const user = await f.addUser('finance_admin');
    const t1 = await f.inTenant((trx) =>
      ensureInboxAddress(trx, { companyId: f.companyId, createdBy: user }),
    );
    expect(await f.inTenant((trx) => ensureInboxAddress(trx, { companyId: f.companyId }))).toBe(t1);
    const t2 = await f.inTenant((trx) =>
      rotateInboxAddress(trx, { companyId: f.companyId, createdBy: user }),
    );
    expect(t2).not.toBe(t1);
    const rows = await audit();
    expect(rows.map((r) => r.action)).toEqual([
      'ap.inbox_address.created',
      'ap.inbox_address.rotated',
    ]);
    expect(rows[1]?.after).toMatchObject({ companyId: f.companyId, status: 'active' });
    const text = JSON.stringify(rows);
    expect(text).not.toContain(t1);
    expect(text).not.toContain(t2);
  });

  it('SS-PLAT-180 lf_app cannot bring a superseded address back, re-supersede, or change token or company', async () => {
    const tryUpdate = (q: string) =>
      f
        .inTenant((trx) => sql.raw(q).execute(trx))
        .then(
          () => 'updated',
          (e: unknown) => String((e as Error).message),
        );
    const superseded = `SELECT id FROM app.bill_inbox_address WHERE company_id = '${f.companyId}' AND status = 'superseded'`;
    expect(
      await tryUpdate(
        `UPDATE app.bill_inbox_address SET status = 'active' WHERE id IN (${superseded})`,
      ),
    ).toMatch(/only active -> superseded/);
    expect(
      await tryUpdate(
        `UPDATE app.bill_inbox_address SET status = 'superseded' WHERE id IN (${superseded})`,
      ),
    ).toMatch(/only active -> superseded/);
    expect(
      await tryUpdate(`UPDATE app.bill_inbox_address SET token = '${'z'.repeat(26)}'`),
    ).toMatch(/permission denied/);
    // Even a superuser cannot move a row backwards (trigger, not only grants).
    const owner = await f.admin
      .query(
        `UPDATE app.bill_inbox_address SET status = 'active' WHERE tenant_id = $1 AND status = 'superseded'`,
        [f.tenantId],
      )
      .then(
        () => 'updated',
        (e: unknown) => String((e as Error).message),
      );
    expect(owner).toMatch(/only active -> superseded/);
    // A fresh company's address can be superseded directly (the one allowed transition).
    const c = await f.addCompany('Forward Only Pty Ltd');
    await f.inTenant((trx) => ensureInboxAddress(trx, { companyId: c }));
    expect(
      await tryUpdate(
        `UPDATE app.bill_inbox_address SET status = 'superseded' WHERE company_id = '${c}' AND status = 'active'`,
      ),
    ).toBe('updated');
  });
});
