/**
 * Audit log viewer (SS-PLAT-80, design §6.4 and §6.8, ADR-0034): read-only, newest first, filtered
 * by person, action, record and date, with keyset pages. The filters live in the address, so a
 * view can be shared and Back works. Needs audit_log.read (Owner, Finance Admin, Auditor).
 */
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState, type FormEvent } from 'react';
import { useServices } from '../env.tsx';
import type { AuditEntry, AuditQuery } from './client.ts';
import {
  Empty,
  Failure,
  Forbidden,
  Loading,
  PageHead,
  READERS,
  useAccess,
  useFailureRouting,
  USERS_KEY,
} from './common.tsx';
import { timeLabel } from './dates.ts';

const TITLE = 'Audit log';
const GLOSS =
  'Every change in LedgerForce: who did what, to which record, and when. Entries can never be changed or removed.';

type Filters = Omit<AuditQuery, 'before'>;
function withoutCursor(q: AuditQuery): AuditQuery {
  const rest: AuditQuery = { ...q };
  delete rest.before;
  return rest;
}

const FIELDS = ['actor', 'action', 'entity_type', 'entity_id', 'from', 'to'] as const;

export function AuditLogPage({ search }: { search: AuditQuery }) {
  const access = useAccess();
  const { admin } = useServices();
  const navigate = useNavigate();
  const canRead = access.can('audit_log.read');
  const log = useQuery({
    queryKey: ['admin', 'audit', search],
    queryFn: () => admin.auditLog(search),
    enabled: canRead,
  });
  const users = useQuery({
    queryKey: USERS_KEY,
    queryFn: () => admin.users(),
    enabled: canRead && access.can('users.read'),
  });
  useFailureRouting(log.error);
  const [draft, setDraft] = useState<Filters>({});
  useEffect(() => {
    const d: Filters = {};
    for (const k of FIELDS) if (search[k]) d[k] = search[k];
    setDraft(d);
  }, [search]);
  const nameOf = (e: AuditEntry) =>
    e.actor_user_id === null
      ? e.actor_type === 'system'
        ? 'LedgerForce (system)'
        : e.actor_type
      : (users.data?.find((u) => u.id === e.actor_user_id)?.display_name ?? e.actor_user_id);

  const apply = (e: FormEvent) => {
    e.preventDefault();
    const next: AuditQuery = {};
    for (const k of FIELDS) {
      const v = draft[k]?.trim();
      if (v) next[k] = v;
    }
    void navigate({ to: '/reports/audit-log', search: next });
  };

  const text = (k: (typeof FIELDS)[number], label: string, type = 'text', max = 200) => (
    <div className="field">
      <label htmlFor={`f-${k}`}>{label}</label>
      <input
        id={`f-${k}`}
        type={type}
        maxLength={max}
        value={draft[k] ?? ''}
        onChange={(e) => {
          setDraft({ ...draft, [k]: e.target.value });
        }}
      />
    </div>
  );

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
      <Forbidden heading="You can't see the audit log">
        {READERS} can read the audit log. Ask your Owner if you need to.
      </Forbidden>
    );
  else
    body = (
      <>
        <form
          className="admin-filters"
          role="search"
          aria-label="Filter the audit log"
          onSubmit={apply}
        >
          <div className="field">
            <label htmlFor="f-actor">Person</label>
            <select
              id="f-actor"
              value={draft.actor ?? ''}
              onChange={(e) => {
                setDraft({ ...draft, actor: e.target.value });
              }}
            >
              <option value="">Anyone</option>
              {(users.data ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.display_name}
                </option>
              ))}
            </select>
          </div>
          {text('action', 'Action contains')}
          {text('entity_type', 'Record type', 'text', 100)}
          {text('entity_id', 'Record id')}
          {text('from', 'From', 'date', 10)}
          {text('to', 'To', 'date', 10)}
          <div className="actions">
            <button type="submit" className="secondary">
              Apply filters
            </button>
            <Link to="/reports/audit-log" search={{}}>
              Clear filters
            </Link>
          </div>
        </form>
        {log.isPending ? (
          <Loading what="audit entries" />
        ) : log.isError ? (
          <Failure
            heading="We could not load the audit log"
            error={log.error}
            onRetry={() => void log.refetch()}
          />
        ) : log.data.entries.length === 0 ? (
          <Empty heading="No entries match">
            Try fewer filters or a wider date range. Dates are whole days in your
            organisation&apos;s report time zone.
          </Empty>
        ) : (
          <div className="admin-block">
            <table className="admin-table audit" aria-label="Audit entries">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Who</th>
                  <th scope="col">Action</th>
                  <th scope="col">Record</th>
                  <th scope="col">Details</th>
                </tr>
              </thead>
              <tbody>
                {log.data.entries.map((e) => (
                  <tr key={e.id}>
                    <td data-label="When">{timeLabel(e.occurred_at)}</td>
                    <td data-label="Who">
                      {nameOf(e)}
                      {e.api_token_id ? <span className="muted"> (by API token)</span> : null}
                    </td>
                    <td data-label="Action" className="code">
                      {e.action}
                    </td>
                    <td data-label="Record">
                      {e.entity_type}
                      {e.entity_id ? <span className="muted code"> {e.entity_id}</span> : null}
                    </td>
                    <td data-label="Details">
                      <details>
                        <summary>
                          Show details<span className="sr-only"> of entry {e.id}</span>
                        </summary>
                        <dl>
                          <dt>Before</dt>
                          <dd>
                            <pre>{e.before === null ? '—' : JSON.stringify(e.before, null, 2)}</pre>
                          </dd>
                          <dt>After</dt>
                          <dd>
                            <pre>{e.after === null ? '—' : JSON.stringify(e.after, null, 2)}</pre>
                          </dd>
                          <dt>From address</dt>
                          <dd>{e.ip ?? '—'}</dd>
                          <dt>Browser or app</dt>
                          <dd>{e.user_agent ?? '—'}</dd>
                          <dt>Request id</dt>
                          <dd className="code">{e.request_id ?? '—'}</dd>
                        </dl>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <nav className="admin-pager" aria-label="Pages">
              {search.before ? (
                <Link to="/reports/audit-log" search={withoutCursor(search)}>
                  Back to newest
                </Link>
              ) : null}
              {log.data.next_before ? (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    const before = log.data.next_before;
                    if (before === null) return;
                    void navigate({
                      to: '/reports/audit-log',
                      search: { ...withoutCursor(search), before },
                    });
                  }}
                >
                  Older entries
                </button>
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
