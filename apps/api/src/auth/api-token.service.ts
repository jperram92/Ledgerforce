import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Database } from '@ledgerforce/db';
import { isPermission, type Permission } from '@ledgerforce/shared/rbac';
import { sql, type Transaction } from 'kysely';
import type { Clock } from './session.service.ts';

/**
 * Personal API tokens (design §6.2, ADR-0027, RQ-0031).
 *
 * String: `lfpat.<tenant_id>.<token_id>.<secret>`; the secret is 32 CSPRNG bytes (base64url) and
 * only its SHA-256 is stored. The tenant in the string is a claim: the token row is looked up
 * under that tenant's RLS, so a forged tenant finds nothing. Sent only as `Authorization: Bearer`.
 */

export const TOKEN_PREFIX = 'lfpat';
export const DEFAULT_TOKEN_DAYS = 90;
export const MAX_TOKEN_DAYS = 366;
/** last_used_at is written at most this often, so reads are not all writes. */
export const TOKEN_TOUCH_INTERVAL_MS = 60_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export interface ParsedToken {
  tenantId: string;
  tokenId: string;
  secret: string;
}

/** The token from an `Authorization: Bearer lfpat.…` value, or null if it is not one. */
export function parseBearerToken(header: string | undefined): ParsedToken | null {
  const m = /^Bearer ([^\s]+)$/.exec(header ?? '');
  if (!m?.[1]) return null;
  const parts = m[1].split('.');
  if (parts.length !== 4 || parts[0] !== TOKEN_PREFIX) return null;
  const [, tenantId = '', tokenId = '', secret = ''] = parts;
  if (!UUID.test(tenantId) || !UUID.test(tokenId) || !SECRET.test(secret)) return null;
  return { tenantId, tokenId, secret };
}

/** Who a verified token acts as, and the most it may do. */
export interface TokenPrincipal {
  tenantId: string;
  userId: string;
  tokenId: string;
  scopes: readonly Permission[];
}

export class TokenError extends Error {
  constructor() {
    super('invalid_token');
    this.name = 'TokenError';
  }
}

/** A new secret and the string handed to the user once. */
export function newTokenSecret(): { secret: string; secretSha256: string } {
  const secret = randomBytes(32).toString('base64url');
  return { secret, secretSha256: sha256(secret) };
}

export function tokenString(tenantId: string, tokenId: string, secret: string): string {
  return `${TOKEN_PREFIX}.${tenantId}.${tokenId}.${secret}`;
}

export class ApiTokenService {
  constructor(private readonly clock: Clock) {}

  /**
   * Verifies a parsed token inside the caller's tenant transaction (RLS = the claimed tenant).
   * Unknown, wrong secret, revoked, expired, or owner not active: all the same TokenError.
   */
  async verify(trx: Transaction<Database>, t: ParsedToken): Promise<TokenPrincipal> {
    const row = await trx
      .selectFrom('app.api_token as k')
      .innerJoin('app.app_user as u', (j) =>
        j.onRef('u.id', '=', 'k.user_id').onRef('u.tenant_id', '=', 'k.tenant_id'),
      )
      .select([
        'k.id',
        'k.user_id',
        'k.secret_sha256',
        'k.scopes',
        'k.expires_at',
        'k.revoked_at',
        'k.last_used_at',
        'u.status',
      ])
      .where('k.id', '=', t.tokenId)
      .executeTakeFirst();
    if (!row) throw new TokenError();
    const given = Buffer.from(sha256(t.secret), 'hex');
    const stored = Buffer.from(row.secret_sha256, 'hex');
    if (given.length !== stored.length || !timingSafeEqual(given, stored)) throw new TokenError();
    const now = this.clock.now().getTime();
    if (
      row.revoked_at !== null ||
      row.status !== 'active' ||
      now >= new Date(row.expires_at).getTime()
    ) {
      throw new TokenError();
    }
    if (
      row.last_used_at === null ||
      now - new Date(row.last_used_at).getTime() >= TOKEN_TOUCH_INTERVAL_MS
    ) {
      // The database clock, so last_used_at only moves forward (trigger, migration 0022).
      await trx
        .updateTable('app.api_token')
        .set({ last_used_at: sql<Date>`greatest(clock_timestamp(), last_used_at)` })
        .where('id', '=', row.id)
        .where('revoked_at', 'is', null)
        .execute();
    }
    return {
      tenantId: t.tenantId,
      userId: row.user_id,
      tokenId: row.id,
      scopes: row.scopes.filter(isPermission),
    };
  }
}
