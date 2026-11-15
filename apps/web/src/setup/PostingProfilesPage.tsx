/**
 * Posting-profile matrix (T-0188, design §4.4, IA S13, mockup 08, ADR-0082, SS-PLAT-134; setup
 * wizard step 7). It shows which account each customer or supplier type × product type posts to:
 * the product's default, an override, or a gap. Someone with settings.chart.manage fills a gap by
 * choosing an account (or a tax code). The API resolves every cell with the posting rule
 * (T-0187), so this screen, posting and the wizard's gap check cannot disagree. The browser
 * resolves nothing: it shows the cells and sends the chosen override.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState } from 'react';
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
import type { MatrixCell, OverrideBody, ProfileMatrix } from './client.ts';
import { cellWord, fillField, fillRefusal, gapSummary } from './profiles-logic.ts';

const TITLE = 'Posting profiles';
const GLOSS =
  'Which account each kind of customer or supplier posts to for each kind of product. A combination uses the product’s default account unless it has an override. A gap means a document for that combination cannot post until it is filled.';
const newKey = () => `profile-${crypto.randomUUID()}`;

type Party = ProfileMatrix['parties'][number];
type Product = ProfileMatrix['products'][number];
interface Target {
  cell: MatrixCell;
  party: Party;
  product: Product;
}
const nameOf = (t: Pick<Target, 'party' | 'product'>) => `${t.party.name} × ${t.product.name}`;

function Cell({
  c,
  target,
  canManage,
  onFill,
}: {
  c: MatrixCell | undefined;
  target: Omit<Target, 'cell'>;
  canManage: boolean;
  onFill: (t: Target) => void;
}) {
  if (!c) return <td>—</td>;
  const word = cellWord(c);
  return (
    <td>
      <div className="mx-cell" data-state={word.toLowerCase()}>
        <span className="mx-word">{word}</span>
        {c.account ? (
          <span>
            <span className="code">{c.account.code}</span> {c.account.name}
          </span>
        ) : null}
        {c.tax_code ? <span className="mx-tax">{c.tax_code}</span> : null}
        {c.gap ? <span className="mx-gap">{c.gap.message}</span> : null}
        {c.gap && canManage && fillField(c) ? (
          <button
            type="button"
            className="secondary sm"
            aria-label={`Fill the gap: ${nameOf(target)}`}
            onClick={() => onFill({ ...target, cell: c })}
          >
            Fill the gap
          </button>
        ) : null}
      </div>
    </td>
  );
}

function Matrix({
  m,
  kind,
  canManage,
  onFill,
}: {
  m: ProfileMatrix;
  kind: 'customer' | 'supplier';
  canManage: boolean;
  onFill: (t: Target) => void;
}) {
  const hId = useId();
  const parties = m.parties.filter((p) => p.kind === kind);
  if (parties.length === 0) return null;
  const sale = kind === 'customer';
  const title = sale
    ? 'Sales: income account by customer type and product type'
    : 'Purchases: expense account by supplier type and product type';
  const cellOf = (party: Party, product: Product) =>
    m.cells.find((c) => c.party_profile_id === party.id && c.product_profile_id === product.id);
  const productDefault = (p: Product) =>
    sale ? p.revenue_account : (p.expense_account ?? p.cogs_account);
  return (
    <section className="admin-block" aria-labelledby={hId}>
      <h2 id={hId}>{title}</h2>
      <div
        className="mx-wrap"
        role="region"
        tabIndex={0}
        aria-label={`${title} (scrolls sideways)`}
      >
        <table className="mx">
          <caption className="sr-only">{title}</caption>
          <thead>
            <tr>
              <th scope="col">{sale ? 'Customer type' : 'Supplier type'}</th>
              {m.products.map((p) => (
                <th scope="col" key={p.id}>
                  {p.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">
                Product default
                <span className="mx-sec">applies unless overridden</span>
              </th>
              {m.products.map((p) => {
                const a = productDefault(p);
                return (
                  <td key={p.id}>
                    {a ? (
                      <>
                        <span className="code">{a.code}</span> {a.name}
                      </>
                    ) : (
                      'None'
                    )}
                  </td>
                );
              })}
            </tr>
            {parties.map((party) => (
              <tr key={party.id}>
                <th scope="row">
                  {party.name}
                  <span className="mx-sec">
                    {party.control_account
                      ? `${sale ? 'Owed to you on' : 'Owed by you on'} ${party.control_account.code}, `
                      : ''}
                    tax {party.default_tax_code}
                  </span>
                </th>
                {m.products.map((product) => (
                  <Cell
                    key={product.id}
                    c={cellOf(party, product)}
                    target={{ party, product }}
                    canManage={canManage}
                    onFill={onFill}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function FillPanel({
  m,
  target,
  companyId,
  onDone,
  onCancel,
}: {
  m: ProfileMatrix;
  target: Target;
  companyId: string;
  onDone: (text: string) => void;
  onCancel: () => void;
}) {
  const { setup } = useServices();
  const queryClient = useQueryClient();
  const field = fillField(target.cell);
  const [value, setValue] = useState('');
  const [missing, setMissing] = useState(false);
  const [key, setKey] = useState(newKey);
  const ids = { h: useId(), input: useId(), err: useId() };
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  const sale = target.cell.purpose === 'sale';
  const choices = m.choices.filter((a) => a.type === (sale ? 'revenue' : 'expense'));
  const save = useMutation({
    mutationFn: (body: OverrideBody) => setup.setOverride(body, key),
    onSuccess: async () => {
      setKey(newKey());
      await queryClient.invalidateQueries({ queryKey: ['setup'] });
      const a = choices.find((x) => x.id === value);
      onDone(
        field === 'tax_code'
          ? `${nameOf(target)} now uses tax code ${value}.`
          : `${nameOf(target)} now posts to ${a ? `${a.code} ${a.name}` : 'the chosen account'}.`,
      );
    },
  });
  useFailureRouting(save.error);
  if (!field) return null;
  const label = field === 'tax_code' ? 'Tax code' : sale ? 'Income account' : 'Expense account';
  const submit = () => {
    if (value.trim() === '') {
      setMissing(true);
      return;
    }
    setMissing(false);
    save.mutate({
      company_id: companyId,
      party_profile_id: target.party.id,
      product_profile_id: target.product.id,
      [field]: value.trim(),
    });
  };
  const refusal = save.isError ? fillRefusal(save.error) : null;
  return (
    <section className="admin-block mx-fill" aria-labelledby={ids.h}>
      <h2 id={ids.h} ref={heading} tabIndex={-1}>
        Fill the gap: {nameOf(target)}
      </h2>
      <p>{target.cell.gap?.message}</p>
      <form
        className="admin-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label htmlFor={ids.input}>{label}</label>
        {field === 'tax_code' ? (
          <input
            id={ids.input}
            value={value}
            aria-invalid={missing}
            aria-describedby={missing ? ids.err : undefined}
            onChange={(e) => {
              setValue(e.target.value);
              setKey(newKey());
            }}
          />
        ) : (
          <select
            id={ids.input}
            value={value}
            aria-invalid={missing}
            aria-describedby={missing ? ids.err : undefined}
            onChange={(e) => {
              setValue(e.target.value);
              setKey(newKey());
              save.reset();
            }}
          >
            <option value="">Choose an account</option>
            {choices.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} {a.name}
              </option>
            ))}
          </select>
        )}
        {missing ? (
          <p className="refusal" id={ids.err}>
            {field === 'tax_code' ? 'Write the tax code first.' : 'Choose an account first.'}
          </p>
        ) : null}
        <p className="admin-note">
          Only this combination changes. Other customers and products keep their accounts.
        </p>
        <div className="wizard-actions">
          <button type="submit" className="primary" disabled={save.isPending}>
            {field === 'tax_code' ? 'Use this tax code' : 'Use this account'}
          </button>
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
        {save.isError ? (
          refusal ? (
            <p className="refusal" role="alert">
              {refusal}
            </p>
          ) : (
            <Refusal error={save.error} />
          )
        ) : null}
      </form>
    </section>
  );
}

export function PostingProfilesPage() {
  const access = useAccess();
  const { setup } = useServices();
  const canRead = access.can('settings.read');
  const canManage = access.can('settings.chart.manage');
  const company = useCompany();
  const companyId = company.company?.id ?? '';
  const [target, setTarget] = useState<Target | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const matrix = useQuery({
    queryKey: ['setup', 'posting-profiles', companyId],
    queryFn: () => setup.matrix(companyId),
    enabled: canRead && !!companyId,
  });
  useFailureRouting(matrix.error ?? company.error);

  if (access.isPending || (canRead && (company.isPending || (!!companyId && matrix.isPending))))
    return <Loading what="the posting profiles" />;
  if (access.isError)
    return (
      <Failure
        heading="We could not check what you may do"
        error={access.error}
        onRetry={() => void access.refetch()}
      />
    );
  if (!canRead)
    return (
      <>
        <PageHead title={TITLE} gloss={GLOSS} />
        <Forbidden heading="You can't see the posting profiles">
          You do not have access to the posting profiles. The Owner, Finance Admin, Accountant and
          Auditor can see them; ask your Owner if you need to.
        </Forbidden>
      </>
    );
  if (company.isError || matrix.isError || !matrix.data)
    return (
      <Failure
        heading="We could not load the posting profiles"
        error={matrix.error ?? company.error}
        onRetry={() => void (matrix.isError ? matrix.refetch() : company.refetch())}
      />
    );

  const m = matrix.data;
  const gaps = m.cells.filter((c) => c.gap).length;
  return (
    <>
      <PageHead title={TITLE} gloss={GLOSS} />
      <p className="admin-note wizard-sum">{gapSummary(gaps)}</p>
      <p className="admin-note" role="status">
        {done ?? ''}
      </p>
      {m.parties.length === 0 || m.products.length === 0 ? (
        <p className="admin-note">
          There are no posting profiles yet. They come with the chart of accounts template.
        </p>
      ) : null}
      {!canManage ? <p className="admin-note">The Owner or a Finance Admin fills gaps.</p> : null}
      <Matrix
        m={m}
        kind="customer"
        canManage={canManage}
        onFill={(t) => {
          setDone(null);
          setTarget(t);
        }}
      />
      <Matrix
        m={m}
        kind="supplier"
        canManage={canManage}
        onFill={(t) => {
          setDone(null);
          setTarget(t);
        }}
      />
      {target && canManage ? (
        <FillPanel
          key={`${target.party.id}:${target.product.id}`}
          m={m}
          target={target}
          companyId={companyId}
          onDone={(text) => {
            setTarget(null);
            setDone(text);
          }}
          onCancel={() => setTarget(null)}
        />
      ) : null}
      <p className="admin-note">
        <Link to="/settings/setup">Back to the setup steps</Link>
      </p>
    </>
  );
}
