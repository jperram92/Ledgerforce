/**
 * Manual journals (SS-PLAT-94, IA "Accounting → Journals"): the newest journals with their status
 * in words, date, who prepared them and the amount as the API's decimal string (P3). Preparers
 * (gl.journal.post) start a new one; everyone else is told who can.
 */
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Money } from '@ledgerforce/ui';
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
import type { JournalStatus } from './client.ts';
import { statusWord } from './gl-logic.ts';
import { GL_READERS, PREPARERS } from './messages.ts';

export const JOURNALS_KEY = ['gl', 'journals'] as const;

const FILTERS: { value: '' | JournalStatus; label: string }[] = [
  { value: '', label: 'All journals' },
  { value: 'draft', label: 'Drafts' },
  { value: 'submitted', label: 'Submitted' },
  { value: 'approved', label: 'Approved' },
  { value: 'posted', label: 'Posted' },
];

export function isJournalStatus(v: unknown): v is JournalStatus {
  return v === 'draft' || v === 'submitted' || v === 'approved' || v === 'posted';
}

export function JournalsPage({ status }: { status?: JournalStatus | undefined }) {
  const access = useAccess();
  const { gl } = useServices();
  const navigate = useNavigate();
  const canRead = access.can('gl.journal.read');
  const list = useQuery({
    queryKey: [...JOURNALS_KEY, status ?? 'all'],
    queryFn: () => gl.journals(status),
    enabled: canRead,
  });
  useFailureRouting(list.error);

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
  else {
    let table;
    if (list.isPending) table = <Loading what="manual journals" />;
    else if (list.isError)
      table = (
        <Failure
          heading="We could not load the manual journals"
          error={list.error}
          onRetry={() => void list.refetch()}
        />
      );
    else if (list.data.journals.length === 0)
      table = (
        <Empty heading={status ? 'No journals with this status' : 'No manual journals yet'}>
          Manual journals correct or add to the books where no invoice, bill or bank line does, for
          example accruals and depreciation.
        </Empty>
      );
    else
      table = (
        <div className="admin-block">
          <table className="admin-table" aria-label="Manual journals">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Journal</th>
                <th scope="col">Status</th>
                <th scope="col">Prepared by</th>
                <th scope="col" className="num">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {list.data.journals.map((j) => (
                <tr key={j.id}>
                  <td data-label="Date">{j.entry_date}</td>
                  <td data-label="Journal">
                    <Link to="/accounting/journals/$journalId" params={{ journalId: j.id }}>
                      {j.entry_no ? `${j.entry_no} · ` : ''}
                      {j.memo ?? 'Manual journal'}
                    </Link>
                  </td>
                  <td data-label="Status">
                    <span className="word" data-status={j.status}>
                      {statusWord(j.status, j.approval_required)}
                    </span>
                  </td>
                  <td data-label="Prepared by">{j.created_by_name}</td>
                  <td data-label="Amount" className="num">
                    <Money value={j.amount} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    body = (
      <>
        <div className="admin-filters gl-bar">
          <div className="field">
            <label htmlFor="mj-filter">Show</label>
            <select
              id="mj-filter"
              value={status ?? ''}
              onChange={(e) => {
                const v = e.target.value;
                void navigate({
                  to: '/accounting/journals',
                  search: isJournalStatus(v) ? { status: v } : {},
                });
              }}
            >
              {FILTERS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>
          <div className="actions">
            {access.can('gl.journal.post') ? (
              <Link to="/accounting/journals/new" className="primary">
                New manual journal
              </Link>
            ) : (
              <p className="admin-note">{PREPARERS} can write manual journals.</p>
            )}
          </div>
        </div>
        {table}
      </>
    );
  }

  return (
    <>
      <PageHead
        title="Manual journals"
        gloss="Journals written by hand (manual journals): accruals, corrections and adjustments, each approved where the rules need it."
      />
      {body}
    </>
  );
}
