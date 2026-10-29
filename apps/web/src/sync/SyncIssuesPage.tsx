/**
 * Salesforce sync issues inbox (SS-PLAT-97, design §5.6 rule 2, P9, RQ-0047): deliveries that
 * failed their automatic retries, newest first, filtered by status (in the address) with keyset
 * pages. Needs sync.issues.read (Owner, Finance Admin, Accountant, Auditor). Acting on an issue
 * happens on its own page (SS-PLAT-99).
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  Empty,
  Failure,
  Forbidden,
  Loading,
  PageHead,
  useAccess,
  useFailureRouting,
} from '../admin/common.tsx';
import { timeLabel } from '../admin/dates.ts';
import type { InboxQuery } from './client.ts';
import { NOT_AFFECTED, SYNC_KEY, SYNC_READERS, useSyncClient } from './common.tsx';
import { explainError, recordLabel, STATUS_FILTERS, STATUS_WORD } from './logic.ts';

const TITLE = 'Salesforce sync issues';
const GLOSS =
  'Changes LedgerForce could not send to Salesforce, even after retrying automatically, with what went wrong and a way to send them again.';

export function SyncIssuesPage({ search }: { search: InboxQuery }) {
  const access = useAccess();
  const sync = useSyncClient();
  const canRead = access.can('sync.issues.read');
  const status = search.status ?? 'open';
  const list = useQuery({
    queryKey: [...SYNC_KEY, 'list', status, search.after ?? null],
    queryFn: () => sync.list(search),
    enabled: canRead,
  });
  useFailureRouting(list.error);
  const filter = STATUS_FILTERS.find((f) => f.value === status) ?? STATUS_FILTERS[0];

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
      <Forbidden heading="You can't see the sync issues">
        {SYNC_READERS} can see sync issues. Ask your Owner if you need to.
      </Forbidden>
    );
  else
    body = (
      <>
        <p className="admin-note">{NOT_AFFECTED}</p>
        <nav className="sync-filter" aria-label="Filter by status">
          <ul>
            {STATUS_FILTERS.map((f) => (
              <li key={f.value}>
                <Link
                  to="/settings/sync-issues"
                  search={{ status: f.value }}
                  activeOptions={{ exact: true, includeSearch: true }}
                  aria-current={f.value === status ? 'page' : undefined}
                >
                  {f.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        {list.isPending ? (
          <Loading what="sync issues" />
        ) : list.isError ? (
          <Failure
            heading="We could not load the sync issues"
            error={list.error}
            onRetry={() => void list.refetch()}
          />
        ) : list.data.issues.length === 0 ? (
          <>
            <Empty heading={search.after ? 'No more issues' : (filter?.empty ?? 'No sync issues')}>
              {search.after
                ? 'There are no issues after the last page.'
                : status === 'open'
                  ? 'Everything LedgerForce tried to send to Salesforce has gone through, or is still being retried automatically.'
                  : 'Choose another filter to see other issues.'}
            </Empty>
            {search.after ? (
              <p className="admin-back">
                <Link to="/settings/sync-issues" search={{ status }}>
                  First page
                </Link>
              </p>
            ) : null}
          </>
        ) : (
          <div className="admin-block">
            <table className="admin-table" aria-label="Sync issues">
              <thead>
                <tr>
                  <th scope="col">Record</th>
                  <th scope="col">What went wrong</th>
                  <th scope="col">Tries</th>
                  <th scope="col">Last failed</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {list.data.issues.map((i) => (
                  <tr key={i.id}>
                    <td data-label="Record">
                      <Link to="/settings/sync-issues/$issueId" params={{ issueId: i.id }}>
                        {recordLabel(i.payload_ref.aggregate_type)} {i.payload_ref.aggregate_id}
                      </Link>
                      <span className="muted code sync-topic"> {i.payload_ref.topic}</span>
                    </td>
                    <td data-label="What went wrong">{explainError(i.error).heading}</td>
                    <td data-label="Tries" className="num">
                      {i.attempts}
                    </td>
                    <td data-label="Last failed">{timeLabel(i.last_failed_at)}</td>
                    <td data-label="Status">
                      <span className="word" data-status={i.status}>
                        {STATUS_WORD[i.status]}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <nav className="admin-pager" aria-label="Pages">
              {search.after ? (
                <Link to="/settings/sync-issues" search={{ status }}>
                  First page
                </Link>
              ) : null}
              {list.data.next_after ? (
                <Link to="/settings/sync-issues" search={{ status, after: list.data.next_after }}>
                  Next page
                </Link>
              ) : null}
            </nav>
          </div>
        )}
      </>
    );

  return (
    <>
      <PageHead title={TITLE} gloss={GLOSS} />
      {body}
    </>
  );
}
