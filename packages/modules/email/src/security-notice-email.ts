/** Security notice dispatcher (T-0197, ADR-0092). RED stub: sends nothing yet. */
import type { Database } from '@ledgerforce/db';
import type { Kysely } from 'kysely';
import type { EmailSender } from './sender.ts';

export function securityNoticeRetryDelaySeconds(_attempt: number): number {
  return 0;
}

export async function dispatchSecurityNotices(
  _db: Kysely<Database>,
  _tenantId: string,
  _deps: { sender: EmailSender; now: Date },
): Promise<{ sent: number; failed: number }> {
  return Promise.resolve({ sent: 0, failed: 0 });
}
