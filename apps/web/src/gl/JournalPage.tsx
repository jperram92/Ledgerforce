/**
 * One manual journal (SS-PLAT-94, SS-PLAT-95): "show me the journal" from the posting engine's
 * preview before anything posts (P4, design §3.9), the people involved (P7), whose turn it is
 * (P13) and the next step the caller may take. A refused preview shows the draft's lines with the
 * refused one marked in words and the reason in plain words (P2, P6); Submit is not offered
 * until the draft is changed. Posted journals never change (P5).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { JournalTable, Money } from '@ledgerforce/ui';
import { useId, useState, type ReactNode } from 'react';
import { AdminApiError } from '../admin/client.ts';
import {
  Failure,
  Forbidden,
  Loading,
  PageHead,
  useAccess,
  useFailureRouting,
} from '../admin/common.tsx';
import { useServices } from '../env.tsx';
import { accountLabel, useChart } from './ChartPage.tsx';
import type { Chart, Journal } from './client.ts';
import { lineAccountId, statusWord, turnOf, typeGloss } from './gl-logic.ts';
import { JOURNALS_KEY } from './JournalsPage.tsx';
import { journalKey } from './JournalFormPage.tsx';
import { APPROVERS, GL_READERS, glMessageFor, PREPARERS, refusalOf } from './messages.ts';

const previewKey = (id: string) => ['gl', 'preview', id] as const;

export function JournalPage({ journalId }: { journalId: string }) {
  const access = useAccess();
  const { gl } = useServices();
  const canRead = access.can('gl.journal.read');
  const doc = useQuery({
    queryKey: journalKey(journalId),
    queryFn: () => gl.journal(journalId),
    enabled: canRead,
  });
  useFailureRouting(doc.error);
  const chart = useChart(canRead && access.can('gl.account.read'));

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
      <Forbidden heading="You can't see manual journals">
        {GL_READERS} can see manual journals. Ask your Owner if you need to.
      </Forbidden>
    );
  else if (doc.isPending) body = <Loading what="the journal" />;
  else if (doc.isError)
    body = (
      <Failure
        heading="We could not load this journal"
        error={doc.error}
        onRetry={() => void doc.refetch()}
      />
    );
  else body = <Detail doc={doc.data} chart={chart.data} can={access.can} />;

  const title = doc.data?.entry_no ? `Manual journal ${doc.data.entry_no}` : 'Manual journal';
  return (
    <>
      <PageHead
        title={title}
        gloss={doc.data?.memo ?? 'A journal written by hand, posted only through LedgerForce.'}
      />
      {body}
      <p className="admin-note">
        <Link to="/accounting/journals">All manual journals</Link>
      </p>
    </>
  );
}

function Detail({
  doc,
  chart,
  can,
}: {
  doc: Journal;
  chart: Chart | undefined;
  can: (p: string) => boolean;
}) {
  const { gl } = useServices();
  const me = useMe();
  const queryClient = useQueryClient();
  const [done, setDone] = useState('');
  const [reason, setReason] = useState('');
  const preview = useQuery({
    queryKey: previewKey(doc.id),
    queryFn: () => gl.preview(doc.id),
    enabled: doc.status !== 'posted',
  });
  useFailureRouting(preview.error);
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: journalKey(doc.id) });
    await queryClient.invalidateQueries({ queryKey: previewKey(doc.id) });
    await queryClient.invalidateQueries({ queryKey: JOURNALS_KEY });
  };
  const act = useMutation({
    mutationFn: async (what: 'submit' | 'approve' | 'reject' | 'post'): Promise<string> => {
      switch (what) {
        case 'submit': {
          const r = await gl.submit(doc.id);
          return r.approval_required
            ? 'Submitted. It needs an approval before it posts.'
            : 'Submitted. It can be posted now.';
        }
        case 'approve':
          await gl.approve(doc.id);
          return 'Approved. It can be posted now.';
        case 'reject':
          await gl.reject(doc.id, reason.trim());
          return 'Sent back to the preparer as a draft.';
        case 'post': {
          const r = await gl.post(doc.id);
          return `Posted as ${r.entry_no} on ${r.entry_date}.`;
        }
      }
    },
    onSuccess: async (text) => {
      setDone(text);
      setReason('');
      await refresh();
    },
  });
  useFailureRouting(act.error);

  const names = doc.people;
  const name = (id: string | null) =>
    id === null ? '' : `${names[id] ?? 'someone'}${id === me ? ' (you)' : ''}`;
  const account = (lineNo: number) => {
    const line = doc.lines[lineNo - 1];
    const a = line && chart?.accounts.find((x) => x.id === lineAccountId(line, chart.accounts));
    return a ? accountLabel(a) : '';
  };
  const turn = turnOf(doc, me, can, names);
  const refused = refusalOf(preview.error);
  const previewOk = preview.isSuccess;
  const sendBack = doc.rejected_by !== null && doc.status === 'draft';

  return (
    <>
      <div className="admin-block gl-facts">
        <p>
          <span className="word" data-status={doc.status}>
            {statusWord(doc.status, doc.approval_required)}
          </span>{' '}
          Dated {doc.entry_date}
          {doc.total ? (
            <>
              {' '}
              , total <Money value={doc.total} />
            </>
          ) : null}
        </p>
        {turn ? (
          <p className="turn" data-open-item="" data-turn={turn.turn} data-due={doc.entry_date}>
            {turn.text}
          </p>
        ) : null}
        <ul className="gl-people" aria-label="People involved">
          <li>Prepared by {name(doc.created_by)}</li>
          {doc.submitted_by ? <li>Submitted by {name(doc.submitted_by)}</li> : null}
          {sendBack ? (
            <li>
              Sent back by {name(doc.rejected_by)}: {doc.rejection_reason}
            </li>
          ) : null}
          {doc.approved_by ? <li>Approved by {name(doc.approved_by)}</li> : null}
          {doc.posted_by ? <li>Posted by {name(doc.posted_by)}</li> : null}
        </ul>
      </div>

      <Region heading="Journal">
        {doc.status === 'posted' ? (
          <>
            <JournalTable
              journal={doc.entry_no ?? ''}
              lines={storedLines(doc, chart)}
              currency={
                chart?.companies.find((c) => c.id === doc.company_id)?.base_currency ?? 'AUD'
              }
            />
            <p className="admin-note">
              Posted journals never change. A correction is a new journal that reverses this one.
            </p>
          </>
        ) : preview.isPending ? (
          <Loading what="the journal LedgerForce would post" />
        ) : previewOk ? (
          <>
            <p className="admin-note">
              This is the journal LedgerForce would post now, from the posting engine itself.
              Nothing is posted yet.
              {preview.data.redirected
                ? ` The date ${preview.data.requested_date} is in a closed period, so it would post on ${preview.data.entry_date}.`
                : ''}
            </p>
            <JournalTable
              journal="preview"
              currency={preview.data.base_currency}
              lines={preview.data.lines.map((l) => ({
                code: l.account_code,
                account: l.account_name,
                gloss: typeGloss(l.account_type),
                ...(l.debit !== '0.0000' ? { debit: l.debit } : { credit: l.credit }),
              }))}
            />
          </>
        ) : refused ? (
          <>
            <DraftLines doc={doc} chart={chart} refusedLine={refused.line} />
            <p className="refusal" role="alert">
              {glMessageFor(preview.error, account)}
            </p>
          </>
        ) : (
          <Failure
            heading="We could not build the journal"
            error={preview.error}
            onRetry={() => void preview.refetch()}
          />
        )}
      </Region>

      <Region heading="Next step">
        <Actions
          doc={doc}
          can={can}
          me={me}
          previewOk={previewOk}
          busy={act.isPending}
          reason={reason}
          setReason={setReason}
          onAct={(what) => {
            setDone('');
            act.mutate(what);
          }}
        />
        {act.error && !(act.error instanceof AdminApiError && act.error.status === 401) ? (
          <p className="refusal" role="alert">
            {glMessageFor(act.error, account)}
          </p>
        ) : null}
        {done ? (
          <p className="done" role="status">
            {done}
          </p>
        ) : null}
      </Region>
    </>
  );
}

function Region({ heading, children }: { heading: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="admin-block" aria-labelledby={id}>
      <h2 id={id}>{heading}</h2>
      {children}
    </section>
  );
}

function useMe(): string {
  const { api } = useServices();
  const me = useQuery({ queryKey: ['auth', 'me'], queryFn: () => api.me() });
  return me.data?.user_id ?? '';
}

function storedLines(doc: Journal, chart: Chart | undefined) {
  return doc.lines.map((l) => {
    const a = chart?.accounts.find((x) => x.id === lineAccountId(l, chart.accounts));
    return {
      code: a?.code ?? '',
      account: a?.name ?? 'Account',
      gloss: a ? typeGloss(a.type) : '',
      ...(l.debit !== undefined ? { debit: l.debit } : { credit: l.credit ?? '' }),
    };
  });
}

/** The draft as written, with the refused line marked in words. */
function DraftLines({
  doc,
  chart,
  refusedLine,
}: {
  doc: Journal;
  chart: Chart | undefined;
  refusedLine: number | null;
}) {
  return (
    <table className="admin-table gl-draft" aria-label="Lines of this draft">
      <thead>
        <tr>
          <th scope="col">Line</th>
          <th scope="col">Account</th>
          <th scope="col" className="num">
            Debit
          </th>
          <th scope="col" className="num">
            Credit
          </th>
          <th scope="col">Check</th>
        </tr>
      </thead>
      <tbody>
        {doc.lines.map((l, i) => {
          const a = chart?.accounts.find((x) => x.id === lineAccountId(l, chart.accounts));
          const bad = refusedLine === i + 1;
          return (
            <tr key={i} data-refused={bad ? 'yes' : undefined}>
              <td data-label="Line">{i + 1}</td>
              <td data-label="Account">
                {a ? accountLabel(a) : (l.account.role ?? l.account.id ?? '')}
                {l.memo ? <span className="sm"> ({l.memo})</span> : null}
              </td>
              <td data-label="Debit" className="num">
                {l.debit ? <Money value={l.debit} /> : null}
              </td>
              <td data-label="Credit" className="num">
                {l.credit ? <Money value={l.credit} /> : null}
              </td>
              <td data-label="Check">
                {bad ? (
                  <span className="word" data-status="refused">
                    Refused
                  </span>
                ) : (
                  ''
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Actions({
  doc,
  can,
  me,
  previewOk,
  busy,
  reason,
  setReason,
  onAct,
}: {
  doc: Journal;
  can: (p: string) => boolean;
  me: string;
  previewOk: boolean;
  busy: boolean;
  reason: string;
  setReason: (v: string) => void;
  onAct: (what: 'submit' | 'approve' | 'reject' | 'post') => void;
}) {
  const edit = (
    <Link
      to="/accounting/journals/$journalId/edit"
      params={{ journalId: doc.id }}
      className={previewOk ? 'secondary' : 'primary'}
    >
      Change the draft
    </Link>
  );
  if (doc.status === 'draft') {
    if (!can('gl.journal.post')) return <p className="admin-note">{PREPARERS} can submit it.</p>;
    return (
      <div className="gl-actions">
        {previewOk ? (
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => {
              onAct('submit');
            }}
          >
            Submit
          </button>
        ) : (
          <p className="admin-note">Change the line the journal above points to, then submit it.</p>
        )}
        {edit}
      </div>
    );
  }
  const needsApproval = doc.status === 'submitted' && doc.approval_required !== false;
  if (needsApproval) {
    if (!can('gl.journal.approve'))
      return (
        <p className="admin-note">
          It is above the approval limit or touches a control, tax or equity account, so someone
          other than the preparer approves it. {APPROVERS} can approve it.
        </p>
      );
    return (
      <div className="gl-actions-col">
        {doc.submitted_by === me ? (
          <p className="admin-note">
            You submitted this journal. Someone else should approve it; in small-team mode your
            approval is allowed and recorded for the Owner&apos;s weekly review.
          </p>
        ) : null}
        <div className="gl-actions">
          <button
            type="button"
            className="primary"
            disabled={busy || !previewOk}
            onClick={() => {
              onAct('approve');
            }}
          >
            Approve
          </button>
        </div>
        <form
          className="admin-form inline"
          onSubmit={(e) => {
            e.preventDefault();
            onAct('reject');
          }}
        >
          <label htmlFor="mj-reason">Why send it back? (kept with the journal)</label>
          <input
            id="mj-reason"
            required
            maxLength={2000}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
            }}
          />
          <button type="submit" className="secondary" disabled={busy || reason.trim() === ''}>
            Send back to the preparer
          </button>
        </form>
      </div>
    );
  }
  if (doc.status === 'submitted' || doc.status === 'approved') {
    if (!can('gl.journal.post')) return <p className="admin-note">{PREPARERS} can post it.</p>;
    return (
      <div className="gl-actions">
        <button
          type="button"
          className="primary"
          disabled={busy || !previewOk}
          onClick={() => {
            onAct('post');
          }}
        >
          Post to the ledger
        </button>
      </div>
    );
  }
  return <p className="admin-note">Posted as {doc.entry_no}. There is nothing more to do.</p>;
}
