/**
 * Plain words and rules for the Sync issues inbox (T-0092, RQ-0047; P2, P6, P9): the filter in
 * the address, status words, which action each status allows (mirroring `retrySyncIssue` and
 * `ignoreSyncIssue` in packages/outbox), and every connector error kind said as what happened and
 * what to do next. The API stays the authority; this only explains.
 */
import { messageFor } from '../admin/messages.ts';
import type { InboxQuery, StatusFilter, SyncIssueError, SyncIssueStatus } from './client.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const STATUS_WORD: Record<SyncIssueStatus, string> = {
  open: 'Needs a person',
  retried: 'Retry sent',
  resolved: 'Fixed',
  ignored: 'Ignored',
};

/** The filter links, in a fixed order (P14). */
export const STATUS_FILTERS: readonly { value: StatusFilter; label: string; empty: string }[] = [
  { value: 'open', label: STATUS_WORD.open, empty: 'Nothing needs a person' },
  { value: 'retried', label: STATUS_WORD.retried, empty: 'No retries on their way' },
  { value: 'ignored', label: STATUS_WORD.ignored, empty: 'No ignored issues' },
  { value: 'resolved', label: STATUS_WORD.resolved, empty: 'No fixed issues yet' },
  { value: 'all', label: 'All', empty: 'No sync issues' },
];

/** The inbox's search params, keeping only what the API accepts (RQ-0047 F2). */
export function inboxSearch(search: Record<string, unknown>): InboxQuery {
  const out: InboxQuery = {};
  const s = search['status'];
  if (typeof s === 'string' && STATUS_FILTERS.some((f) => f.value === s)) {
    out.status = s as StatusFilter;
  }
  const a = search['after'];
  if (typeof a === 'string' && UUID.test(a)) out.after = a;
  return out;
}

/** `invoice` → `Invoice`, `credit_note` → `Credit note`. */
export function recordLabel(aggregateType: string): string {
  const words = aggregateType.replace(/[_.-]+/g, ' ').trim();
  if (words === '') return 'Record';
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

/** `salesforce` → `Salesforce`. */
export function connectorLabel(connector: string): string {
  return connector === 'salesforce' ? 'Salesforce' : recordLabel(connector);
}

const FIXED = 'This was fixed: Salesforce accepted the retry. Nothing is left to do.';

/** `true` when the action is offered; otherwise the sentence that says why not (P6). */
export function actionsFor(status: SyncIssueStatus): {
  retry: true | string;
  ignore: true | string;
} {
  switch (status) {
    case 'open':
      return { retry: true, ignore: true };
    case 'ignored':
      return {
        retry: true,
        ignore: 'It is already ignored. Retry it if it should go out after all.',
      };
    case 'retried':
      return {
        retry:
          'A retry is already on its way. This issue is marked fixed when Salesforce accepts it.',
        ignore: 'There is nothing to ignore while a retry is on its way.',
      };
    case 'resolved':
      return { retry: FIXED, ignore: FIXED };
  }
}

/** Every `kind` a delivery failure can carry (Salesforce connector, RQ-0040 F6; outbox). */
const KINDS = {
  session_expired: {
    heading: 'The Salesforce sign-in had expired',
    next: 'LedgerForce signs in again when it retries. If it keeps failing, check the Salesforce connection in Settings.',
  },
  unavailable: {
    heading: 'Salesforce could not be reached',
    next: 'This is usually Salesforce maintenance or a network fault. Retry once Salesforce is back.',
  },
  rate_limited: {
    heading: 'Salesforce asked LedgerForce to slow down',
    next: 'Too many requests reached Salesforce at once. Retry in a few minutes.',
  },
  request_limit: {
    heading: 'Your Salesforce org reached its API limit',
    next: 'Salesforce refused more API calls for now. Retry later, once the daily allowance has room again.',
  },
  throttled: {
    heading: 'LedgerForce held back to stay within its API share',
    next: 'It stops at its configured share of your daily Salesforce API allowance. Retry later, when usage has dropped.',
  },
  rejected: {
    heading: 'Salesforce refused the change',
    next: 'Read the Salesforce message below; it is often a validation rule, a locked record or a field the integration user cannot edit. Fix it in Salesforce, then retry.',
  },
  malformed_response: {
    heading: 'Salesforce sent an answer LedgerForce could not read',
    next: 'Retry once. If it happens again, report it with the message below.',
  },
  abandoned: {
    heading: 'The delivery stopped before it finished',
    next: 'The worker sending it stopped part-way. Retry it.',
  },
} as const;

export const ERROR_KINDS = Object.keys(KINDS) as (keyof typeof KINDS)[];

const RECORD_REFUSED = {
  heading: 'Salesforce refused one or more records',
  next: 'Salesforce accepted the request but turned some records away. Read the message below, fix the record in Salesforce, then retry.',
};

const UNKNOWN = {
  heading: 'Something went wrong while sending',
  next: 'Read the message below. Retry once the cause is fixed; if it keeps failing, tell whoever looks after your Salesforce connection.',
};

/** Salesforce status codes with a specific next step (RQ-0047 S6, F5). */
const CODES = {
  ENTITY_IS_LOCKED:
    'The record is locked in Salesforce, usually by an approval process. Unlock it there, then retry.',
  UNABLE_TO_LOCK_ROW:
    'Someone else was changing the same record in Salesforce at that moment. Retry: it usually goes through.',
  FIELD_CUSTOM_VALIDATION_EXCEPTION:
    'A validation rule in Salesforce refused the change. Ask your Salesforce admin to let LedgerForce through, or fix the record, then retry.',
  INVALID_FIELD:
    'A LedgerForce field is missing in Salesforce or hidden from the integration user. Check the LedgerForce package is installed and its fields are visible, then retry.',
  INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY:
    'The integration user cannot see or edit a related record in Salesforce. Give it access, then retry.',
  REQUEST_LIMIT_EXCEEDED: KINDS.request_limit.next,
} as const;

export const SYNC_ERROR_CODES = Object.keys(CODES) as (keyof typeof CODES)[];

function knownCode(e: Pick<SyncIssueError, 'code' | 'message'>): keyof typeof CODES | null {
  if (e.code && e.code in CODES) return e.code as keyof typeof CODES;
  return SYNC_ERROR_CODES.find((c) => new RegExp(`\\b${c}\\b`).test(e.message)) ?? null;
}

export interface Explained {
  heading: string;
  next: string;
  /** The Salesforce code the advice is about, if one was recognised. */
  code: string | null;
}

export function explainError(
  e: Pick<SyncIssueError, 'name' | 'kind' | 'code' | 'message' | 'retryable'> &
    Partial<SyncIssueError>,
): Explained {
  const base =
    e.kind !== null && e.kind in KINDS
      ? KINDS[e.kind as keyof typeof KINDS]
      : e.name === 'WriteBackRecordError'
        ? RECORD_REFUSED
        : UNKNOWN;
  const code = knownCode(e);
  return { heading: base.heading, next: code ? CODES[code] : base.next, code };
}

const SYNC_MESSAGES: Record<string, string> = {
  sync_issue_not_retryable:
    'This issue changed since you opened it (it may already be fixed), so it cannot be retried. It has been reloaded.',
  sync_issue_not_ignorable:
    'This issue changed since you opened it (a retry may be on its way, or it is fixed), so it cannot be ignored. It has been reloaded.',
  queue_not_configured:
    'LedgerForce cannot send retries right now: its job queue is not running. Ask whoever runs your LedgerForce server, then try again.',
  invalid_note: 'Keep the note under 500 characters.',
};

/** The sync routes' refusals in plain words; everything else as the admin screens say it. */
export function syncMessageFor(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    const m = SYNC_MESSAGES[error.code];
    if (m) return m;
  }
  return messageFor(error);
}

/** 409s mean the issue moved on elsewhere: reload it. */
export const isStale = (error: unknown): boolean =>
  error instanceof Error &&
  'code' in error &&
  (error.code === 'sync_issue_not_retryable' || error.code === 'sync_issue_not_ignorable');
