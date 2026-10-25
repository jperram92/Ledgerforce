/**
 * SS-UC06-05 and SS-UC06-09 (database layer) — bank-detail change verification with cooling-off
 * (T-0053, design §6.1, §6.5 rule 2, RQ-0034, ADR-0030). Real database, lf_app only; the
 * superuser seeds users and sessions and, for SS-UC06-05, moves a verification 3 hours into the
 * past (test data only, triggers off in that one transaction).
 *
 * The API layer (SoD engine and step-up on real routes) is proven in
 * apps/api/src/parties/bank-change.workflow.db.test.ts.
 */
import { createDb, withTenant, type Database } from '@ledgerforce/db';
import { createTestDatabase, type TestDatabase } from '@ledgerforce/db/testing';
import { LocalKeyringKms } from '@ledgerforce/shared/crypto';
import { permissionsOf, ROLE_TEMPLATES } from '@ledgerforce/shared/rbac';
import { randomBytes } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addBankAccount, listBankAccounts } from './bank-accounts.ts';
import {
  BankDetailChangeRefused,
  DEFAULT_COOLING_OFF_HOURS,
  paymentEligibility,
  rejectBankDetailChange,
  requestBankDetailChange,
  setBankDetailCoolingOff,
  verifyBankDetailChange,
} from './bank-detail-changes.ts';
import { addContact, createParty, setContactRole } from './parties.ts';

const T = '01900000-0000-7000-8000-000000053aaa';
const uid = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const USERS = {
  apClerk: { id: uid(0x5301), roles: ['ap_clerk'] },
  owner: { id: uid(0x5302), roles: ['owner'] },
  owner2: { id: uid(0x5303), roles: ['owner'] },
  apClerk2: { id: uid(0x5304), roles: ['ap_clerk'] },
} as const;
type Who = keyof typeof USERS;

let tdb: TestDatabase;
let db: Kysely<Database>;
let companyId: string;
const kms = LocalKeyringKms.fromJson(
  JSON.stringify({ active: 'k1', keys: { k1: randomBytes(32).toString('base64') } }),
);
const inTenant = <R>(fn: (trx: Transaction<Database>) => Promise<R>) => withTenant(db, T, fn);
const NOTE = 'Phoned Jo Smith on the number on file (02 9000 0000); she confirmed the new account.';

/** A session of `who` whose last authentication was `ageSeconds` ago (MFA unless told otherwise). */
async function session(
  who: Who,
  opts: { ageSeconds?: number; amr?: string[]; revoked?: boolean } = {},
): Promise<string> {
  const { rows } = await tdb.admin.query<{ id: string }>(
    `INSERT INTO app.session (tenant_id, user_id, secret_sha256, created_at, last_seen_at,
                              absolute_expires_at, idle_timeout_seconds, user_session_epoch,
                              amr, acr, auth_time, revoked_at, revoke_reason)
     VALUES ($1, $2, $3, clock_timestamp() - interval '1 hour', clock_timestamp(),
             clock_timestamp() + interval '11 hours', 1800,
             (SELECT session_epoch FROM app.app_user WHERE tenant_id = $1 AND id = $2), $4, NULL,
             clock_timestamp() - make_interval(secs => $5), $6, $7)
     RETURNING id`,
    [
      T,
      USERS[who].id,
      randomBytes(32).toString('hex'),
      opts.amr ?? ['pwd', 'otp'],
      opts.ageSeconds ?? 5,
      opts.revoked ? new Date() : null,
      opts.revoked ? 'test' : null,
    ],
  );
  return rows[0]?.id ?? '';
}

let n = 0;
/** A supplier with a remittance contact and (optionally) nothing else. */
async function supplier(email = 'remit@supplier.test'): Promise<string> {
  n += 1;
  return inTenant(async (trx) => {
    const p = await createParty(trx, companyId, {
      legalName: `Supplier ${String(n)} Pty Ltd`,
      roles: ['supplier'],
    });
    const c = await addContact(trx, companyId, p, { name: `Remit ${String(n)}`, email });
    await setContactRole(trx, c, 'remittance', true);
    return p;
  });
}

const ACCOUNT = {
  bsb: '062-000',
  accountNumber: '123456789',
  accountName: 'Supplier',
  source: 'ui',
} as const;

async function request(partyId: string, who: Who = 'apClerk', accountNumber = '123456789') {
  const sid = await session(who);
  return inTenant((trx) =>
    requestBankDetailChange(trx, kms, {
      partyId,
      account: { ...ACCOUNT, accountNumber },
      requestedBy: USERS[who].id,
      sessionId: sid,
    }),
  );
}

async function verify(changeId: string, who: Who = 'owner', note = NOTE) {
  const sid = await session(who);
  return inTenant((trx) =>
    verifyBankDetailChange(trx, {
      changeId,
      verifiedBy: USERS[who].id,
      sessionId: sid,
      confirmationNote: note,
    }),
  );
}

async function change(id: string): Promise<Record<string, unknown>> {
  const { rows } = await tdb.admin.query(`SELECT * FROM app.bank_detail_change WHERE id = $1`, [
    id,
  ]);
  return rows[0] ?? {};
}

async function sqlState(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code ?? `no code: ${String(e)}`;
  }
  return 'no error';
}

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: true });
  db = createDb(tdb.url('lf_app'), 2);
  await tdb.admin.query(`INSERT INTO app.tenant (id, name) VALUES ($1, 'Harbour & Co Pty Ltd')`, [
    T,
  ]);
  for (const [who, u] of Object.entries(USERS)) {
    await tdb.admin.query(
      `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, $3, $4, 'active')`,
      [u.id, T, `${who}@bank.test`, who],
    );
    for (const role of u.roles) {
      await tdb.admin.query(
        'INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, $3)',
        [T, u.id, role],
      );
    }
  }
  companyId = await inTenant(async (trx) => {
    const c = await trx
      .insertInto('app.company')
      .values({ name: 'Harbour & Co Pty Ltd', base_currency: 'AUD' })
      .returning('id')
      .executeTakeFirstOrThrow();
    return c.id;
  });
});

afterAll(async () => {
  await db.destroy();
  await tdb.close();
});

describe('SS-UC06-09: Bank-detail change needs a different verifier and notifies the old contact (database layer)', () => {
  it('A requests; A cannot verify; B verifies with step-up; the old contact is notified; cooling-off starts', async () => {
    const party = await supplier('accounts@office-supplies.test');
    // The current, verified account (paid until now).
    const first = await request(party, 'apClerk', '111222333');
    await verify(first.changeId, 'owner');

    const { changeId, bankAccountId } = await request(party, 'apClerk', '987654321');
    expect(await change(changeId)).toMatchObject({
      status: 'requested',
      requested_by: USERS.apClerk.id,
      previous_bank_account_id: first.bankAccountId,
    });
    // The contact is edited after the request: the notice still goes to the one on file then.
    await inTenant((trx) =>
      sql`UPDATE app.party_contact SET email = 'attacker@evil.test' WHERE party_id = ${party}`.execute(
        trx,
      ),
    );

    // A (who requested) holds no verify permission and, even as an Owner, is not the verifier.
    await expect(verify(changeId, 'apClerk')).rejects.toMatchObject({ reason: 'NOT_PERMITTED' });

    const after = await verify(changeId, 'owner');
    const row = await change(changeId);
    expect(row).toMatchObject({
      status: 'verified',
      decided_by: USERS.owner.id,
      cooling_off_hours: 24,
    });
    expect(row.decision_note).toBe(NOTE);
    expect((row.payable_from as Date).getTime() - (row.decided_at as Date).getTime()).toBe(
      24 * 3600 * 1000,
    );
    expect(after.payableFrom.getTime()).toBe((row.payable_from as Date).getTime());

    // The new account is active, the old one superseded.
    const accounts = await inTenant((trx) => listBankAccounts(trx, party));
    expect(accounts.find((a) => a.id === bankAccountId)?.status).toBe('active');
    expect(accounts.find((a) => a.id === first.bankAccountId)?.status).toBe('superseded');

    // The previous remittance contact is notified, with masked details only.
    const { rows: notices } = await tdb.admin.query(
      `SELECT recipient_email, status, kind, payload::text AS payload FROM app.bank_detail_change_notice
        WHERE change_id = $1`,
      [changeId],
    );
    expect(notices).toEqual([
      {
        recipient_email: 'accounts@office-supplies.test',
        status: 'pending',
        kind: 'bank_details_changed',
        payload: expect.any(String),
      },
    ]);
    const payload = notices[0]?.payload as string;
    expect(payload).toContain('***321');
    expect(payload).toContain('***333');
    expect(payload).not.toContain('987654321');
    expect(payload).not.toContain('111222333');

    // Cooling-off has started: the party is not payable, with the reason.
    const [e] = await inTenant((trx) => paymentEligibility(trx, [party]));
    expect(e).toMatchObject({
      partyId: party,
      eligible: false,
      reason: 'BANK_DETAILS_COOLING_OFF',
      bankAccountId,
    });
    expect(e?.payableFrom?.getTime()).toBe((row.payable_from as Date).getTime());

    // Audited: request and verification.
    const { rows: audit } = await tdb.admin.query(
      `SELECT action, actor_user_id FROM audit.audit_log
        WHERE tenant_id = $1 AND entity_type = 'bank_detail_change' AND entity_id = $2 ORDER BY id`,
      [T, changeId],
    );
    expect(audit).toEqual([
      { action: 'bank_detail_change.requested', actor_user_id: USERS.apClerk.id },
      { action: 'bank_detail_change.verified', actor_user_id: USERS.owner.id },
    ]);
  });

  it('the requester cannot verify their own change, even holding the verify permission (Owner too)', async () => {
    const party = await supplier();
    const { changeId } = await request(party, 'owner');
    await expect(verify(changeId, 'owner')).rejects.toMatchObject({ code: '23514' });
    expect(await change(changeId)).toMatchObject({ status: 'requested', decided_by: null });
    // A different Owner can.
    await verify(changeId, 'owner2');
    expect(await change(changeId)).toMatchObject({ status: 'verified' });
  });

  it('small-team mode: a self-verification commits only with small-team mode on and a recorded SOD_BANK_DETAIL_SELF_VERIFY exception', async () => {
    const party = await supplier();
    const { changeId } = await request(party, 'owner');
    const selfVerifyWithException = async () => {
      const sid = await session('owner');
      await inTenant(async (trx) => {
        await verifyBankDetailChange(trx, {
          changeId,
          verifiedBy: USERS.owner.id,
          sessionId: sid,
          confirmationNote: NOTE,
        });
        // What the SoD interceptor writes after the handler (ADR-0026), before COMMIT.
        await sql`INSERT INTO app.sod_exception (rule, subject_type, subject_id, step, actor_user_id, kind, reason)
                  VALUES ('SOD_BANK_DETAIL_SELF_VERIFY', 'bank_detail_change', ${changeId},
                          'bank_detail_change.verify', ${USERS.owner.id}, 'recorded_exception',
                          'Sole owner; accountant on leave')`.execute(trx);
      });
    };
    const smallTeam = (on: boolean) =>
      inTenant((trx) =>
        sql`INSERT INTO app.sod_settings (small_team_mode, set_by, reason)
            VALUES (${on}, ${USERS.owner.id}, 'test')`.execute(trx),
      );
    // Without small-team mode an exception row does not excuse it.
    await expect(selfVerifyWithException()).rejects.toMatchObject({ code: '23514' });
    expect(await change(changeId)).toMatchObject({ status: 'requested' });
    await smallTeam(true);
    try {
      await selfVerifyWithException();
    } finally {
      await smallTeam(false);
    }
    expect(await change(changeId)).toMatchObject({
      status: 'verified',
      decided_by: USERS.owner.id,
    });
  });

  it('the verifier needs a fresh MFA step-up (≤ 300 s, own, unrevoked session) and an out-of-band note', async () => {
    const party = await supplier();
    const { changeId } = await request(party);
    const attempt = (sid: string, by: Who = 'owner', note = NOTE) =>
      inTenant((trx) =>
        verifyBankDetailChange(trx, {
          changeId,
          verifiedBy: USERS[by].id,
          sessionId: sid,
          confirmationNote: note,
        }),
      );
    for (const sid of [
      await session('owner', { ageSeconds: 301 }),
      await session('owner', { amr: ['pwd'] }),
      await session('owner', { revoked: true }),
      await session('owner2'), // someone else's fresh session
    ]) {
      await expect(attempt(sid)).rejects.toMatchObject({ reason: 'STEP_UP_REQUIRED' });
    }
    await expect(attempt(await session('owner'), 'owner', '   ')).rejects.toMatchObject({
      reason: 'CONFIRMATION_NOTE_REQUIRED',
    });
    expect(await change(changeId)).toMatchObject({ status: 'requested' });
    await attempt(await session('owner', { ageSeconds: 290 }));
    expect(await change(changeId)).toMatchObject({ status: 'verified' });
    // Verified once: a second verification is refused.
    await expect(attempt(await session('owner2'), 'owner2')).rejects.toMatchObject({
      reason: 'NOT_PENDING',
    });
  });

  it('the requester needs the change_request permission and a fresh step-up; one open change per party', async () => {
    const party = await supplier();
    const sid = await session('owner2');
    // Owner2's session used for apClerk → refused (step-up belongs to another user).
    await expect(
      inTenant((trx) =>
        requestBankDetailChange(trx, kms, {
          partyId: party,
          account: ACCOUNT,
          requestedBy: USERS.apClerk.id,
          sessionId: sid,
        }),
      ),
    ).rejects.toMatchObject({ reason: 'STEP_UP_REQUIRED' });
    await request(party);
    await expect(request(party, 'apClerk2')).rejects.toMatchObject({
      reason: 'OPEN_CHANGE_EXISTS',
    });
    expect(await inTenant((trx) => listBankAccounts(trx, party))).toHaveLength(1);
  });

  it('a rejected change archives the new account and frees the party for a new request', async () => {
    const party = await supplier();
    const { changeId, bankAccountId } = await request(party);
    await inTenant((trx) =>
      rejectBankDetailChange(trx, {
        changeId,
        rejectedBy: USERS.owner.id,
        reason: 'Supplier says they never asked',
      }),
    );
    expect(await change(changeId)).toMatchObject({
      status: 'rejected',
      decided_by: USERS.owner.id,
    });
    const [acct] = await inTenant((trx) => listBankAccounts(trx, party));
    expect(acct).toMatchObject({ id: bankAccountId, status: 'archived' });
    const [e] = await inTenant((trx) => paymentEligibility(trx, [party]));
    expect(e).toMatchObject({
      eligible: false,
      reason: 'NO_VERIFIED_BANK_DETAILS',
      bankAccountId: null,
    });
    await expect(verify(changeId)).rejects.toMatchObject({ reason: 'NOT_PENDING' });
    await request(party, 'apClerk2');
  });

  it('nothing bypasses the workflow: no active account without a verified change, no direct writes', async () => {
    const party = await supplier();
    const pending = await inTenant((trx) =>
      addBankAccount(trx, kms, companyId, party, { ...ACCOUNT, createdBy: USERS.apClerk.id }),
    );
    // lf_app cannot switch an account active, insert an active one, or write the workflow tables.
    expect(
      await sqlState(
        inTenant((trx) =>
          sql`UPDATE app.party_bank_account SET status = 'active' WHERE id = ${pending}`.execute(
            trx,
          ),
        ),
      ),
    ).toBe('23514');
    expect(
      await sqlState(
        inTenant((trx) =>
          sql`INSERT INTO app.party_bank_account (id, company_id, party_id, bsb, account_name, account_number_last3,
                account_number_ct, account_number_iv, account_number_tag, dek_wrapped, kek_id, enc_version, source, status)
              SELECT app.uuid_generate_v7(), company_id, party_id, bsb, account_name, account_number_last3,
                account_number_ct, account_number_iv, account_number_tag, dek_wrapped, kek_id, enc_version, source, 'active'
                FROM app.party_bank_account WHERE id = ${pending}`.execute(trx),
        ),
      ),
    ).toBe('23514');
    for (const stmt of [
      sql`UPDATE app.bank_detail_change SET status = 'verified'`,
      sql`INSERT INTO app.bank_detail_change (company_id, party_id, bank_account_id, requested_by)
          VALUES (${companyId}, ${party}, ${pending}, ${USERS.apClerk.id})`,
      sql`INSERT INTO app.bank_detail_change_notice (change_id, kind, payload) SELECT id, 'bank_details_changed', '{}' FROM app.bank_detail_change LIMIT 1`,
      sql`DELETE FROM app.bank_detail_change`,
    ]) {
      expect(await sqlState(inTenant((trx) => stmt.execute(trx)))).toBe('42501');
    }
    // The table owner cannot rewrite history either.
    expect(
      await sqlState(
        tdb.admin.query(
          `UPDATE app.bank_detail_change SET decision_note = 'x' WHERE status = 'verified'`,
        ),
      ),
    ).toBe('23514');
    expect(await sqlState(tdb.admin.query(`DELETE FROM app.bank_detail_change`))).toBe('23514');
    // A superseded or archived account is final.
    const { rows } = await tdb.admin.query<{ id: string }>(
      `SELECT id FROM app.party_bank_account WHERE tenant_id = $1 AND status = 'superseded' LIMIT 1`,
      [T],
    );
    expect(
      await sqlState(
        inTenant((trx) =>
          sql`UPDATE app.party_bank_account SET status = 'pending_verification' WHERE id = ${rows[0]?.id ?? ''}`.execute(
            trx,
          ),
        ),
      ),
    ).toBe('23514');
  });

  it('the SQL permission mirror equals the role catalogue for change_request and verify', async () => {
    for (const role of Object.keys(ROLE_TEMPLATES)) {
      for (const permission of [
        'parties.bank_account.change_request',
        'parties.bank_account.verify',
      ] as const) {
        const { rows } = await tdb.admin.query<{ ok: boolean }>(
          'SELECT app.role_allows_bank_detail_permission($1, $2) AS ok',
          [role, permission],
        );
        expect(rows[0]?.ok, `${role} ${permission}`).toBe(permissionsOf([role]).has(permission));
      }
    }
  });
});

describe('SS-UC06-05: Recently changed bank details excluded with reason', () => {
  /** Request + verify, then move the whole change `hours` into the past (test data). */
  async function verifiedHoursAgo(party: string, hours: number): Promise<string> {
    const { changeId } = await request(party);
    await verify(changeId);
    const client = await tdb.admin.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role = replica');
      await client.query(
        `UPDATE app.bank_detail_change
            SET requested_at = requested_at - make_interval(hours => $2),
                decided_at = decided_at - make_interval(hours => $2),
                payable_from = payable_from - make_interval(hours => $2)
          WHERE id = $1`,
        [changeId, hours],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    return changeId;
  }

  it('a supplier verified 3 hours ago is excluded with BANK_DETAILS_COOLING_OFF; 25 hours ago is payable', async () => {
    const recent = await supplier();
    const settled = await supplier();
    const none = await supplier();
    const recentChange = await verifiedHoursAgo(recent, 3);
    await verifiedHoursAgo(settled, 25);

    const result = await inTenant((trx) => paymentEligibility(trx, [recent, settled, none]));
    const byParty = new Map(result.map((r) => [r.partyId, r]));
    const payableFrom = (await change(recentChange)).payable_from as Date;
    expect(byParty.get(recent)).toMatchObject({
      eligible: false,
      reason: 'BANK_DETAILS_COOLING_OFF',
      payableFrom,
    });
    // 21 hours still to wait (24 h default − 3 h), by the database clock.
    const left = payableFrom.getTime() - Date.now();
    expect(left).toBeGreaterThan(20.9 * 3600 * 1000);
    expect(left).toBeLessThan(21.1 * 3600 * 1000);
    expect(byParty.get(settled)).toMatchObject({ eligible: true, reason: null });
    expect(byParty.get(none)).toMatchObject({
      eligible: false,
      reason: 'NO_VERIFIED_BANK_DETAILS',
      bankAccountId: null,
    });
    expect(result).toHaveLength(3);
  });

  it('the cooling-off length is tenant configuration (Owner only, audited), frozen per change at verification', async () => {
    expect(DEFAULT_COOLING_OFF_HOURS).toBe(24);
    await expect(
      inTenant((trx) =>
        setBankDetailCoolingOff(trx, { hours: 1, setBy: USERS.apClerk.id, reason: 'faster' }),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      inTenant((trx) =>
        setBankDetailCoolingOff(trx, { hours: 0, setBy: USERS.owner.id, reason: 'none' }),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    const before = await supplier();
    const beforeChange = await verifiedHoursAgo(before, 0);

    await inTenant((trx) =>
      setBankDetailCoolingOff(trx, {
        hours: 48,
        setBy: USERS.owner.id,
        reason: 'Board decision 2026-10',
      }),
    );
    const party = await supplier();
    const { changeId } = await request(party);
    await verify(changeId);
    const row = await change(changeId);
    expect(row.cooling_off_hours).toBe(48);
    expect((row.payable_from as Date).getTime() - (row.decided_at as Date).getTime()).toBe(
      48 * 3600 * 1000,
    );
    // Earlier verifications keep the length in force when they were verified.
    expect((await change(beforeChange)).cooling_off_hours).toBe(24);
    const { rows } = await tdb.admin.query(
      `SELECT actor_user_id, after->>'cooling_off_hours' AS hours FROM audit.audit_log
        WHERE tenant_id = $1 AND action = 'bank_detail.settings_changed'`,
      [T],
    );
    expect(rows).toEqual([{ actor_user_id: USERS.owner.id, hours: '48' }]);
    await inTenant((trx) =>
      setBankDetailCoolingOff(trx, {
        hours: 24,
        setBy: USERS.owner.id,
        reason: 'Back to the default',
      }),
    );
  });

  it('refusals are typed', () => {
    expect(new BankDetailChangeRefused('NOT_PENDING')).toBeInstanceOf(Error);
  });
});
