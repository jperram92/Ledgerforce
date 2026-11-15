/**
 * Company details: setup wizard step 1 (T-0176, SS-PLAT-129, design §4.1, ADR-0081). The legal
 * name, ABN and base currency, and the financial years. Someone with settings.setup.manage edits
 * them; others with settings.read see them read-only. The API checks the ABN, locks the base
 * currency once journals exist (DL-0641) and refuses overlapping years; this screen only says so.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useMemo, useState } from 'react';
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
import { useCompany } from '../sales/InvoicesPage.tsx';
import { createSettingsClient, type CompanySettings } from './client.ts';
import { abnText, companyRefusal, dayText, fiscalStart, MONTH_NAMES } from './settings-logic.ts';

const TITLE = 'Company details';
const GLOSS =
  'The legal name, ABN and base currency of the company, and its financial years. Setup step 1.';
const LOCKED =
  'The base currency cannot change: the company already has journal entries, and they are kept in this currency.';
const newKey = () => `company-${crypto.randomUUID()}`;

function Said({ error }: { error: unknown }) {
  const text = companyRefusal(error);
  if (!text) return <Refusal error={error} />;
  return (
    <p className="refusal" role="alert">
      {text}
    </p>
  );
}

function Years({ c }: { c: CompanySettings }) {
  if (c.fiscal_years.length === 0)
    return (
      <p className="admin-note">
        No financial year yet. Add the first one: most Australian companies start theirs on 1 July.
      </p>
    );
  return (
    <table className="admin-table" aria-label="Financial years">
      <thead>
        <tr>
          <th scope="col">Year</th>
          <th scope="col">From</th>
          <th scope="col">To</th>
        </tr>
      </thead>
      <tbody>
        {c.fiscal_years.map((y) => (
          <tr key={y.label}>
            <td data-label="Year">{y.label}</td>
            <td data-label="From">{dayText(y.start_date)}</td>
            <td data-label="To">{dayText(y.end_date)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DetailsForm({ c, companyId }: { c: CompanySettings; companyId: string }) {
  const { env } = useServices();
  const client = useMemo(() => createSettingsClient(env), [env]);
  const queryClient = useQueryClient();
  const [legalName, setLegalName] = useState(c.legal_name ?? '');
  const [abn, setAbn] = useState(c.abn ? abnText(c.abn) : '');
  const [currency, setCurrency] = useState(c.base_currency);
  const [key, setKey] = useState(newKey);
  const [yearKey, setYearKey] = useState(newKey);
  const [month, setMonth] = useState('7');
  const [year, setYear] = useState('');
  const [yearError, setYearError] = useState(false);
  const ids = { name: useId(), abn: useId(), abnHint: useId(), cur: useId(), curHint: useId() };
  const yid = { month: useId(), year: useId(), err: useId() };
  const settingsKey = ['setup', 'company', companyId] as const;

  const save = useMutation({
    mutationFn: () =>
      client.saveCompany(
        companyId,
        { legal_name: legalName, abn, base_currency: currency.trim().toUpperCase() },
        key,
      ),
    onSettled: async () => {
      setKey(newKey());
      await queryClient.invalidateQueries({ queryKey: settingsKey });
    },
  });
  const addYear = useMutation({
    mutationFn: (start: string) => client.addFiscalYear(companyId, start, yearKey),
    onSettled: async () => {
      setYearKey(newKey());
      await queryClient.invalidateQueries({ queryKey: settingsKey });
    },
  });

  return (
    <>
      <section className="admin-block" aria-labelledby={`${ids.name}-h`}>
        <h2 id={`${ids.name}-h`}>Details</h2>
        <form
          className="admin-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <label htmlFor={ids.name}>Legal name</label>
          <input
            id={ids.name}
            value={legalName}
            maxLength={200}
            required
            autoComplete="organization"
            onChange={(e) => setLegalName(e.target.value)}
          />
          <label htmlFor={ids.abn}>ABN</label>
          <input
            id={ids.abn}
            value={abn}
            inputMode="numeric"
            required
            aria-describedby={ids.abnHint}
            onChange={(e) => setAbn(e.target.value)}
          />
          <p className="admin-note" id={ids.abnHint}>
            11 digits, as on the ABN register. Spaces are fine.
          </p>
          <label htmlFor={ids.cur}>Base currency</label>
          <input
            id={ids.cur}
            value={currency}
            maxLength={3}
            required
            disabled={c.base_currency_locked}
            aria-describedby={ids.curHint}
            onChange={(e) => setCurrency(e.target.value)}
          />
          <p className="admin-note" id={ids.curHint}>
            {c.base_currency_locked
              ? LOCKED
              : 'The currency your books are kept in, as a three-letter code such as AUD. It cannot change once anything is posted.'}
          </p>
          <button type="submit" className="primary" disabled={save.isPending}>
            Save company details
          </button>
          {save.isSuccess ? (
            <p className="done" role="status">
              {save.data.changed
                ? 'Company details saved.'
                : 'Nothing changed: these are already the company details.'}
            </p>
          ) : null}
          {save.isError ? <Said error={save.error} /> : null}
        </form>
      </section>
      <section className="admin-block" aria-labelledby={`${yid.month}-h`}>
        <h2 id={`${yid.month}-h`}>Financial years</h2>
        <Years c={c} />
        <form
          className="admin-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const start = fiscalStart(month, year);
            if (!start) {
              setYearError(true);
              return;
            }
            setYearError(false);
            addYear.mutate(start);
          }}
        >
          <p className="admin-note">
            Each year has twelve monthly periods. Years cannot be changed or removed once added.
          </p>
          <label htmlFor={yid.month}>First month</label>
          <select id={yid.month} value={month} onChange={(e) => setMonth(e.target.value)}>
            {MONTH_NAMES.map((m, i) => (
              <option key={m} value={String(i + 1)}>
                {m}
              </option>
            ))}
          </select>
          <label htmlFor={yid.year}>Year it starts</label>
          <input
            id={yid.year}
            value={year}
            inputMode="numeric"
            maxLength={4}
            aria-invalid={yearError}
            aria-describedby={yearError ? yid.err : undefined}
            onChange={(e) => setYear(e.target.value)}
          />
          {yearError ? (
            <p className="refusal" id={yid.err}>
              Choose the first month and write the year as four digits.
            </p>
          ) : null}
          <button type="submit" className="secondary" disabled={addYear.isPending}>
            Add financial year
          </button>
          {addYear.isSuccess ? (
            <p className="done" role="status">
              {addYear.data.replayed
                ? `${addYear.data.label} was already there: ${dayText(addYear.data.start_date)} to ${dayText(addYear.data.end_date)}.`
                : `${addYear.data.label} added: ${dayText(addYear.data.start_date)} to ${dayText(addYear.data.end_date)}, twelve monthly periods.`}
            </p>
          ) : null}
          {addYear.isError ? <Said error={addYear.error} /> : null}
        </form>
      </section>
    </>
  );
}

function ReadOnly({ c }: { c: CompanySettings }) {
  return (
    <>
      <section className="admin-block" aria-labelledby="company-ro-h">
        <h2 id="company-ro-h">Details</h2>
        <dl className="settings-dl">
          <dt>Legal name</dt>
          <dd>{c.legal_name ?? 'Not entered yet'}</dd>
          <dt>ABN</dt>
          <dd>{c.abn ? abnText(c.abn) : 'Not entered yet'}</dd>
          <dt>Base currency</dt>
          <dd>{c.base_currency}</dd>
        </dl>
        <p className="admin-note">Only the Owner or a Finance Admin can change company details.</p>
      </section>
      <section className="admin-block" aria-labelledby="company-ro-y">
        <h2 id="company-ro-y">Financial years</h2>
        <Years c={c} />
      </section>
    </>
  );
}

export function CompanySettingsPage() {
  const access = useAccess();
  const { env } = useServices();
  const client = useMemo(() => createSettingsClient(env), [env]);
  const canRead = access.can('settings.read');
  const canManage = access.can('settings.setup.manage');
  const company = useCompany();
  const companyId = company.company?.id ?? '';
  const settings = useQuery({
    queryKey: ['setup', 'company', companyId],
    queryFn: () => client.company(companyId),
    enabled: canRead && !!companyId,
  });
  useFailureRouting(settings.error ?? company.error);

  let body;
  if (access.isPending || (canRead && (company.isPending || (!!companyId && settings.isPending))))
    body = <Loading what="the company details" />;
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
      <Forbidden heading="You can't see the company details">
        You do not have access to the company settings. The Owner, Finance Admin and Accountant can
        see them; ask your Owner if you need to.
      </Forbidden>
    );
  else if (company.isError || settings.isError || !settings.data)
    body = (
      <Failure
        heading="We could not load the company details"
        error={settings.error ?? company.error}
        onRetry={() => void (settings.isError ? settings.refetch() : company.refetch())}
      />
    );
  else if (canManage)
    body = <DetailsForm key={companyId} c={settings.data} companyId={companyId} />;
  else body = <ReadOnly c={settings.data} />;

  return (
    <>
      <PageHead title={TITLE} gloss={GLOSS} />
      <p className="admin-note">
        <Link to="/settings/setup">Back to Set up your company</Link>
      </p>
      {body}
    </>
  );
}
