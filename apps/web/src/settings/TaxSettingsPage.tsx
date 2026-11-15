/**
 * Tax settings: setup wizard step 3 (T-0176, SS-PLAT-129, design §3.6, §4.1, ADR-0081, RQ-0153).
 * How the company accounts for GST (cash or accrual) and how often it lodges the BAS, effective
 * from a month, and the tax codes. Someone with settings.tax.manage changes them; others with
 * settings.read see them read-only. The ATO conditions are shown as guidance only: LedgerForce
 * holds no turnover or ATO direction, so it refuses no lawful choice (RQ-0153).
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
import {
  createSettingsClient,
  type BasFrequency,
  type GstBasis,
  type TaxSettingsView,
} from './client.ts';
import { dayText, percentOf, taxRefusal } from './settings-logic.ts';

const TITLE = 'Tax settings';
const GLOSS =
  'How you account for GST, how often you lodge the BAS, and the GST codes LedgerForce uses. Setup step 3.';
const newKey = () => `tax-${crypto.randomUUID()}`;

const BASES: { value: GstBasis; name: string; gloss: string }[] = [
  {
    value: 'accrual',
    name: 'Accrual basis',
    gloss: 'GST is reported for the period you invoice or are billed. Anyone may use it.',
  },
  {
    value: 'cash',
    name: 'Cash basis',
    gloss:
      'GST is reported for the period you are paid or pay. For small businesses (turnover under $10 million) or with ATO permission.',
  },
];
const FREQUENCIES: { value: BasFrequency; name: string; gloss: string }[] = [
  {
    value: 'monthly',
    name: 'Monthly',
    gloss: 'Required at GST turnover of $20 million or more; anyone may choose it.',
  },
  { value: 'quarterly', name: 'Quarterly', gloss: 'The usual choice below $20 million.' },
  {
    value: 'annual',
    name: 'Annually',
    gloss:
      'Only if registered for GST voluntarily with turnover under $75,000 ($150,000 for not-for-profits).',
  },
];
const BASIS_WORD: Record<GstBasis, string> = { accrual: 'accrual basis', cash: 'cash basis' };
const FREQ_WORD: Record<BasFrequency, string> = {
  monthly: 'monthly BAS',
  quarterly: 'quarterly BAS',
  annual: 'annual GST return',
};

function InForce({ t }: { t: TaxSettingsView }) {
  if (!t.settings) return <p className="admin-note">Not set yet.</p>;
  const s = t.settings;
  return (
    <p className="admin-note">
      In force today: {BASIS_WORD[s.gst_basis]}, {FREQ_WORD[s.bas_frequency]}, from{' '}
      {dayText(s.effective_from)}.
    </p>
  );
}

function Said({ error }: { error: unknown }) {
  const text = taxRefusal(error);
  if (!text) return <Refusal error={error} />;
  return (
    <p className="refusal" role="alert">
      {text}
    </p>
  );
}

function Codes({ t }: { t: TaxSettingsView }) {
  if (t.codes.length === 0)
    return (
      <p className="admin-note">
        No tax codes yet. The standard Australian codes cover GST at 10%, GST-free, input-taxed and
        BAS-excluded amounts.
      </p>
    );
  return (
    <div className="settings-scroll">
      <table className="admin-table" aria-label="Tax codes">
        <thead>
          <tr>
            <th scope="col">Code</th>
            <th scope="col">Name</th>
            <th scope="col">Rate</th>
            <th scope="col">From</th>
            <th scope="col">To</th>
          </tr>
        </thead>
        <tbody>
          {t.codes.map((c) => (
            <tr key={`${c.code}@${c.effective_from}`}>
              <td data-label="Code">{c.code}</td>
              <td data-label="Name">
                {c.name}
                {c.status === 'active' ? null : ' (not in use)'}
              </td>
              <td data-label="Rate">{percentOf(c.rate)}</td>
              <td data-label="From">{dayText(c.effective_from)}</td>
              <td data-label="To">{c.effective_to ? dayText(c.effective_to) : 'No end'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TaxForm({ t, companyId }: { t: TaxSettingsView; companyId: string }) {
  const { env } = useServices();
  const client = useMemo(() => createSettingsClient(env), [env]);
  const queryClient = useQueryClient();
  const [basis, setBasis] = useState<GstBasis | ''>(t.settings?.gst_basis ?? '');
  const [freq, setFreq] = useState<BasFrequency | ''>(t.settings?.bas_frequency ?? '');
  const [from, setFrom] = useState(t.settings?.effective_from.slice(0, 7) ?? '');
  const [missing, setMissing] = useState(false);
  const [key, setKey] = useState(newKey);
  const [codesKey, setCodesKey] = useState(newKey);
  const ids = { from: useId(), err: useId(), h: useId(), c: useId() };
  const taxKey = ['setup', 'tax', companyId] as const;

  const save = useMutation({
    mutationFn: (v: { gst_basis: GstBasis; bas_frequency: BasFrequency; effective_from: string }) =>
      client.saveTax(companyId, v, key),
    onSettled: async () => {
      setKey(newKey());
      await queryClient.invalidateQueries({ queryKey: taxKey });
    },
  });
  const seed = useMutation({
    mutationFn: () => client.addStandardTaxCodes(companyId, codesKey),
    onSettled: async () => {
      setCodesKey(newKey());
      await queryClient.invalidateQueries({ queryKey: taxKey });
    },
  });

  return (
    <>
      <section className="admin-block" aria-labelledby={ids.h}>
        <h2 id={ids.h}>GST and BAS</h2>
        <InForce t={t} />
        <form
          className="admin-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (basis === '' || freq === '' || !/^\d{4}-\d{2}$/.test(from)) {
              setMissing(true);
              return;
            }
            setMissing(false);
            save.mutate({ gst_basis: basis, bas_frequency: freq, effective_from: `${from}-01` });
          }}
        >
          <fieldset className="settings-choices">
            <legend>How you account for GST</legend>
            {BASES.map((b) => (
              <label key={b.value} className="check">
                <input
                  type="radio"
                  name="gst_basis"
                  value={b.value}
                  checked={basis === b.value}
                  onChange={() => setBasis(b.value)}
                />
                <span>
                  {b.name}. <span className="admin-note">{b.gloss}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <fieldset className="settings-choices">
            <legend>How often you lodge the BAS</legend>
            {FREQUENCIES.map((f) => (
              <label key={f.value} className="check">
                <input
                  type="radio"
                  name="bas_frequency"
                  value={f.value}
                  checked={freq === f.value}
                  onChange={() => setFreq(f.value)}
                />
                <span>
                  {f.name}. <span className="admin-note">{f.gloss}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <label htmlFor={ids.from}>Applies from</label>
          <input
            id={ids.from}
            type="month"
            value={from}
            aria-invalid={missing}
            aria-describedby={missing ? ids.err : undefined}
            onChange={(e) => setFrom(e.target.value)}
          />
          {missing ? (
            <p className="refusal" id={ids.err}>
              Choose how you account for GST, how often you lodge the BAS and the month they apply
              from.
            </p>
          ) : null}
          <p className="admin-note">
            A change applies from the first day of that month; earlier months keep their settings.
          </p>
          <button type="submit" className="primary" disabled={save.isPending}>
            Save tax settings
          </button>
          {save.isSuccess ? (
            <p className="done" role="status">
              {save.data.changed
                ? 'Tax settings saved.'
                : 'Nothing changed: these settings were already saved for that month.'}
            </p>
          ) : null}
          {save.isError ? <Said error={save.error} /> : null}
        </form>
      </section>
      <section className="admin-block" aria-labelledby={ids.c}>
        <h2 id={ids.c}>Tax codes</h2>
        <Codes t={t} />
        <div className="admin-form">
          <button
            type="button"
            className="secondary"
            disabled={seed.isPending}
            onClick={() => seed.mutate()}
          >
            Add the standard Australian tax codes
          </button>
          {seed.isSuccess ? (
            <p className="done" role="status">
              {seed.data.inserted > 0
                ? `${String(seed.data.inserted)} tax codes added.`
                : 'The company already has all the standard tax codes.'}
            </p>
          ) : null}
          {seed.isError ? <Refusal error={seed.error} /> : null}
        </div>
      </section>
    </>
  );
}

function ReadOnly({ t }: { t: TaxSettingsView }) {
  return (
    <>
      <section className="admin-block" aria-labelledby="tax-ro-h">
        <h2 id="tax-ro-h">GST and BAS</h2>
        <InForce t={t} />
        <p className="admin-note">Only the Owner or a Finance Admin can change tax settings.</p>
      </section>
      <section className="admin-block" aria-labelledby="tax-ro-c">
        <h2 id="tax-ro-c">Tax codes</h2>
        <Codes t={t} />
      </section>
    </>
  );
}

export function TaxSettingsPage() {
  const access = useAccess();
  const { env } = useServices();
  const client = useMemo(() => createSettingsClient(env), [env]);
  const canRead = access.can('settings.read');
  const canManage = access.can('settings.tax.manage');
  const company = useCompany();
  const companyId = company.company?.id ?? '';
  const tax = useQuery({
    queryKey: ['setup', 'tax', companyId],
    queryFn: () => client.tax(companyId),
    enabled: canRead && !!companyId,
  });
  useFailureRouting(tax.error ?? company.error);

  let body;
  if (access.isPending || (canRead && (company.isPending || (!!companyId && tax.isPending))))
    body = <Loading what="the tax settings" />;
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
      <Forbidden heading="You can't see the tax settings">
        You do not have access to the company settings. The Owner, Finance Admin and Accountant can
        see them; ask your Owner if you need to.
      </Forbidden>
    );
  else if (company.isError || tax.isError || !tax.data)
    body = (
      <Failure
        heading="We could not load the tax settings"
        error={tax.error ?? company.error}
        onRetry={() => void (tax.isError ? tax.refetch() : company.refetch())}
      />
    );
  else if (canManage) body = <TaxForm key={companyId} t={tax.data} companyId={companyId} />;
  else body = <ReadOnly t={tax.data} />;

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
