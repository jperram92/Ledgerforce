import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { withTenant, type Database } from '@ledgerforce/db';
import { sql, type Kysely, type Transaction } from 'kysely';

/** ADR-0016 / design §6.2: finance-role policy, applied to every session until roles exist (T-0012). */
export const IDLE_TIMEOUT_SECONDS = 30 * 60;
export const ABSOLUTE_LIFETIME_SECONDS = 12 * 60 * 60;
/** last_seen_at is written at most this often, so reads are not all writes. */
export const TOUCH_INTERVAL_MS = 60_000;

export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

export type SessionFailure = 'session_expired' | 'unauthenticated';

export class SessionError extends Error {
  constructor(readonly reason: SessionFailure) {
    super(reason);
    this.name = 'SessionError';
  }
}

export interface Principal {
  tenantId: string;
  userId: string;
  sessionId: string;
}

export interface SessionCookie {
  tenantId: string;
  sessionId: string;
  secret: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url, no padding

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** `<tenant_id>.<session_id>.<secret>`, or null if it is not well formed. */
export function parseSessionCookie(value: string | undefined): SessionCookie | null {
  const parts = (value ?? '').split('.');
  if (parts.length !== 3) return null;
  const [tenantId = '', sessionId = '', secret = ''] = parts;
  if (!UUID.test(tenantId) || !UUID.test(sessionId) || !SECRET.test(secret)) return null;
  return { tenantId, sessionId, secret };
}

/** Server-side sessions (ADR-0016). Every read and write runs under the session's tenant RLS. */
export class SessionService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly clock: Clock = systemClock,
  ) {}

  /** Creates a session and returns the cookie value. The secret is returned once, never stored. */
  async create(
    tenantId: string,
    opts: { userId: string; amr: string[]; acr: string | null },
  ): Promise<string> {
    const secret = randomBytes(32).toString('base64url');
    const now = this.clock.now();
    const id = await withTenant(this.db, tenantId, async (trx) => {
      const user = await trx
        .selectFrom('app.app_user')
        .select(['session_epoch', 'status'])
        .where('id', '=', opts.userId)
        .executeTakeFirst();
      if (!user || user.status !== 'active') throw new SessionError('unauthenticated');
      const row = await trx
        .insertInto('app.session')
        .values({
          user_id: opts.userId,
          secret_sha256: sha256(secret),
          created_at: now,
          last_seen_at: now,
          absolute_expires_at: new Date(now.getTime() + ABSOLUTE_LIFETIME_SECONDS * 1000),
          idle_timeout_seconds: IDLE_TIMEOUT_SECONDS,
          user_session_epoch: user.session_epoch,
          amr: opts.amr,
          acr: opts.acr,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    });
    return `${tenantId}.${id}.${secret}`;
  }

  /**
   * Verifies a parsed cookie inside the caller's tenant transaction (RLS = the claimed tenant).
   * A forged tenant id finds no session; a wrong secret fails the constant-time compare.
   */
  async verify(trx: Transaction<Database>, c: SessionCookie): Promise<Principal> {
    const row = await trx
      .selectFrom('app.session as s')
      .innerJoin('app.app_user as u', (j) =>
        j.onRef('u.id', '=', 's.user_id').onRef('u.tenant_id', '=', 's.tenant_id'),
      )
      .select([
        's.id',
        's.user_id',
        's.secret_sha256',
        's.last_seen_at',
        's.absolute_expires_at',
        's.idle_timeout_seconds',
        's.user_session_epoch',
        's.revoked_at',
        'u.session_epoch',
        'u.status',
      ])
      .where('s.id', '=', c.sessionId)
      .executeTakeFirst();
    if (!row) throw new SessionError('unauthenticated');
    const given = Buffer.from(sha256(c.secret), 'hex');
    const stored = Buffer.from(row.secret_sha256, 'hex');
    if (given.length !== stored.length || !timingSafeEqual(given, stored)) {
      throw new SessionError('unauthenticated');
    }
    if (row.status !== 'active') throw new SessionError('unauthenticated');
    const now = this.clock.now().getTime();
    const lastSeen = new Date(row.last_seen_at).getTime();
    if (
      row.revoked_at !== null ||
      row.user_session_epoch !== row.session_epoch ||
      now >= new Date(row.absolute_expires_at).getTime() ||
      now - lastSeen > row.idle_timeout_seconds * 1000
    ) {
      throw new SessionError('session_expired');
    }
    if (now - lastSeen >= TOUCH_INTERVAL_MS) {
      await trx
        .updateTable('app.session')
        .set({ last_seen_at: new Date(now) })
        .where('id', '=', row.id)
        .execute();
    }
    return { tenantId: c.tenantId, userId: row.user_id, sessionId: row.id };
  }

  /** Logout: ends one session (kept as history, never deleted). */
  async revokeInTx(trx: Transaction<Database>, sessionId: string, reason: string): Promise<void> {
    await trx
      .updateTable('app.session')
      .set({ revoked_at: this.clock.now(), revoke_reason: reason })
      .where('id', '=', sessionId)
      .where('revoked_at', 'is', null)
      .execute();
  }

  /** Revoke-all: bumping the user's epoch invalidates every older session (role change, reset, leaver). */
  async revokeAll(tenantId: string, userId: string, _reason: string): Promise<void> {
    await withTenant(this.db, tenantId, (trx) =>
      trx
        .updateTable('app.app_user')
        .set({ session_epoch: sql`session_epoch + 1` })
        .where('id', '=', userId)
        .execute(),
    );
  }
}
