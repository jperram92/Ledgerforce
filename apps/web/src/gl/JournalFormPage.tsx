/**
 * Write or change a manual-journal draft (SS-PLAT-94, IA S12). Amounts are typed as decimal
 * strings and sent as typed (no arithmetic here); whether the journal balances, and every other
 * posting rule, is the engine's to say on the next page ("show me the journal", P4). A new draft
 * carries one Idempotency-Key per form, so a double click saves one draft.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { AdminApiError } from '../admin/client.ts';
import { useServices } from '../env.tsx';
import {
  Failure,
  Forbidden,
  Loading,
  PageHead,
  useAccess,
  useFailureRouting,
} from '../admin/common.tsx';
import { accountLabel, useChart } from './ChartPage.tsx';
import type { Chart, Journal } from './client.ts';
import { docToForm, formToBody, TYPE_HEADING, TYPE_ORDER, type JournalForm } from './gl-logic.ts';
import { JOURNALS_KEY } from './JournalsPage.tsx';
import { glMessageFor, PREPARERS } from './messages.ts';

export const journalKey = (id: string) => ['gl', 'journal', id] as const;

const emptyLine = () => ({ accountId: '', debit: '', credit: '', memo: '' });

export function JournalFormPage({ journalId }: { journalId?: string | undefined }) {
  const access = useAccess();
  const { gl } = useServices();
  const canPost = access.can('gl.journal.post');
  const chart = useChart(canPost);
  const doc = useQuery({
    queryKey: journalKey(journalId ?? ''),
    queryFn: () => gl.journal(journalId ?? ''),
    enabled: canPost && journalId !== undefined,
  });
  useFailureRouting(doc.error);
  const title = journalId ? 'Change manual journal' : 'New manual journal';

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
  else if (!canPost)
    body = (
      <Forbidden heading="You can't write manual journals">
        {PREPARERS} can write manual journals. Ask your Owner if you need to.
      </Forbidden>
    );
  else if (chart.isPending || (journalId !== undefined && doc.isPending))
    body = <Loading what="the chart of accounts" />;
  else if (chart.isError)
    body = (
      <Failure
        heading="We could not load the chart of accounts"
        error={chart.error}
        onRetry={() => void chart.refetch()}
      />
    );
  else if (doc.isError)
    body = (
      <Failure
        heading="We could not load this journal"
        error={doc.error}
        onRetry={() => void doc.refetch()}
      />
    );
  else if (doc.data && doc.data.status !== 'draft')
    body = (
      <p className="admin-note">
        Only drafts can be changed. This journal is past that.{' '}
        <Link to="/accounting/journals/$journalId" params={{ journalId: doc.data.id }}>
          Back to the journal
        </Link>
      </p>
    );
  else if (chart.data.accounts.length === 0 || chart.data.companies.length === 0)
    body = (
      <p className="admin-note">
        There is no chart of accounts yet, so there is nothing to post to. It is set up in step 2 of
        setup.
      </p>
    );
  else body = <Editor chart={chart.data} doc={doc.data} />;

  return (
    <>
      <PageHead
        title={title}
        gloss="Each line goes to one account, as a debit or a credit. You see the journal LedgerForce would post before anything is posted."
      />
      {body}
    </>
  );
}

function Editor({ chart, doc }: { chart: Chart; doc: Journal | undefined }) {
  const { gl } = useServices();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [key] = useState(() => `mj-${crypto.randomUUID()}`);
  const [form, setForm] = useState<JournalForm>(() =>
    doc
      ? docToForm(doc, chart.accounts)
      : {
          companyId: chart.companies[0]?.id ?? '',
          entryDate: new Date().toISOString().slice(0, 10),
          memo: '',
          lines: [emptyLine(), emptyLine()],
        },
  );
  const [problems, setProblems] = useState<string[]>([]);
  const save = useMutation({
    mutationFn: async (b: ReturnType<typeof formToBody>) => {
      if (!b.ok) throw new Error('unreachable');
      return doc ? gl.update(doc.id, b.body) : gl.create(b.body, key);
    },
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: JOURNALS_KEY });
      await queryClient.invalidateQueries({ queryKey: journalKey(saved.id) });
      await queryClient.invalidateQueries({ queryKey: ['gl', 'preview', saved.id] });
      await navigate({ to: '/accounting/journals/$journalId', params: { journalId: saved.id } });
    },
  });
  useFailureRouting(save.error);
  const accounts = chart.accounts.filter(
    (a) => a.status === 'active' && a.company_id === form.companyId,
  );
  const setLine = (i: number, k: keyof JournalForm['lines'][number], v: string) => {
    setForm({ ...form, lines: form.lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)) });
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const b = formToBody(form);
    if (!b.ok) {
      setProblems(b.problems);
      return;
    }
    setProblems([]);
    save.mutate(b);
  };

  return (
    <section className="admin-block" aria-labelledby="mj-form-h">
      <h2 id="mj-form-h" className="sr-only">
        Journal details
      </h2>
      <form className="admin-form gl-form" onSubmit={submit} noValidate>
        {chart.companies.length > 1 ? (
          <>
            <label htmlFor="mj-company">Company</label>
            <select
              id="mj-company"
              value={form.companyId}
              disabled={doc !== undefined}
              onChange={(e) => {
                setForm({ ...form, companyId: e.target.value });
              }}
            >
              {chart.companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </>
        ) : null}
        <label htmlFor="mj-date">Date</label>
        <input
          id="mj-date"
          type="date"
          required
          value={form.entryDate}
          onChange={(e) => {
            setForm({ ...form, entryDate: e.target.value });
          }}
        />
        <label htmlFor="mj-memo">What is this journal for?</label>
        <input
          id="mj-memo"
          maxLength={2000}
          value={form.memo}
          onChange={(e) => {
            setForm({ ...form, memo: e.target.value });
          }}
        />
        <fieldset className="gl-lines">
          <legend>Lines</legend>
          {form.lines.map((l, i) => {
            const n = String(i + 1);
            return (
              <div className="gl-line" key={i} role="group" aria-label={`Line ${n}`}>
                <div className="gl-field gl-account">
                  <label htmlFor={`mj-acct-${n}`}>Line {n} account</label>
                  <select
                    id={`mj-acct-${n}`}
                    value={l.accountId}
                    onChange={(e) => {
                      setLine(i, 'accountId', e.target.value);
                    }}
                  >
                    <option value="">Choose an account</option>
                    {TYPE_ORDER.map((t) => (
                      <optgroup key={t} label={TYPE_HEADING[t]}>
                        {accounts
                          .filter((a) => a.type === t)
                          .map((a) => (
                            <option key={a.id} value={a.id}>
                              {accountLabel(a)}
                            </option>
                          ))}
                      </optgroup>
                    ))}
                  </select>
                </div>
                <div className="gl-field">
                  <label htmlFor={`mj-dr-${n}`}>Line {n} debit</label>
                  <input
                    id={`mj-dr-${n}`}
                    inputMode="decimal"
                    autoComplete="off"
                    className="num"
                    value={l.debit}
                    onChange={(e) => {
                      setLine(i, 'debit', e.target.value);
                    }}
                  />
                </div>
                <div className="gl-field">
                  <label htmlFor={`mj-cr-${n}`}>Line {n} credit</label>
                  <input
                    id={`mj-cr-${n}`}
                    inputMode="decimal"
                    autoComplete="off"
                    className="num"
                    value={l.credit}
                    onChange={(e) => {
                      setLine(i, 'credit', e.target.value);
                    }}
                  />
                </div>
                <div className="gl-field gl-memo">
                  <label htmlFor={`mj-memo-${n}`}>Line {n} note</label>
                  <input
                    id={`mj-memo-${n}`}
                    maxLength={500}
                    value={l.memo}
                    onChange={(e) => {
                      setLine(i, 'memo', e.target.value);
                    }}
                  />
                </div>
                {form.lines.length > 2 ? (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      setForm({ ...form, lines: form.lines.filter((_, j) => j !== i) });
                    }}
                  >
                    Remove line {n}
                  </button>
                ) : null}
              </div>
            );
          })}
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setForm({ ...form, lines: [...form.lines, emptyLine()] });
            }}
          >
            Add a line
          </button>
        </fieldset>
        {problems.length > 0 ? (
          <div className="refusal" role="alert">
            <p>Before saving:</p>
            <ul>
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <button type="submit" className="primary" disabled={save.isPending}>
          Save draft and show the journal
        </button>
      </form>
      {save.error && !(save.error instanceof AdminApiError && save.error.status === 401) ? (
        <p className="refusal" role="alert">
          {glMessageFor(save.error)}
        </p>
      ) : null}
      <p className="admin-note">
        <Link
          to={doc ? '/accounting/journals/$journalId' : '/accounting/journals'}
          params={doc ? { journalId: doc.id } : {}}
        >
          {doc ? 'Back to the journal without saving' : 'Back to manual journals'}
        </Link>
      </p>
    </section>
  );
}
