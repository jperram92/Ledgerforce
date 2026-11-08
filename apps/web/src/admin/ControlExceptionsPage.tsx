/**
 * Weekly control exceptions (SS-PLAT-79, design §6.5 small-team mode, P8 "weakened controls are
 * visible, never silent"): the exceptions of one Monday-to-Monday week in the tenant's report time
 * zone, each in plain words, and the Owner's acknowledgement (settings.sod.manage). Others see
 * whose turn it is (P13). Reading the report needs audit_log.read (T-0015).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useServices } from '../env.tsx';
import {
  Empty,
  Failure,
  Forbidden,
  Loading,
  PageHead,
  READERS,
  Refusal,
  useAccess,
  useFailureRouting,
  USERS_KEY,
} from './common.tsx';
import { addDays, dayLabel, timeLabel } from './dates.ts';
import { KIND_TEXT, ruleText } from './messages.ts';

const TITLE = 'Weekly control exceptions';
const GLOSS =
  'When the team is too small for a separation-of-duties rule, LedgerForce lets the action through and records it here (segregation-of-duties exceptions). The Owner reviews and acknowledges each week.';

export function ControlExceptionsPage({ week }: { week: string | undefined }) {
  const access = useAccess();
  const { admin } = useServices();
  const queryClient = useQueryClient();
  const canRead = access.can('audit_log.read');
  const report = useQuery({
    queryKey: ['admin', 'sod-week', week ?? 'current'],
    queryFn: () => admin.sodWeek(week),
    enabled: canRead,
  });
  const users = useQuery({
    queryKey: USERS_KEY,
    queryFn: () => admin.users(),
    enabled: canRead && access.can('users.read'),
  });
  const [note, setNote] = useState('');
  const ack = useMutation({
    mutationFn: (weekStart: string) => admin.acknowledgeWeek(weekStart, note.trim() || undefined),
    onSuccess: async () => {
      setNote('');
      await queryClient.invalidateQueries({ queryKey: ['admin', 'sod-week'] });
    },
  });
  useFailureRouting(report.error ?? ack.error);
  const nameOf = (id: string | null) =>
    users.data?.find((u) => u.id === id)?.display_name ?? id ?? '';

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
      <Forbidden heading="You can't see this report">
        {READERS} can see the weekly control exceptions. Ask your Owner if you need to.
      </Forbidden>
    );
  else if (report.isPending) body = <Loading what="the week's exceptions" />;
  else if (report.isError)
    body = (
      <Failure
        heading="We could not load this week's exceptions"
        error={report.error}
        onRetry={() => void report.refetch()}
      />
    );
  else {
    const r = report.data;
    const open = r.exceptions.filter((e) => !e.acknowledged).length;
    const owner = access.can('settings.sod.manage');
    const due = addDays(r.week_start, 7);
    body = (
      <>
        <section className="admin-block" aria-labelledby="week-h">
          <h2 id="week-h">Week of {dayLabel(r.week_start)}</h2>
          <p className="admin-note">Times are in {r.timezone}.</p>
          <nav className="admin-pager" aria-label="Weeks">
            <Link to="/reports/control-exceptions" search={{ week: addDays(r.week_start, -7) }}>
              Previous week
            </Link>
            <Link to="/reports/control-exceptions" search={{ week: due }}>
              Next week
            </Link>
          </nav>
        </section>
        {r.exceptions.length === 0 ? (
          <Empty heading="No exceptions this week">
            Every separation-of-duties rule held for the whole week, so there is nothing to
            acknowledge.
          </Empty>
        ) : (
          <div className="admin-block">
            <table className="admin-table" aria-label="Exceptions">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">What happened</th>
                  <th scope="col">Who</th>
                  <th scope="col">How it was allowed</th>
                  <th scope="col">Reason given</th>
                  <th scope="col">Acknowledged</th>
                </tr>
              </thead>
              <tbody>
                {r.exceptions.map((e) => (
                  <tr key={e.id}>
                    <td data-label="When">{timeLabel(e.occurred_at, r.timezone)}</td>
                    <td data-label="What happened">
                      {ruleText(e.rule)}
                      <span className="muted"> ({e.subject_id})</span>
                    </td>
                    <td data-label="Who">{nameOf(e.actor_user_id)}</td>
                    <td data-label="How it was allowed">
                      {KIND_TEXT[e.kind] ?? e.kind}
                      {e.reviewer_user_id ? `: ${nameOf(e.reviewer_user_id)}` : ''}
                    </td>
                    <td data-label="Reason given">{e.reason}</td>
                    <td data-label="Acknowledged">
                      <span className="word" data-status={e.acknowledged ? 'done' : 'open'}>
                        {e.acknowledged ? 'Yes' : 'Not yet'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {r.exceptions.length > 0 ? (
          <section className="admin-block" aria-labelledby="ack-h">
            <h2 id="ack-h">Acknowledgement</h2>
            {r.acknowledged_at ? (
              <p className="done" role="status">
                Acknowledged on {timeLabel(r.acknowledged_at, r.timezone)}
                {open > 0 ? `. ${String(open)} exception since then still needs it.` : '.'}
              </p>
            ) : null}
            {open > 0 ? (
              <>
                <p
                  className="turn"
                  data-open-item=""
                  data-turn={owner ? 'you' : 'owner'}
                  data-due={due}
                >
                  {owner
                    ? 'Your turn: acknowledge this week'
                    : 'Waiting for the Owner to acknowledge this week'}
                </p>
                <p className="admin-note">Due by {dayLabel(due)}.</p>
                {owner ? (
                  <form
                    className="admin-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      ack.mutate(r.week_start);
                    }}
                  >
                    <label htmlFor="ack-note">Note for the record (optional)</label>
                    <textarea
                      id="ack-note"
                      rows={2}
                      maxLength={2000}
                      value={note}
                      onChange={(e) => {
                        setNote(e.target.value);
                      }}
                    />
                    <button type="submit" className="primary" disabled={ack.isPending}>
                      Acknowledge this week
                    </button>
                  </form>
                ) : (
                  <p className="admin-note">Only the Owner can acknowledge the week.</p>
                )}
                <Refusal error={ack.error} />
              </>
            ) : null}
          </section>
        ) : null}
      </>
    );
  }

  return (
    <>
      <PageHead title={TITLE} gloss={GLOSS} />
      {body}
    </>
  );
}
