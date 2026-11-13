/**
 * Enter a bill (T-0086, UC-05 step 2, SS-UC05-08): the AP Clerk records the supplier's tax invoice
 * and codes each line to an expense or asset account and a tax code, from the choices the API gives
 * (GET /ap/bill-coding: createBill's own rules). Saving PUTs the draft under an id chosen once per
 * form, so a double submit cannot enter it twice. GST and totals are worked out by the API, never
 * here; the bill page shows them.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { AdminApiError } from '../admin/client.ts';
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
import { emptyLine, formToBody, type BillForm } from './bill-logic.ts';
import { useApCompany } from './BillsPage.tsx';
import type { BillCoding } from './client.ts';

export function BillFormPage() {
  const access = useAccess();
  const { purchases } = useServices();
  const canEnter = access.can('ap.bill.enter');
  const company = useApCompany();
  const companyId = company.company?.id ?? '';
  const coding = useQuery({
    queryKey: ['ap', 'bill-coding', companyId],
    queryFn: () => purchases.coding(companyId),
    enabled: canEnter && !!companyId,
  });
  useFailureRouting(coding.error ?? company.error);

  let body;
  if (access.isPending || (canEnter && (company.isPending || coding.isPending)))
    body = <Loading what="the bill form" />;
  else if (access.isError)
    body = (
      <Failure
        heading="We could not check what you may do"
        error={access.error}
        onRetry={() => void access.refetch()}
      />
    );
  else if (!canEnter)
    body = (
      <Forbidden heading="You can't enter bills">
        Entering bills is for AP Clerks and Owners. Approvers approve bills someone else entered, so
        one person never does both.
      </Forbidden>
    );
  else if (company.isError || !companyId)
    body = (
      <Failure
        heading="We could not find your company"
        error={company.error}
        onRetry={() => void company.refetch()}
      />
    );
  else if (coding.isError || !coding.data)
    body = (
      <Failure
        heading="We could not load suppliers and accounts"
        error={coding.error}
        onRetry={() => void coding.refetch()}
      />
    );
  else body = <Editor companyId={companyId} coding={coding.data} />;

  return (
    <>
      <PageHead
        title="Enter a bill"
        gloss="Copy the supplier's tax invoice and say what each line was for. Nothing is posted until an Approver approves it."
      />
      {body}
    </>
  );
}

function Editor({ companyId, coding }: { companyId: string; coding: BillCoding }) {
  const { purchases } = useServices();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [billId] = useState(() => crypto.randomUUID());
  const [form, setForm] = useState<BillForm>(() => ({
    partyId: '',
    supplierRef: '',
    billDate: new Date().toISOString().slice(0, 10),
    dueDate: '',
    lines: [emptyLine()],
  }));
  const [problems, setProblems] = useState<string[]>([]);
  const save = useMutation({
    mutationFn: (b: Parameters<typeof purchases.enter>[1]) => purchases.enter(billId, b),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['ap', 'bills'] });
      await navigate({ to: '/purchases/bills/$billId', params: { billId } });
    },
  });
  useFailureRouting(save.error);
  const setLine = (i: number, k: keyof BillForm['lines'][number], v: string) => {
    setForm({ ...form, lines: form.lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)) });
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const b = formToBody(companyId, form);
    if (!b.ok) {
      setProblems(b.problems);
      return;
    }
    setProblems([]);
    save.mutate(b.body);
  };
  const refused =
    save.error instanceof AdminApiError &&
    save.error.status === 422 &&
    typeof save.error.body['message'] === 'string'
      ? save.error.body['message']
      : null;

  return (
    <section className="admin-block" aria-labelledby="bill-form-h">
      <h2 id="bill-form-h" className="sr-only">
        Bill details
      </h2>
      <form className="admin-form gl-form bill-form" onSubmit={submit} noValidate>
        <label htmlFor="bill-supplier">Supplier</label>
        <select
          id="bill-supplier"
          value={form.partyId}
          onChange={(e) => {
            setForm({ ...form, partyId: e.target.value });
          }}
        >
          <option value="">Choose a supplier</option>
          {coding.suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <label htmlFor="bill-ref">Supplier&apos;s invoice number</label>
        <input
          id="bill-ref"
          maxLength={100}
          autoComplete="off"
          value={form.supplierRef}
          onChange={(e) => {
            setForm({ ...form, supplierRef: e.target.value });
          }}
        />
        <label htmlFor="bill-date">Bill date</label>
        <input
          id="bill-date"
          type="date"
          value={form.billDate}
          onChange={(e) => {
            setForm({ ...form, billDate: e.target.value });
          }}
        />
        <label htmlFor="bill-due">Due date</label>
        <input
          id="bill-due"
          type="date"
          aria-describedby="bill-due-hint"
          value={form.dueDate}
          onChange={(e) => {
            setForm({ ...form, dueDate: e.target.value });
          }}
        />
        <p id="bill-due-hint" className="admin-note">
          Leave it empty for 30 days after the bill date.
        </p>
        <fieldset className="gl-lines">
          <legend>What was bought</legend>
          {form.lines.map((l, i) => {
            const n = String(i + 1);
            return (
              <div className="gl-line" key={i} role="group" aria-label={`Line ${n}`}>
                <div className="gl-field gl-account">
                  <label htmlFor={`bill-desc-${n}`}>Line {n} description</label>
                  <input
                    id={`bill-desc-${n}`}
                    maxLength={500}
                    value={l.description}
                    onChange={(e) => {
                      setLine(i, 'description', e.target.value);
                    }}
                  />
                </div>
                <div className="gl-field gl-memo">
                  <label htmlFor={`bill-acct-${n}`}>Line {n} account</label>
                  <select
                    id={`bill-acct-${n}`}
                    value={l.accountId}
                    onChange={(e) => {
                      setLine(i, 'accountId', e.target.value);
                    }}
                  >
                    <option value="">Choose an account</option>
                    <optgroup label="Expenses: used up now">
                      {coding.accounts
                        .filter((a) => a.type === 'expense')
                        .map((a) => (
                          <option key={a.id} value={a.id}>
                            {`${a.code} ${a.name}`}
                          </option>
                        ))}
                    </optgroup>
                    <optgroup label="Assets: kept and used over time">
                      {coding.accounts
                        .filter((a) => a.type === 'asset')
                        .map((a) => (
                          <option key={a.id} value={a.id}>
                            {`${a.code} ${a.name}`}
                          </option>
                        ))}
                    </optgroup>
                  </select>
                </div>
                <div className="gl-field">
                  <label htmlFor={`bill-tax-${n}`}>Line {n} tax code</label>
                  <select
                    id={`bill-tax-${n}`}
                    value={l.taxCode}
                    onChange={(e) => {
                      setLine(i, 'taxCode', e.target.value);
                    }}
                  >
                    <option value="">Choose</option>
                    {coding.tax_codes.map((t) => (
                      <option key={t.code} value={t.code}>
                        {`${t.code}: ${t.name}`}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="gl-field">
                  <label htmlFor={`bill-amt-${n}`}>Line {n} amount before GST</label>
                  <input
                    id={`bill-amt-${n}`}
                    inputMode="decimal"
                    autoComplete="off"
                    className="num"
                    value={l.amount}
                    onChange={(e) => {
                      setLine(i, 'amount', e.target.value);
                    }}
                  />
                </div>
                {form.lines.length > 1 ? (
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
          Save draft bill
        </button>
      </form>
      {refused ? (
        <p className="refusal" role="alert">
          LedgerForce did not accept this bill: {refused}
        </p>
      ) : (
        <Refusal error={save.error} />
      )}
      <p className="admin-note">
        <Link to="/purchases/bills">Back to bills without saving</Link>
      </p>
    </section>
  );
}
