/**
 * Bank statements (T-0088, UC-08 step 1, SS-UC08-08): choose a bank account (number masked to its
 * last 3 digits), see its imported statements, and import a new file. Parsing, duplicate checks
 * and storage happen in the API (T-0149); the screen shows what it says.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { Empty, Failure, Loading, PageHead } from '../admin/common.tsx';
import { useServices } from '../env.tsx';
import { accountLabel, bytesToBase64, FORMAT_WORD, newKey, plural } from './bank-logic.ts';
import {
  BankForbidden,
  BankRefusal,
  dateText,
  dayText,
  Region,
  useBankContext,
} from './common.tsx';
import type { ImportResult, Statement } from './client.ts';

const TITLE = 'Bank statements';
const GLOSS = 'Import the statements your bank sends, then match their lines to your books.';

function stateText(s: Statement): string {
  if (s.reconciliation_id) return 'Reconciled';
  return s.lines_unmatched === 0 ? 'All matched' : `${String(s.lines_unmatched)} to match`;
}

function periodText(s: Statement): string {
  if (s.period_start && s.period_end)
    return `${dateText(s.period_start)} to ${dateText(s.period_end)}`;
  return 'Not given in the file';
}

export function StatementsPage({ accountId }: { accountId?: string }) {
  const ctx = useBankContext(accountId);
  const { bank } = useServices();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canImport = ctx.access.can('bank.statement.import');
  const [file, setFile] = useState<File | null>(null);
  const [missing, setMissing] = useState(false);
  const [key, setKey] = useState(() => newKey('import'));
  const [done, setDone] = useState<ImportResult | null>(null);
  const account = ctx.account;

  const importFile = useMutation({
    mutationFn: async (f: File) => {
      const base64 = bytesToBase64(new Uint8Array(await f.arrayBuffer()));
      return bank.importStatement(ctx.companyId, account?.id ?? '', { name: f.name, base64 }, key);
    },
    onSuccess: async (r) => {
      setDone(r);
      setKey(newKey('import'));
      await queryClient.invalidateQueries({ queryKey: ['bank', 'statements'] });
    },
    onError: () => setKey(newKey('import')),
  });

  if (ctx.isPending) return <Loading what="bank statements" />;
  if (!ctx.access.isPending && !ctx.access.isError && !ctx.canRead)
    return <BankForbidden title={TITLE} gloss={GLOSS} />;
  if (ctx.error)
    return (
      <Failure
        heading="We could not load your bank statements"
        error={ctx.error}
        onRetry={ctx.refetch}
      />
    );
  if (!account)
    return (
      <>
        <PageHead title={TITLE} gloss={GLOSS} />
        <Empty heading="No bank accounts yet">
          Bank accounts are added in setup. Once one is there, its statements can be imported here.
        </Empty>
      </>
    );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setDone(null);
    if (!file) {
      setMissing(true);
      return;
    }
    setMissing(false);
    importFile.mutate(file);
  };

  return (
    <>
      <PageHead title={TITLE} gloss={GLOSS} />
      <div className="admin-filters">
        <div className="field wide">
          <label htmlFor="bank-account">Bank account</label>
          <select
            id="bank-account"
            value={account.id}
            onChange={(e) =>
              void navigate({ to: '/bank/statements', search: { account: e.target.value } })
            }
          >
            {ctx.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {accountLabel(a)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {canImport ? (
        <Region heading="Import a statement">
          <form className="admin-form" onSubmit={submit} noValidate>
            <label htmlFor="statement-file">Statement file</label>
            <input
              id="statement-file"
              type="file"
              accept=".csv,.ofx,.qfx,.xml,text/csv,application/xml"
              aria-describedby="statement-file-hint"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setMissing(false);
              }}
            />
            <p className="admin-note" id="statement-file-hint">
              CSV, OFX or CAMT.053 from your bank. A file imported before adds no lines twice.
            </p>
            <button type="submit" className="primary" disabled={importFile.isPending}>
              Import statement
            </button>
            {missing ? (
              <p className="refusal" role="alert">
                Choose the statement file first.
              </p>
            ) : null}
            {importFile.isError ? (
              <BankRefusal error={importFile.error} what="import this file" />
            ) : null}
            {done ? (
              <p className="done" role="status">
                {done.message}{' '}
                <Link
                  to="/bank/match"
                  search={{ account: account.id, statement: done.statement_id }}
                >
                  Match the new lines
                </Link>
              </p>
            ) : null}
          </form>
        </Region>
      ) : null}

      <Region heading="Imported statements">
        {ctx.statements.length === 0 ? (
          <p className="admin-note">No statements yet for this account.</p>
        ) : (
          <table className="admin-table" aria-label="Imported statements">
            <thead>
              <tr>
                <th scope="col">Imported</th>
                <th scope="col">File</th>
                <th scope="col">Period</th>
                <th scope="col">Lines</th>
                <th scope="col">State</th>
                <th scope="col">Next</th>
              </tr>
            </thead>
            <tbody>
              {ctx.statements.map((s) => (
                <tr key={s.id}>
                  <td data-label="Imported">{dayText(s.imported_at)}</td>
                  <td data-label="File">
                    {s.file_name ?? 'Unnamed file'}{' '}
                    <span className="admin-note">({FORMAT_WORD[s.format]})</span>
                  </td>
                  <td data-label="Period">{periodText(s)}</td>
                  <td data-label="Lines">{plural(s.lines_total, 'line')}</td>
                  <td data-label="State">
                    <span
                      className="word"
                      data-status={s.reconciliation_id ? 'reconciled' : 'open'}
                    >
                      {stateText(s)}
                    </span>
                  </td>
                  <td data-label="Next">
                    <ul className="bank-links">
                      {s.reconciliation_id ? null : (
                        <li>
                          <Link to="/bank/match" search={{ account: account.id, statement: s.id }}>
                            Match lines
                          </Link>
                        </li>
                      )}
                      <li>
                        <Link
                          to="/bank/reconciliation"
                          search={{ account: account.id, statement: s.id }}
                        >
                          Reconciliation report
                        </Link>
                      </li>
                    </ul>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Region>
    </>
  );
}
