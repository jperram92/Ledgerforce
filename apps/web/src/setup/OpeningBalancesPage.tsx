/**
 * Opening balances, setup wizard step 9 (T-0177, design §4.1 step 9, GP-037, SS-PLAT-132, DL-0651).
 * A Finance Admin chooses the conversion date and the old system's files: the trial balance and
 * the open customer and supplier items, as CSV. The screen sends them to the posting engine's
 * preview and shows the journal before anything posts (P4), then posts it once
 * (Idempotency-Key). The API (T-0080) reads the files, builds the GP-037 journal, and refuses
 * anything wrong. This screen computes nothing: it shows what the engine answers.
 * Every route needs settings.chart.manage, so without it the screen says so and reads nothing.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { JournalTable, Money } from '@ledgerforce/ui';
import { useId, useState, type ChangeEvent, type ReactNode } from 'react';
import {
  Failure,
  Forbidden,
  Loading,
  PageHead,
  Refusal,
  useAccess,
  useFailureRouting,
} from '../admin/common.tsx';
import { useServices } from '../env.tsx';
import { typeGloss } from '../gl/gl-logic.ts';
import { useCompany } from '../sales/InvoicesPage.tsx';
import type { OpeningBalance, OpeningBalanceFiles, OpeningPreview } from './client.ts';
import { balanceDay, kindWord, obRefusal, sideOf } from './opening-logic.ts';

const TITLE = 'Opening balances';
const GLOSS =
  'The balances your books start from: the old system’s trial balance on the day before you start in LedgerForce, with the customer invoices and supplier bills still open behind it.';
const newKey = () => `opening-${crypto.randomUUID()}`;

function ObRefusal({ error }: { error: unknown }) {
  const text = obRefusal(error);
  if (!text) return <Refusal error={error} />;
  return (
    <p className="refusal" role="alert">
      {text}
    </p>
  );
}

function Posted({ ob, currency }: { ob: OpeningBalance; currency: string }) {
  return (
    <section className="admin-block" aria-labelledby="ob-posted-h">
      <h2 id="ob-posted-h" tabIndex={-1}>
        The opening balance is posted
      </h2>
      <p>
        Journal {ob.entry_no ?? ob.entry_id}, dated {balanceDay(ob.balance_date)} (the day before
        the conversion date, {balanceDay(ob.conversion_date)}). To correct it, reverse the whole
        journal and post a new one.
      </p>
      {ob.items.length === 0 ? (
        <p className="admin-note">No open customer or supplier items were brought across.</p>
      ) : (
        <div className="scroll">
          <table className="admin-table">
            <caption>Open items brought across</caption>
            <thead>
              <tr>
                <th scope="col">Document</th>
                <th scope="col">Who owes</th>
                <th scope="col">Dated</th>
                <th scope="col">Due</th>
                <th scope="col" className="num">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {ob.items.map((i) => (
                <tr key={`${i.kind}-${i.document_no}-${String(i.line_no)}`}>
                  <th scope="row">{i.document_no}</th>
                  <td data-label="Who owes">{kindWord(i.kind)}</td>
                  <td data-label="Dated">{balanceDay(i.document_date)}</td>
                  <td data-label="Due">{balanceDay(i.due_date)}</td>
                  <td className="num" data-label="Amount">
                    <Money value={i.amount} currency={currency} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p>
        <Link to="/settings/setup">Back to the setup steps</Link>
      </p>
    </section>
  );
}

function Preview({
  preview,
  currency,
  names,
  children,
}: {
  preview: OpeningPreview;
  currency: string;
  names: Map<string, { name: string; type: string }>;
  children: ReactNode;
}) {
  return (
    <section className="admin-block" aria-labelledby="ob-preview-h">
      <h2 id="ob-preview-h">The journal LedgerForce would post</h2>
      <p className="admin-note">
        From the posting engine itself, dated {balanceDay(preview.entry_date)}. Nothing is posted
        yet. Each open item has its own line on the customer or supplier control account.
      </p>
      <JournalTable
        journal="preview"
        currency={currency}
        lines={preview.lines.map((l) => {
          const a = names.get(l.account_code);
          return {
            code: l.account_code,
            account: a?.name ?? `Account ${l.account_code}`,
            gloss: l.party_id && l.memo ? l.memo : a ? typeGloss(a.type) : '',
            ...sideOf(l),
          };
        })}
      />
      {children}
    </section>
  );
}

export function OpeningBalancesPage() {
  const access = useAccess();
  const { setup, gl } = useServices();
  const queryClient = useQueryClient();
  const canManage = access.can('settings.chart.manage');
  const company = useCompany();
  const companyId = company.company?.id ?? '';
  const currency = company.company?.base_currency ?? 'AUD';
  const [date, setDate] = useState('');
  const [tb, setTb] = useState<string | null>(null);
  const [ar, setAr] = useState<string | null>(null);
  const [ap, setAp] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [key, setKey] = useState(newKey);
  const ids = { date: useId(), tb: useId(), ar: useId(), ap: useId(), problem: useId() };

  const obKey = ['setup', 'opening-balance', companyId] as const;
  const current = useQuery({
    queryKey: obKey,
    queryFn: () => setup.openingBalance(companyId),
    enabled: canManage && !!companyId,
  });
  // Account names for the journal; the code alone is shown when the chart cannot be read.
  const chart = useQuery({
    queryKey: ['gl', 'chart'],
    queryFn: () => gl.chart(),
    enabled: canManage && access.can('gl.account.read'),
  });
  const names = new Map(
    (chart.data?.accounts ?? [])
      .filter((a) => a.company_id === companyId)
      .map((a) => [a.code, { name: a.name, type: a.type }]),
  );

  const files = (): OpeningBalanceFiles => ({
    company_id: companyId,
    conversion_date: date,
    trial_balance_csv: tb ?? '',
    ...(ar !== null ? { ar_items_csv: ar } : {}),
    ...(ap !== null ? { ap_items_csv: ap } : {}),
  });
  const preview = useMutation({
    mutationFn: (f: OpeningBalanceFiles) => setup.previewOpeningBalance(f),
  });
  const post = useMutation({
    mutationFn: (f: OpeningBalanceFiles) => setup.postOpeningBalance(f, key),
    onSuccess: async (ob) => {
      setKey(newKey());
      queryClient.setQueryData(obKey, ob);
      await queryClient.invalidateQueries({ queryKey: ['setup', 'wizard'] });
    },
  });
  useFailureRouting(current.error ?? company.error ?? preview.error ?? post.error);

  /** Any change of input drops the preview and its key: the journal shown is the one posted. */
  const changed = () => {
    preview.reset();
    post.reset();
    setKey(newKey());
    setProblem(null);
  };
  const read =
    (set: (v: string | null) => void) =>
    async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
      changed();
      const f = e.target.files?.[0];
      set(f ? await f.text() : null);
    };

  if (access.isPending || (canManage && (company.isPending || (!!companyId && current.isPending))))
    return <Loading what="the opening balance" />;
  if (access.isError)
    return (
      <Failure
        heading="We could not check what you may do"
        error={access.error}
        onRetry={() => void access.refetch()}
      />
    );
  if (!canManage)
    return (
      <>
        <PageHead title={TITLE} gloss={GLOSS} />
        <Forbidden heading="You can't import opening balances">
          Importing opening balances sets up the books, so only the Owner or a Finance Admin can do
          it. Ask your Owner if you need to.
        </Forbidden>
      </>
    );
  if (company.isError || current.isError || current.data === undefined)
    return (
      <Failure
        heading="We could not load the opening balance"
        error={current.error ?? company.error}
        onRetry={() => void (current.isError ? current.refetch() : company.refetch())}
      />
    );

  if (current.data)
    return (
      <>
        <PageHead title={TITLE} gloss={GLOSS} />
        <Posted ob={current.data} currency={currency} />
      </>
    );

  const show = () => {
    if (date === '') return setProblem('Choose the conversion date first.');
    if (tb === null) return setProblem('Choose the trial balance file first.');
    setProblem(null);
    preview.mutate(files());
  };
  const shown = preview.isSuccess ? preview.data : undefined;

  return (
    <>
      <PageHead title={TITLE} gloss={GLOSS} />
      <p className="admin-note">No opening balance has been posted yet.</p>
      <section className="admin-block" aria-labelledby="ob-files-h">
        <h2 id="ob-files-h">The files from your old system</h2>
        <form
          className="admin-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            show();
          }}
        >
          <label htmlFor={ids.date}>Conversion date</label>
          <p className="admin-note" id={`${ids.date}-hint`}>
            The first day in LedgerForce. The balances are those at the end of the day before.
          </p>
          <input
            id={ids.date}
            type="date"
            value={date}
            aria-describedby={problem ? `${ids.date}-hint ${ids.problem}` : `${ids.date}-hint`}
            onChange={(e) => {
              changed();
              setDate(e.target.value);
            }}
          />
          <label htmlFor={ids.tb}>Trial balance (CSV file)</label>
          <p className="admin-note" id={`${ids.tb}-hint`}>
            Columns account_code, debit and credit.
          </p>
          <input
            id={ids.tb}
            aria-describedby={`${ids.tb}-hint`}
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => void read(setTb)(e)}
          />
          <label htmlFor={ids.ar}>Open customer invoices (CSV file, optional)</label>
          <p className="admin-note" id={`${ids.ar}-hint`}>
            Columns party, document_no, document_date, due_date, amount and gst_amount.
          </p>
          <input
            id={ids.ar}
            aria-describedby={`${ids.ar}-hint`}
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => void read(setAr)(e)}
          />
          <label htmlFor={ids.ap}>Open supplier bills (CSV file, optional)</label>
          <p className="admin-note" id={`${ids.ap}-hint`}>
            The same columns; an unpaid bill is a negative amount.
          </p>
          <input
            id={ids.ap}
            aria-describedby={`${ids.ap}-hint`}
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => void read(setAp)(e)}
          />
          {problem ? (
            <p className="refusal" id={ids.problem} role="alert">
              {problem}
            </p>
          ) : null}
          <button
            type="submit"
            className={shown ? 'secondary' : 'primary'}
            disabled={preview.isPending}
          >
            Show the journal
          </button>
        </form>
        {preview.isPending ? <Loading what="the journal LedgerForce would post" /> : null}
        {preview.isError ? <ObRefusal error={preview.error} /> : null}
      </section>
      {shown ? (
        <Preview preview={shown} currency={currency} names={names}>
          <div className="wizard-actions">
            <button
              type="button"
              className="primary"
              disabled={post.isPending}
              onClick={() => post.mutate(files())}
            >
              Post the opening balance
            </button>
            {post.isError ? <ObRefusal error={post.error} /> : null}
          </div>
        </Preview>
      ) : null}
    </>
  );
}
