/**
 * Setup wizard API client (T-0091): the T-0157 routes of ADR-0075. Same origin, session cookie;
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

export interface SetupClient {
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
