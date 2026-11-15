/**
 * Re-bind a system role to another account (T-0146; design §3.2: roles are re-bound, never unbound;
 * ADR-0061). The role's binding row lives in app.account_system_role (core roles, 0005) or
 * app.account_system_role_ext (period-end roles, 0062); `bindingTableFor` picks it. The database
 * enforces every rule (account_system_role_check → assert_account_fits_role): the account's type
 * must fit the role, it must be active, postable and carry is_control exactly for control roles, and
 * a binding's role and company never change. A refusal comes back as REBIND_REFUSED with the
 * database's message. Readers use app.account_role_binding.
 */
import type { Database } from '@ledgerforce/db';
import { sql, type Transaction } from 'kysely';
import { bindingTableFor, isSystemRole } from './system-roles.ts';

type Trx = Transaction<Database>;

export type RebindErrorCode = 'UNKNOWN_ROLE' | 'UNKNOWN_ACCOUNT' | 'REBIND_REFUSED';

export class RebindError extends Error {
  readonly code: RebindErrorCode;
  constructor(code: RebindErrorCode, message: string) {
    super(message);
    this.name = 'RebindError';
    this.code = code;
  }
}

export interface RebindResult {
  readonly role: string;
  readonly previousAccountId: string;
  readonly accountId: string;
  /** False when the role was already bound to that account (nothing written). */
  readonly changed: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function rebindSystemRole(
  trx: Trx,
  c: { companyId: string; role: string; accountId: string },
): Promise<RebindResult> {
  const companyId = c.companyId.toLowerCase();
  if (!isSystemRole(c.role))
    throw new RebindError('UNKNOWN_ROLE', `${c.role} is not a system role`);
  const role = c.role;
  if (!UUID.test(c.accountId)) {
    throw new RebindError('UNKNOWN_ACCOUNT', 'account not found in this company');
  }
  const accountId = c.accountId.toLowerCase();
  const account = await trx
    .selectFrom('app.account')
    .select('id')
    .where('company_id', '=', companyId)
    .where('id', '=', accountId)
    .executeTakeFirst();
  if (!account) throw new RebindError('UNKNOWN_ACCOUNT', 'account not found in this company');

  const current = (
    await sql<{ account_id: string }>`
      SELECT account_id::text FROM app.account_role_binding
       WHERE company_id = ${companyId} AND role = ${role}`.execute(trx)
  ).rows[0];
  if (!current) {
    throw new RebindError('UNKNOWN_ROLE', `${role} is not bound in this company; bind it at setup`);
  }
  if (current.account_id === accountId) {
    return { role, previousAccountId: accountId, accountId, changed: false };
  }
  try {
    await sql`UPDATE ${sql.table(bindingTableFor(role))} SET account_id = ${accountId}
               WHERE company_id = ${companyId} AND role = ${role}`.execute(trx);
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    if (code === '23514' || code === 'P0001' || code === '23503') {
      throw new RebindError('REBIND_REFUSED', (e as Error).message);
    }
    throw e;
  }
  return { role, previousAccountId: current.account_id, accountId, changed: true };
}
