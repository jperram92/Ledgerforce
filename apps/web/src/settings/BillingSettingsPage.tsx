/**
 * Numbering and billing: setup wizard step 8 (T-0186, SS-PLAT-131, design §3.4, §4.1, §4.3,
 * ADR-0085, RQ-0167). The invoice and credit-note number series, the billing formats, the brand
 * colour, default payment terms and accepted payment methods, and the Stripe clearing account when
 * Stripe is accepted. Someone with settings.setup.manage changes them; others with settings.read
 * see them read-only. The API decides every rule (a series is fixed once it has issued a number,
 * which accounts may be the clearing account); this screen says what it answers. The remittance
 * account, also part of step 8, has its own screen (T-0183).
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
  CREDIT_NOTE_SERIES,
  INVOICE_SERIES,
  type BillingSettings,
  type PaymentMethod,
} from './client.ts';
import { billingRefusal, digitsInput, firstNumber, termsInput } from './billing-logic.ts';

const TITLE = 'Numbering and billing';
const GLOSS =
  'How invoices and credit notes are numbered, the billing formats, how invoices look and how customers can pay. Setup step 8.';
const newKey = () => `billing-${crypto.randomUUID()}`;

const SERIES = [
  { code: INVOICE_SERIES, what: 'Invoice', plural: 'invoices', prefix: 'INV-' },
  { code: CREDIT_NOTE_SERIES, what: 'Credit note', plural: 'credit notes', prefix: 'CN-' },
] as const;
const METHODS: { value: PaymentMethod; name: string; gloss: string }[] = [
  {
    value: 'bank_transfer',
    name: 'Bank transfer',
    gloss: 'Your BSB and account number are printed on the invoice.',
  },
  {
    value: 'stripe',
    name: 'Card through Stripe',
    gloss: 'The invoice carries a link to pay by card; the payment arrives in Stripe clearing.',
  },
];
const METHOD_WORD: Record<PaymentMethod, string> = {
  bank_transfer: 'bank transfer',
  stripe: 'card through Stripe',
};

function Said({ error }: { error: unknown }) {
  const text = billingRefusal(error);
  if (!text) return <Refusal error={error} />;
  return (
    <p className="refusal" role="alert">
      {text}
    </p>
  );
}

type Series = (typeof SERIES)[number];

function seriesNow(b: BillingSettings, s: Series): string {
  const row = b.series.find((x) => x.code === s.code);
  if (!row) return `Not set up yet: ${s.plural} cannot be numbered.`;
  return row.issued
    ? `The next ${s.what.toLowerCase()} will be ${row.next_number}. The prefix and number of digits are fixed now that numbers have been given.`
    : `The first ${s.what.toLowerCase()} will be ${row.next_number}.`;
}

function SeriesForm({ b, s, companyId }: { b: BillingSettings; s: Series; companyId: string }) {
  const { env } = useServices();
  const client = useMemo(() => createSettingsClient(env), [env]);
  const queryClient = useQueryClient();
  const row = b.series.find((x) => x.code === s.code);
  const [prefix, setPrefix] = useState(row?.prefix ?? s.prefix);
  const [digits, setDigits] = useState(String(row?.pad_width ?? 6));
  const [wrong, setWrong] = useState(false);
  const [key, setKey] = useState(newKey);
  const ids = { p: useId(), d: useId(), now: useId(), err: useId() };
  const save = useMutation({
    mutationFn: (pad: number) =>
      client.saveSeries(companyId, { code: s.code, prefix, pad_width: pad }, key),
    onSettled: async () => {
      setKey(newKey());
      await queryClient.invalidateQueries({ queryKey: ['setup', 'billing', companyId] });
    },
  });
  const pad = digitsInput(digits);
  return (
    <form
      className="admin-form"
      noValidate
      aria-label={`${s.what} numbers`}
      onSubmit={(e) => {
        e.preventDefault();
        if (pad === null) {
          setWrong(true);
          return;
        }
        setWrong(false);
        save.mutate(pad);
      }}
    >
      <h3>{s.what} numbers</h3>
      <p className="admin-note" id={ids.now}>
        {seriesNow(b, s)}
      </p>
      {row?.issued ? null : (
        <>
          <label htmlFor={ids.p}>{s.what} number prefix</label>
          <input
            id={ids.p}
            value={prefix}
            maxLength={20}
            onChange={(e) => setPrefix(e.target.value)}
          />
          <label htmlFor={ids.d}>{s.what} number digits</label>
          <input
            id={ids.d}
            value={digits}
            inputMode="numeric"
            maxLength={2}
            aria-invalid={wrong}
            aria-describedby={wrong ? ids.err : undefined}
            onChange={(e) => setDigits(e.target.value)}
          />
          {wrong ? (
            <p className="refusal" id={ids.err}>
              Write the number of digits as a whole number from 1 to 18.
            </p>
          ) : pad !== null ? (
            <p className="admin-note">Numbers will look like {firstNumber(prefix, pad)}.</p>
          ) : null}
          <button type="submit" className="secondary" disabled={save.isPending}>
            Save {s.what.toLowerCase()} numbering
          </button>
        </>
      )}
      {save.isSuccess ? (
        <p className="done" role="status">
          {save.data.changed
            ? `${s.what} numbering saved: the next is ${save.data.series.next_number}.`
            : `Nothing changed: ${s.plural} are already numbered this way.`}
        </p>
      ) : null}
      {save.isError ? <Said error={save.error} /> : null}
    </form>
  );
}

function Formats({ b }: { b: BillingSettings }) {
  if (b.formats.length === 0)
    return (
      <p className="admin-note">
        No billing formats yet. The standard formats cover a standard invoice, batch billing, credit
        notes and pro-forma quotes.
      </p>
    );
  return (
    <div className="settings-scroll">
      <table className="admin-table" aria-label="Billing formats">
        <thead>
          <tr>
            <th scope="col">Code</th>
            <th scope="col">Name</th>
            <th scope="col">Posted to the books</th>
          </tr>
        </thead>
        <tbody>
          {b.formats.map((f) => (
            <tr key={f.code}>
              <td data-label="Code">{f.code}</td>
              <td data-label="Name">
                {f.name}
                {f.status === 'active' ? null : ' (not in use)'}
              </td>
              <td data-label="Posted to the books">{f.posted ? 'Yes' : 'No (a quote)'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InvoiceNow({ b }: { b: BillingSettings }) {
  const i = b.invoice;
  return (
    <dl className="settings-dl">
      <dt>Brand colour</dt>
      <dd>{i.brand_colour ?? 'Not set yet'}</dd>
      <dt>Payment terms</dt>
      <dd>
        {i.default_payment_terms_days === null
          ? 'Not set yet'
          : `${String(i.default_payment_terms_days)} days after the invoice date`}
      </dd>
      <dt>Customers can pay by</dt>
      <dd>
        {i.accepted_payment_methods?.length
          ? i.accepted_payment_methods.map((m) => METHOD_WORD[m]).join(' or ')
          : 'Not chosen yet'}
      </dd>
    </dl>
  );
}

function clearingName(b: BillingSettings): string {
  if (!b.stripe) return 'Not set up yet';
  const a = b.clearing_accounts.find((x) => x.id === b.stripe?.clearing_account_id);
  return a ? `${a.code} ${a.name}` : 'An account that is no longer usable: choose another';
}

function InvoiceForm({ b, companyId }: { b: BillingSettings; companyId: string }) {
  const { env } = useServices();
  const client = useMemo(() => createSettingsClient(env), [env]);
  const queryClient = useQueryClient();
  const i = b.invoice;
  const [colour, setColour] = useState(i.brand_colour ?? '');
  const [terms, setTerms] = useState(
    i.default_payment_terms_days === null ? '' : String(i.default_payment_terms_days),
  );
  const [methods, setMethods] = useState<PaymentMethod[]>(i.accepted_payment_methods ?? []);
  const [missing, setMissing] = useState(false);
  const [key, setKey] = useState(newKey);
  const ids = { c: useId(), cHint: useId(), t: useId(), err: useId(), h: useId() };
  const save = useMutation({
    mutationFn: (days: number) =>
      client.saveInvoice(
        companyId,
        {
          brand_colour: colour.trim(),
          default_payment_terms_days: days,
          accepted_payment_methods: methods,
        },
        key,
      ),
    onSettled: async () => {
      setKey(newKey());
      await queryClient.invalidateQueries({ queryKey: ['setup', 'billing', companyId] });
    },
  });
  return (
    <section className="admin-block" aria-labelledby={ids.h}>
      <h2 id={ids.h}>Invoices</h2>
      <form
        className="admin-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const days = termsInput(terms);
          if (days === null || methods.length === 0 || colour.trim() === '') {
            setMissing(true);
            return;
          }
          setMissing(false);
          save.mutate(days);
        }}
      >
        <label htmlFor={ids.c}>Brand colour</label>
        <input
          id={ids.c}
          value={colour}
          maxLength={7}
          placeholder="#0A5C8A"
          aria-describedby={ids.cHint}
          onChange={(e) => setColour(e.target.value)}
        />
        <p className="admin-note" id={ids.cHint}>
          The colour of the invoice heading, as # and six hexadecimal digits, such as #0A5C8A.
        </p>
        <label htmlFor={ids.t}>Payment terms (days)</label>
        <input
          id={ids.t}
          value={terms}
          inputMode="numeric"
          maxLength={3}
          onChange={(e) => setTerms(e.target.value)}
        />
        <fieldset className="settings-choices">
          <legend>Customers can pay by</legend>
          {METHODS.map((m) => (
            <label key={m.value} className="check">
              <input
                type="checkbox"
                checked={methods.includes(m.value)}
                onChange={(e) =>
                  setMethods((now) =>
                    e.target.checked ? [...now, m.value] : now.filter((x) => x !== m.value),
                  )
                }
              />
              <span>
                {m.name}. <span className="admin-note">{m.gloss}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {missing ? (
          <p className="refusal" id={ids.err} role="alert">
            Enter the brand colour, the payment terms as whole days from 0 to 365, and at least one
            way customers can pay.
          </p>
        ) : null}
        <button type="submit" className="primary" disabled={save.isPending}>
          Save invoice settings
        </button>
        {save.isSuccess ? (
          <p className="done" role="status">
            {save.data.changed
              ? 'Invoice settings saved.'
              : 'Nothing changed: these are already the invoice settings.'}
          </p>
        ) : null}
        {save.isError ? <Said error={save.error} /> : null}
      </form>
    </section>
  );
}

function StripeForm({ b, companyId }: { b: BillingSettings; companyId: string }) {
  const { env } = useServices();
  const client = useMemo(() => createSettingsClient(env), [env]);
  const queryClient = useQueryClient();
  const [account, setAccount] = useState(b.stripe?.clearing_account_id ?? '');
  const [key, setKey] = useState(newKey);
  const ids = { a: useId(), h: useId() };
  const save = useMutation({
    mutationFn: () => client.saveStripe(companyId, account, key),
    onSettled: async () => {
      setKey(newKey());
      await queryClient.invalidateQueries({ queryKey: ['setup', 'billing', companyId] });
    },
  });
  return (
    <section className="admin-block" aria-labelledby={ids.h}>
      <h2 id={ids.h}>Stripe</h2>
      <p className="admin-note">Stripe clearing account: {clearingName(b)}.</p>
      {b.invoice.accepted_payment_methods?.includes('stripe') ? (
        b.clearing_accounts.length === 0 ? (
          <p className="admin-note">
            No account can be the Stripe clearing account yet: add an asset account that takes
            postings on the <Link to="/accounting/chart">Chart of accounts</Link>.
          </p>
        ) : (
          <form
            className="admin-form"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (account) save.mutate();
            }}
          >
            <p className="admin-note">
              Card payments are recorded in this account when Stripe confirms them, and leave it
              when Stripe pays out to your bank.
            </p>
            <label htmlFor={ids.a}>Stripe clearing account</label>
            <select id={ids.a} value={account} onChange={(e) => setAccount(e.target.value)}>
              <option value="">Choose an account</option>
              {b.clearing_accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} {a.name}
                </option>
              ))}
            </select>
            <button type="submit" className="secondary" disabled={save.isPending || !account}>
              Save Stripe clearing account
            </button>
            {save.isSuccess ? (
              <p className="done" role="status">
                {save.data.changed
                  ? 'Stripe clearing account saved.'
                  : 'Nothing changed: this is already the Stripe clearing account.'}
              </p>
            ) : null}
            {save.isError ? <Said error={save.error} /> : null}
          </form>
        )
      ) : (
        <p className="admin-note">
          Only needed when customers can pay by card through Stripe: choose that under Invoices
          first.
        </p>
      )}
    </section>
  );
}

function Manage({ b, companyId }: { b: BillingSettings; companyId: string }) {
  const { env } = useServices();
  const client = useMemo(() => createSettingsClient(env), [env]);
  const queryClient = useQueryClient();
  const [formatsKey, setFormatsKey] = useState(newKey);
  const ids = { n: useId(), f: useId() };
  const seed = useMutation({
    mutationFn: () => client.addStandardFormats(companyId, formatsKey),
    onSettled: async () => {
      setFormatsKey(newKey());
      await queryClient.invalidateQueries({ queryKey: ['setup', 'billing', companyId] });
    },
  });
  return (
    <>
      <section className="admin-block" aria-labelledby={ids.n}>
        <h2 id={ids.n}>Document numbers</h2>
        <p className="admin-note">
          Numbers run on without gaps. A prefix and number of digits can change only until the first
          number is given.
        </p>
        {SERIES.map((s) => (
          <SeriesForm key={s.code} b={b} s={s} companyId={companyId} />
        ))}
      </section>
      <section className="admin-block" aria-labelledby={ids.f}>
        <h2 id={ids.f}>Billing formats</h2>
        <Formats b={b} />
        <div className="admin-form">
          <button
            type="button"
            className="secondary"
            disabled={seed.isPending}
            onClick={() => seed.mutate()}
          >
            Add the standard billing formats
          </button>
          {seed.isSuccess ? (
            <p className="done" role="status">
              {seed.data.inserted > 0
                ? `${String(seed.data.inserted)} billing formats added.`
                : 'The company already has all the standard billing formats.'}
            </p>
          ) : null}
          {seed.isError ? <Refusal error={seed.error} /> : null}
        </div>
      </section>
      <InvoiceForm b={b} companyId={companyId} />
      <StripeForm b={b} companyId={companyId} />
    </>
  );
}

function ReadOnly({ b }: { b: BillingSettings }) {
  return (
    <>
      <section className="admin-block" aria-labelledby="billing-ro-n">
        <h2 id="billing-ro-n">Document numbers</h2>
        {SERIES.map((s) => (
          <p key={s.code} className="admin-note">
            {s.what} numbers: {seriesNow(b, s)}
          </p>
        ))}
      </section>
      <section className="admin-block" aria-labelledby="billing-ro-f">
        <h2 id="billing-ro-f">Billing formats</h2>
        <Formats b={b} />
      </section>
      <section className="admin-block" aria-labelledby="billing-ro-i">
        <h2 id="billing-ro-i">Invoices</h2>
        <InvoiceNow b={b} />
        <p className="admin-note">Stripe clearing account: {clearingName(b)}.</p>
        <p className="admin-note">
          Only the Owner or a Finance Admin can change numbering and billing.
        </p>
      </section>
    </>
  );
}

export function BillingSettingsPage() {
  const access = useAccess();
  const { env } = useServices();
  const client = useMemo(() => createSettingsClient(env), [env]);
  const canRead = access.can('settings.read');
  const canManage = access.can('settings.setup.manage');
  const company = useCompany();
  const companyId = company.company?.id ?? '';
  const billing = useQuery({
    queryKey: ['setup', 'billing', companyId],
    queryFn: () => client.billing(companyId),
    enabled: canRead && !!companyId,
  });
  useFailureRouting(billing.error ?? company.error);

  let body;
  if (access.isPending || (canRead && (company.isPending || (!!companyId && billing.isPending))))
    body = <Loading what="the numbering and billing settings" />;
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
      <Forbidden heading="You can't see the numbering and billing settings">
        You do not have access to the company settings. The Owner, Finance Admin and Accountant can
        see them; ask your Owner if you need to.
      </Forbidden>
    );
  else if (company.isError || billing.isError || !billing.data)
    body = (
      <Failure
        heading="We could not load the numbering and billing settings"
        error={billing.error ?? company.error}
        onRetry={() => void (billing.isError ? billing.refetch() : company.refetch())}
      />
    );
  else if (canManage) body = <Manage key={companyId} b={billing.data} companyId={companyId} />;
  else body = <ReadOnly b={billing.data} />;

  return (
    <>
      <PageHead title={TITLE} gloss={GLOSS} />
      <p className="admin-note">
        <Link to="/settings/setup">Back to Set up your company</Link>
      </p>
      <p className="admin-note">
        The bank account printed on invoices for bank transfer is chosen on{' '}
        <Link to="/settings/remittance-account">Remittance account</Link>; a second person approves
        every change.
      </p>
      {body}
    </>
  );
}
