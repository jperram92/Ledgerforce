/**
 * Setup wizard API client (T-0091): the T-0157 routes of ADR-0075, and the opening-balance routes
 * of T-0080 (T-0177). Same origin, session cookie;
 * failures are AdminApiError (status + error code + body, e.g. `missing` on STEP_INVALID).
 * The client never sends `as_of`: the API checks against today in the tenant's time zone.
 */
import type { AppEnv } from '../env.tsx';
import { AdminApiError } from '../admin/client.ts';

export interface WizardStep {
  step: number;
  title: string;
  status: 'not_started' | 'in_progress' | 'complete';
  locked: boolean;
  valid: boolean;
  /** What the step's validator finds missing, in plain words; [] when nothing is. */
  missing: string[];
  outcome: 'validated' | 'no_history' | null;
  reason: string | null;
  completed_at: string | null;
  completed_by: string | null;
}

export interface Wizard {
  company_id: string;
  as_of: string;
  complete: boolean;
  steps: WizardStep[];
}

/** The body of the opening-balance routes (T-0080): CSV text, read from the chosen files. */
export interface OpeningBalanceFiles {
  company_id: string;
  conversion_date: string;
  trial_balance_csv: string;
  ar_items_csv?: string;
  ap_items_csv?: string;
}

/** POST /setup/opening-balances/preview: the posting engine's journal; nothing is written. */
export interface OpeningPreview {
  balance_date: string;
  entry_date: string;
  total: string;
  lines: {
    line_no: number;
    account_code: string;
    debit: string;
    credit: string;
    party_id: string | null;
    due_date: string | null;
    memo: string | null;
  }[];
}

/** The posted opening balance (GET, and the POST answer). */
export interface OpeningBalance {
  id: string;
  company_id: string;
  conversion_date: string;
  balance_date: string;
  entry_id: string;
  entry_no: string | null;
  items: {
    kind: 'ar' | 'ap';
    party_id: string;
    document_no: string;
    document_date: string;
    due_date: string;
    line_no: number;
    amount: string;
    gst_amount: string;
  }[];
}

export interface SetupClient {
  /** The live opening balance, or null when none is posted (404). */
  openingBalance(companyId: string): Promise<OpeningBalance | null>;
  previewOpeningBalance(files: OpeningBalanceFiles): Promise<OpeningPreview>;
  postOpeningBalance(
    files: OpeningBalanceFiles,
    key: string,
  ): Promise<OpeningBalance & { replayed: boolean }>;
  wizard(companyId: string): Promise<Wizard>;
  complete(
    companyId: string,
    step: number,
    key: string,
    noHistoryReason?: string,
  ): Promise<WizardStep & { replayed: boolean }>;
}

export function createSetupClient(env: Pick<AppEnv, 'apiBase' | 'fetch'>): SetupClient {
  async function send<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ): Promise<T> {
    const res = await env.fetch(`${env.apiBase}${path}`, {
      method,
      credentials: 'same-origin',
      headers:
        body === undefined
          ? { accept: 'application/json', ...extra }
          : { accept: 'application/json', 'content-type': 'application/json', ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data: unknown = await res.json().catch(() => null);
    if (!res.ok) throw new AdminApiError(res.status, data);
    return data as T;
  }
  const seg = encodeURIComponent;
  return {
    openingBalance: async (companyId) => {
      try {
        return await send<OpeningBalance>(
          'GET',
          `/setup/opening-balances?company_id=${seg(companyId)}`,
        );
      } catch (e) {
        if (e instanceof AdminApiError && e.status === 404 && e.code === 'no_opening_balance')
          return null;
        throw e;
      }
    },
    previewOpeningBalance: (files) => send('POST', '/setup/opening-balances/preview', files),
    postOpeningBalance: (files, key) =>
      send('POST', '/setup/opening-balances', files, { 'idempotency-key': key }),
    wizard: (companyId) => send('GET', `/setup/wizard?company_id=${seg(companyId)}`),
    complete: (companyId, step, key, noHistoryReason) =>
      send(
        'POST',
        `/setup/wizard/steps/${String(step)}/complete`,
        {
          company_id: companyId,
          ...(noHistoryReason === undefined ? {} : { no_history_reason: noHistoryReason }),
        },
        { 'idempotency-key': key },
      ),
  };
}
