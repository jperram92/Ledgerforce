/**
 * Plain words for refusals of the manual-journal routes (T-0029, ADR-0042), on top of the admin
 * screens' messages (permissions, sessions, SoD). Engine refusals (`posting_refused`) use the
 * sentence for their code and line (gl-logic.ts).
 */
import { AdminApiError } from '../admin/client.ts';
import { messageFor } from '../admin/messages.ts';
import { refusalText } from './gl-logic.ts';

const MESSAGES: Record<string, string> = {
  manual_journal_wrong_status:
    'Someone else has moved this journal on since you opened it. Reload the page to see where it is now.',
  approval_required:
    'This journal needs an approval before it can be posted: it is above the approval limit or touches a control, tax or equity account.',
  invalid_manual_journal:
    'Something in the journal is not filled in correctly. Check the date, the accounts and the amounts.',
  rejection_reason_required: 'Write why you are sending it back (up to 2,000 characters).',
  idempotency_key_required: 'The journal could not be saved. Try again.',
  period_override_reason_required: 'Write why this journal goes into a locked period.',
};

/** Who may act on journals, for permission notes (design §6.4). */
export const PREPARERS = 'Only an Accountant, a Finance Admin or the Owner';
export const APPROVERS = 'Only an Approver or the Owner';
export const GL_READERS =
  'Only the Owner, a Finance Admin, an Accountant, an Approver or an Auditor';

/** The line and account a posting refusal points at, if any. */
export function refusalOf(error: unknown): { code: string; line: number | null } | null {
  if (!(error instanceof AdminApiError) || error.code !== 'posting_refused') return null;
  const code = typeof error.body['code'] === 'string' ? error.body['code'] : 'UNKNOWN';
  const line = typeof error.body['line'] === 'number' ? error.body['line'] : null;
  return { code, line };
}

export function glMessageFor(error: unknown, accountOfLine?: (line: number) => string): string {
  const r = refusalOf(error);
  if (r) return refusalText(r.code, r.line, r.line === null ? '' : (accountOfLine?.(r.line) ?? ''));
  if (error instanceof AdminApiError && MESSAGES[error.code]) return MESSAGES[error.code] ?? '';
  return messageFor(error);
}
