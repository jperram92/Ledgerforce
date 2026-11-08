/**
 * One Sync issue (SS-PLAT-98, SS-PLAT-99; design §5.6 rule 2, P6, P9, RQ-0047): what went wrong
 * in plain words with the raw error, what LedgerForce was sending (payload reference, payload on
 * demand), the attempts and the status, and Retry / Ignore with a confirmation first. Actions are
 * offered by status (as the API allows them) and shown disabled with the reason to callers
 * without sync.issues.manage. The API stays the authority.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useServices } from '../env.tsx';
import { AdminApiError } from '../admin/client.ts';
import {
  Failure,
  Forbidden,
  Loading,
  PageHead,
  useAccess,
  useFailureRouting,
  USERS_KEY,
} from '../admin/common.tsx';
import { timeLabel } from '../admin/dates.ts';
import type { SyncIssue, SyncIssueDetail } from './client.ts';
import {
  issueKey,
  NOT_AFFECTED,
  SYNC_KEY,
  SYNC_MANAGERS,
  SYNC_READERS,
  SyncRefusal,
  useSyncClient,
} from './common.tsx';
import {
  actionsFor,
  connectorLabel,
  explainError,
  isStale,
  recordLabel,
  STATUS_WORD,
} from './logic.ts';

const GENERIC = 'A change LedgerForce could not send, what went wrong and what you can do.';
const times = (n: number) => `${String(n)} ${n === 1 ? 'time' : 'times'}`;

export function SyncIssuePage({ issueId }: { issueId: string }) {
  const access = useAccess();
  const sync = useSyncClient();
  const canRead = access.can('sync.issues.read');
  const issue = useQuery({
    queryKey: issueKey(issueId),
    queryFn: () => sync.issue(issueId),
    enabled: canRead,
  });
  useFailureRouting(issue.error);

  const back = (
    <p className="admin-back">
      <Link to="/settings/sync-issues">All sync issues</Link>
    </p>
  );
  if (access.isPending || (canRead && issue.isPending)) {
    return (
      <>
        <PageHead title="Sync issue" gloss={GENERIC} />
        <Loading what="this sync issue" />
      </>
    );
  }
  if (access.isError || !canRead) {
    return (
      <>
        <PageHead title="Sync issue" gloss={GENERIC} />
        {access.isError ? (
          <Failure
            heading="We could not check what you may do"
            error={access.error}
            onRetry={() => void access.refetch()}
          />
        ) : (
          <Forbidden heading="You can't see the sync issues">
            {SYNC_READERS} can see sync issues. Ask your Owner if you need to.
          </Forbidden>
        )}
      </>
    );
  }
  if (issue.isError) {
    const missing = issue.error instanceof AdminApiError && issue.error.status === 404;
    return (
      <>
        <PageHead
          title={missing ? 'Sync issue not found' : 'Sync issue'}
          gloss={missing ? 'There is no sync issue with this id in your organisation.' : GENERIC}
        />
        {missing ? null : (
          <Failure
            heading="We could not load this sync issue"
            error={issue.error}
            onRetry={() => void issue.refetch()}
          />
        )}
        {back}
      </>
    );
  }
  const i = issue.data;
  if (!i) return null;
  const record = `${recordLabel(i.payload_ref.aggregate_type)} ${i.payload_ref.aggregate_id}`;
  const to = connectorLabel(i.connector);
  return (
    <>
      <PageHead
        title={
          i.status === 'resolved'
            ? `${record} was sent to ${to} after a retry`
            : `${record} was not sent to ${to}`
        }
        gloss={`Status: ${STATUS_WORD[i.status]}. ${NOT_AFFECTED}`}
      />
      {back}
      <WhatWentWrong issue={i} />
      <Actions issue={i} record={record} canManage={access.can('sync.issues.manage')} />
      <Attempts issue={i} />
      <Sending issue={i} />
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="admin-block" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}

function WhatWentWrong({ issue }: { issue: SyncIssue }) {
  const e = issue.error;
  const x = explainError(e);
  return (
    <Section title="What went wrong">
      <div className="sync-error">
        <p className="sync-error-heading">{x.heading}</p>
        <p>{x.next}</p>
        <p>
          {e.retryable
            ? 'Retrying can help once the cause has passed.'
            : 'Retrying alone will not help: fix the cause first, then retry.'}
        </p>
      </div>
      <dl className="sync-facts">
        <dt>Error code</dt>
        <dd className="code">{e.code ?? x.code ?? '—'}</dd>
        <dt>Answer from {connectorLabel(issue.connector)}</dt>
        <dd>{e.http_status === null ? 'None (no answer)' : `HTTP ${String(e.http_status)}`}</dd>
        <dt>Message</dt>
        <dd className="code">{e.message}</dd>
        <dt>Kind of failure</dt>
        <dd className="code">
          {e.name}
          {e.kind ? ` (${e.kind})` : ''}
        </dd>
      </dl>
    </Section>
  );
}

function Attempts({ issue }: { issue: SyncIssue }) {
  return (
    <Section title="Attempts">
      <p>Tried {times(issue.attempts)} before it came here.</p>
      <dl className="sync-facts">
        <dt>First failed</dt>
        <dd>{timeLabel(issue.first_failed_at)}</dd>
        <dt>Last failed</dt>
        <dd>{timeLabel(issue.last_failed_at)}</dd>
      </dl>
    </Section>
  );
}

function Sending({ issue }: { issue: SyncIssueDetail }) {
  const r = issue.payload_ref;
  return (
    <Section title="What it was sending">
      <dl className="sync-facts">
        <dt>Record</dt>
        <dd>
          {recordLabel(r.aggregate_type)} <span className="code">{r.aggregate_id}</span>
        </dd>
        <dt>Event</dt>
        <dd className="code">{r.topic}</dd>
        <dt>Event id</dt>
        <dd className="code">{issue.event_id}</dd>
        <dt>Sent by</dt>
        <dd className="code">{issue.handler}</dd>
      </dl>
      <details className="sync-payload">
        <summary>Show the data it was sending</summary>
        <pre>{JSON.stringify(issue.payload, null, 2)}</pre>
      </details>
    </Section>
  );
}

function useFocusOnOpen(ref: RefObject<HTMLElement | null>, open: boolean) {
  useEffect(() => {
    if (open) ref.current?.focus();
  }, [open, ref]);
}

function Actions({
  issue,
  record,
  canManage,
}: {
  issue: SyncIssueDetail;
  record: string;
  canManage: boolean;
}) {
  const sync = useSyncClient();
  const { api } = useServices();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<'retry' | 'ignore' | null>(null);
  const [note, setNote] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const yesRetry = useRef<HTMLButtonElement>(null);
  const noteBox = useRef<HTMLTextAreaElement>(null);
  const retryButton = useRef<HTMLButtonElement>(null);
  const ignoreButton = useRef<HTMLButtonElement>(null);
  useFocusOnOpen(yesRetry, confirming === 'retry');
  useFocusOnOpen(noteBox, confirming === 'ignore');
  const noPermId = useId();
  const me = useQuery({ queryKey: ['auth', 'me'], queryFn: () => api.me() }).data;
  const access = useAccess();
  const { admin } = useServices();
  const users = useQuery({
    queryKey: USERS_KEY,
    queryFn: () => admin.users(),
    enabled: access.can('users.read') && issue.status_changed_by !== null,
  });

  const settle = async (updated: SyncIssue, message: string) => {
    setConfirming(null);
    setNote('');
    setDone(message);
    queryClient.setQueryData<SyncIssueDetail>(issueKey(issue.id), (old) =>
      old ? { ...old, ...updated } : old,
    );
    await queryClient.invalidateQueries({ queryKey: [...SYNC_KEY, 'list'] });
  };
  const onError = async (error: unknown) => {
    setConfirming(null);
    if (isStale(error)) await queryClient.invalidateQueries({ queryKey: issueKey(issue.id) });
  };
  const retry = useMutation({
    mutationFn: () => sync.retry(issue.id),
    onSuccess: (u) =>
      settle(
        u,
        `Retry sent. LedgerForce is sending it to ${connectorLabel(u.connector)} again now.`,
      ),
    onError,
  });
  const ignore = useMutation({
    mutationFn: () => sync.ignore(issue.id, note),
    onSuccess: (u) => settle(u, 'Ignored. It stays here, and you can still retry it.'),
    onError,
  });
  useFailureRouting(retry.error ?? ignore.error);
  const busy = retry.isPending || ignore.isPending;
  const rules = actionsFor(issue.status);
  const reasons = [rules.retry, rules.ignore].filter(
    (r, k, all): r is string => typeof r === 'string' && all.indexOf(r) === k,
  );
  const changedBy =
    issue.status_changed_by === null
      ? null
      : issue.status_changed_by === me?.user_id
        ? 'you'
        : (users.data?.find((u) => u.id === issue.status_changed_by)?.display_name ??
          'another person');
  const start = (what: 'retry' | 'ignore') => {
    retry.reset();
    ignore.reset();
    setDone(null);
    setConfirming(what);
  };
  const cancel = () => {
    const back = confirming === 'retry' ? retryButton : ignoreButton;
    setConfirming(null);
    // Focus returns to the button that opened the confirmation once it is back.
    requestAnimationFrame(() => back.current?.focus());
  };

  return (
    <Section title="What you can do">
      <p>
        <span className="word" data-status={issue.status}>
          {STATUS_WORD[issue.status]}
        </span>{' '}
        since {timeLabel(issue.status_changed_at)}
        {changedBy ? `, set by ${changedBy}` : ''}.{issue.note ? ` Note: ${issue.note}` : ''}
      </p>
      {reasons.map((r) => (
        <p key={r} className="admin-note">
          {r}
        </p>
      ))}
      {confirming === 'retry' ? (
        <div className="confirm" role="group" aria-label="Confirm retry">
          <p>
            LedgerForce sends {record} to {connectorLabel(issue.connector)} again now. If it fails
            again, it comes back here.
          </p>
          <button
            ref={yesRetry}
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => {
              retry.mutate();
            }}
          >
            Yes, send it again
          </button>
          <button type="button" className="secondary" onClick={cancel}>
            Cancel
          </button>
        </div>
      ) : confirming === 'ignore' ? (
        <div className="confirm" role="group" aria-label="Confirm ignore">
          <p>
            Ignoring parks this issue: nothing is sent, and {record} stays out of step with{' '}
            {connectorLabel(issue.connector)} until someone retries it.
          </p>
          <div className="sync-note">
            <label htmlFor="ignore-note">Why ignore it? (optional, kept in the audit log)</label>
            <textarea
              ref={noteBox}
              id="ignore-note"
              rows={2}
              maxLength={500}
              value={note}
              onChange={(e) => {
                setNote(e.target.value);
              }}
            />
          </div>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => {
              ignore.mutate();
            }}
          >
            Yes, ignore it
          </button>
          <button type="button" className="secondary" onClick={cancel}>
            Cancel
          </button>
        </div>
      ) : rules.retry === true || rules.ignore === true ? (
        <div className="sync-actions">
          {rules.retry === true ? (
            <button
              ref={retryButton}
              type="button"
              className="primary"
              disabled={!canManage}
              {...(canManage ? {} : { 'aria-describedby': noPermId })}
              onClick={() => {
                start('retry');
              }}
            >
              Retry
            </button>
          ) : null}
          {rules.ignore === true ? (
            <button
              ref={ignoreButton}
              type="button"
              className="secondary"
              disabled={!canManage}
              {...(canManage ? {} : { 'aria-describedby': noPermId })}
              onClick={() => {
                start('ignore');
              }}
            >
              Ignore
            </button>
          ) : null}
          {canManage ? null : (
            <p id={noPermId} className="admin-note">
              {SYNC_MANAGERS} can retry or ignore a sync issue. You can read it.
            </p>
          )}
        </div>
      ) : null}
      <SyncRefusal error={retry.error ?? ignore.error} />
      {done ? (
        <p className="done" role="status">
          {done}
        </p>
      ) : null}
    </Section>
  );
}
