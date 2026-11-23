/**
 * Failed security notices (SS-PLAT-161, T-0209, ADR-0097, design §6.5 rule 2): the emails about a
 * remittance account or supplier bank-detail change that LedgerForce could not deliver. The
 * dispatcher keeps retrying (every 6 hours at most, never giving up); this list puts them in
 * front of a person with what went wrong and a one-click Retry now, which sends the notice at
 * the next dispatch (within a minute). Reading needs security_notices.read (Owner, Finance Admin,
 * Auditor); retrying needs security_notices.retry (Owner, Finance Admin). Recipients arrive
 * masked; account numbers show the last 3 digits only.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useServices } from '../env.tsx';
import {
  Empty,
  Failure,
  Forbidden,
  Loading,
  PageHead,
  useAccess,
  useFailureRouting,
} from '../admin/common.tsx';
import { AdminApiError } from '../admin/client.ts';
import { timeLabel } from '../admin/dates.ts';
import { createNoticesClient, type FailedNotice } from './client.ts';
import {
  audienceLabel,
  explainFailure,
  NOTICE_READERS,
  NOTICE_RETRIERS,
  noticeLabel,
  retryMessageFor,
} from './logic.ts';

const TITLE = 'Failed security notices';
const GLOSS =
  'Emails about a changed bank account that LedgerForce could not deliver. It keeps trying every few hours; you can send one again now once the problem is fixed.';
const KEY = ['security-notices', 'failed'] as const;

export function SecurityNoticesPage() {
  const access = useAccess();
  const { env } = useServices();
  const client = useMemo(() => createNoticesClient(env), [env]);
  const queryClient = useQueryClient();
  const canRead = access.can('security_notices.read');
  const canRetry = access.can('security_notices.retry');
  const list = useQuery({ queryKey: KEY, queryFn: () => client.failed(), enabled: canRead });
  const [done, setDone] = useState<string | null>(null);
  const retry = useMutation({
    // A fresh Idempotency-Key per press (ADR-0097); the route is idempotent by state.
    mutationFn: (n: FailedNotice) =>
      client.retry(n.kind, n.id, `security-notice-retry-${crypto.randomUUID()}`),
    onSuccess: (n) => {
      setDone(`The notice to ${n.recipient} will be sent within a minute.`);
      queryClient.setQueryData<{ notices: FailedNotice[] }>(KEY, (old) =>
        old ? { notices: old.notices.map((x) => (x.id === n.id ? n : x)) } : old,
      );
    },
    onMutate: () => setDone(null),
  });
  useFailureRouting(list.error ?? retry.error);

  let body;
  if (access.isPending) body = <Loading what="your access" />;
  else if (access.isError)
    body = (
      <Failure
        heading="We could not check what you may do"
        error={access.error}
        onRetry={() => void access.refetch()}
      />
    );
  else if (!canRead)
    body = (
      <Forbidden heading="You can't see this list">
        {NOTICE_READERS} can see failed security notices. Ask your Owner if you need to.
      </Forbidden>
    );
  else if (list.isPending) body = <Loading what="the failed notices" />;
  else if (list.isError)
    body = (
      <Failure
        heading="We could not load the failed notices"
        error={list.error}
        onRetry={() => void list.refetch()}
      />
    );
  else if (list.data.notices.length === 0)
    body = (
      <Empty heading="No failed security notices">
        Every notice about a changed bank account has been delivered, or is on its first try.
      </Empty>
    );
  else
    body = (
      <div className="admin-block">
        {canRetry ? null : <p className="admin-note">{NOTICE_RETRIERS} can retry a notice.</p>}
        <p role="status" className="admin-note">
          {done ?? ''}
        </p>
        {retry.error && !(retry.error instanceof AdminApiError && retry.error.status === 401) ? (
          <p className="refusal" role="alert">
            {retryMessageFor(retry.error)}
          </p>
        ) : null}
        <table className="admin-table" aria-label="Failed security notices">
          <thead>
            <tr>
              <th scope="col">Notice</th>
              <th scope="col">Sent to</th>
              <th scope="col">Tries</th>
              <th scope="col">What went wrong</th>
              <th scope="col">Next try</th>
              {canRetry ? <th scope="col">Action</th> : null}
            </tr>
          </thead>
          <tbody>
            {list.data.notices.map((n) => {
              const label = noticeLabel(n);
              return (
                <tr key={`${n.kind}-${n.id}`}>
                  <td data-label="Notice">
                    {label}
                    <div className="muted">Since {timeLabel(n.created_at)}</div>
                  </td>
                  <td data-label="Sent to">
                    {n.recipient}
                    <div className="muted">{audienceLabel(n)}</div>
                  </td>
                  <td data-label="Tries" className="num">
                    {n.attempts}
                  </td>
                  <td data-label="What went wrong">
                    {explainFailure(n)}
                    {n.last_smtp_code !== null || n.last_error_message ? (
                      <div className="muted code">
                        {[n.last_smtp_code, n.last_error_code].filter((x) => x !== null).join(' ')}
                        {n.last_error_message ? `: ${n.last_error_message}` : ''}
                      </div>
                    ) : null}
                    <div className="muted">Last tried {timeLabel(n.last_attempt_at)}</div>
                  </td>
                  <td data-label="Next try">
                    {n.retry_requested ? (
                      <span className="word" data-status="retried">
                        Will be sent within a minute
                      </span>
                    ) : (
                      timeLabel(n.next_attempt_at)
                    )}
                  </td>
                  {canRetry ? (
                    <td data-label="Action">
                      {n.retry_requested ? null : (
                        <button
                          type="button"
                          aria-label={`Retry now: ${label}`}
                          disabled={retry.isPending}
                          onClick={() => retry.mutate(n)}
                        >
                          Retry now
                        </button>
                      )}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );

  return (
    <>
      <PageHead title={TITLE} gloss={GLOSS} />
      {body}
    </>
  );
}
