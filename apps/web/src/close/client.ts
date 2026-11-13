/**
 * Close API client (T-0090): fiscal periods and the month-end close checklist (T-0148 routes).
 * Same origin, session cookie; failures are AdminApiError (status + error code).
 */
import type { AppEnv } from '../env.tsx';
import { AdminApiError } from '../admin/client.ts';

export type PeriodStatus = 'open' | 'ar_locked' | 'ap_locked' | 'soft_closed' | 'hard_locked';
export type CloseStep =
  'ar_lock' | 'ap_lock' | 'bank_recs' | 'accruals' | 'tb_review' | 'soft_close' | 'hard_lock';

export interface Period {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  status: PeriodStatus;
}

export interface ChecklistStep {
  step: CloseStep;
  completed_by: string | null;
  completed_by_name: string | null;
  completed_at: string | null;
  period_status: PeriodStatus | null;
}

export interface CloseClient {
  periods(companyId: string, from: string, to: string): Promise<{ periods: Period[] }>;
  checklist(
    companyId: string,
    periodId: string,
  ): Promise<{ period: Period; steps: ChecklistStep[] }>;
  complete(companyId: string, periodId: string, step: CloseStep, key: string): Promise<unknown>;
}

export function createCloseClient(env: Pick<AppEnv, 'apiBase' | 'fetch'>): CloseClient {
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
    periods: (companyId, from, to) =>
      send('GET', `/periods?company_id=${seg(companyId)}&from=${seg(from)}&to=${seg(to)}`),
    checklist: (companyId, periodId) =>
      send('GET', `/periods/${seg(periodId)}/close-checklist?company_id=${seg(companyId)}`),
    complete: (companyId, periodId, step, key) =>
      send(
        'POST',
        `/periods/${seg(periodId)}/close-checklist/${seg(step)}`,
        { company_id: companyId },
        { 'idempotency-key': key },
      ),
  };
}
