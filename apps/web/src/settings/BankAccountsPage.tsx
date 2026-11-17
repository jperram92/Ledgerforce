/**
 * Bank accounts: setup wizard step 4 (T-0185, SS-PLAT-130, design §4.1, §6.6, ADR-0084). The
 * company's bank accounts with numbers masked to the last 3 digits, and a form to add one with the
 * APCA user id and ABA user name batch payment files need. Someone with settings.setup.manage
 * adds (the API asks for a fresh sign-in first); others with settings.read see the list only.
 * The API seals the number, checks the GL account and answers a repeat with the same account;
 * this screen only says so. The typed number lives in the form's state only: it is cleared after
 * adding and never put in browser storage (DL-0703).
 * T-0193 (SS-PLAT-153, ADR-0094): the same people can set the APCA user id, ABA user name and
 * bank mnemonic of an active account, or archive it after a confirmation that says what archiving
 * does (including releasing the remittance account printed on invoices, ADR-0086). Both ask for
 * a fresh sign-in first. The BSB and number never change: a different account is added anew.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
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
import { isStepUp, StepUpPrompt, useMutationFailureRouting } from '../purchases/StepUpPrompt.tsx';
import { useCompany } from '../sales/InvoicesPage.tsx';
import {
  createSettingsClient,
  type BankAccount,
  type BankAccountAba,
  type BankAccountInput,
  type BankAccountsView,
} from './client.ts';
import { bankCurrencyFor, bankNumberText, bankRefusal } from './settings-logic.ts';

const TITLE = 'Bank accounts';
const GLOSS =
  'Your bank accounts, and the details your bank needs for batch payment files (ABA). Setup step 4.';
const STEP_UP_WHY =
  'Adding a bank account changes your company’s bank details, so LedgerForce asks you to confirm your sign-in first. For safety the account number is not kept while you are away: type the account number again when you are back.';
const NO_KMS =
  'LedgerForce cannot store bank account numbers yet: the key service that encrypts them is not set up. Ask whoever runs your LedgerForce.';
const CHANGE_STEP_UP_WHY =
  'Changing or archiving a bank account changes your company’s bank details, so LedgerForce asks you to confirm your sign-in first.';
const newKey = () => `bank-account-${crypto.randomUUID()}`;

function Said({ error }: { error: unknown }) {
  const text = bankRefusal(error);
  if (!text) return <Refusal error={error} />;
  return (
    <p className="refusal" role="alert">
      {text}
    </p>
  );
}

function Accounts({ v }: { v: BankAccountsView }) {
  if (v.accounts.length === 0)
    return (
      <p className="admin-note">
        No bank account yet. Add the account your business banks with; batch payments also need its
        APCA user id and ABA user name.
      </p>
    );
  return (
    <table className="admin-table" aria-label="Bank accounts">
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">GL account</th>
          <th scope="col">BSB</th>
          <th scope="col">Account number</th>
          <th scope="col">Account name</th>
          <th scope="col">APCA user id</th>
          <th scope="col">ABA user name</th>
          <th scope="col">Status</th>
        </tr>
      </thead>
      <tbody>
        {v.accounts.map((a) => (
          <tr key={a.id}>
            <td data-label="Name">{a.name}</td>
            <td data-label="GL account">
              {a.gl_account_code ? `${a.gl_account_code} ${a.gl_account_name ?? ''}` : '—'}
            </td>
            <td data-label="BSB">{a.bsb}</td>
            <td data-label="Account number">{bankNumberText(a.account_number)}</td>
            <td data-label="Account name">{a.account_name}</td>
            <td data-label="APCA user id">{a.apca_user_id ?? 'Not entered'}</td>
            <td data-label="ABA user name">{a.aba_user_name ?? 'Not entered'}</td>
            <td data-label="Status">{a.status === 'active' ? 'Active' : 'Archived'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const EMPTY = {
  gl: '',
  name: '',
  bsb: '',
  number: '',
  accountName: '',
  apca: '',
  abaName: '',
  mnemonic: '',
};

function AddForm({ v, companyId }: { v: BankAccountsView; companyId: string }) {
  const { env } = useServices();
  const client = useMemo(() => createSettingsClient(env), [env]);
  const queryClient = useQueryClient();
  const [form, setForm] = useState(EMPTY);
  const [currency, setCurrency] = useState(v.base_currency);
  const [key, setKey] = useState(newKey);
  const [incomplete, setIncomplete] = useState(false);
  const [prompting, setPrompting] = useState(false);
  const base = useId();
  const fid = (n: string) => `${base}-${n}`;
  const set = (k: keyof typeof EMPTY) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const add = useMutation({
    mutationFn: (input: BankAccountInput) => client.addBankAccount(companyId, input, key),
    onSuccess: () => {
      setForm(EMPTY);
      setCurrency(v.base_currency);
    },
    onError: (e) => setPrompting(isStepUp(e)),
    onSettled: async () => {
      setKey(newKey());
      await queryClient.invalidateQueries({ queryKey: ['setup', 'bank-accounts', companyId] });
    },
  });
  useMutationFailureRouting(add.error);

  if (prompting && isStepUp(add.error))
    return (
      <StepUpPrompt
        error={add.error}
        why={STEP_UP_WHY}
        onCancel={() => {
          setPrompting(false);
          add.reset();
        }}
      />
    );

  const free = v.gl_accounts.filter((g) => !g.in_use);
  return (
    <form
      className="admin-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const required = [form.gl, form.name, form.bsb, form.number, form.accountName];
        if (required.some((x) => x.trim() === '')) {
          setIncomplete(true);
          return;
        }
        setIncomplete(false);
        const input: BankAccountInput = {
          gl_account_id: form.gl,
          name: form.name,
          bsb: form.bsb,
          account_number: form.number,
          account_name: form.accountName,
          currency: currency.trim().toUpperCase(),
        };
        if (form.apca.trim()) input.apca_user_id = form.apca.trim();
        if (form.abaName.trim()) input.aba_user_name = form.abaName.trim();
        if (form.mnemonic.trim()) input.aba_fi_mnemonic = form.mnemonic.trim().toUpperCase();
        add.mutate(input);
      }}
    >
      {free.length === 0 ? (
        <p className="admin-note">
          Every bank GL account already has a bank account. Add an asset account of subtype bank on{' '}
          <Link to="/accounting/chart">Chart of accounts</Link> first.
        </p>
      ) : null}
      <label htmlFor={fid('gl')}>GL account</label>
      <select
        id={fid('gl')}
        value={form.gl}
        aria-describedby={fid('gl-hint')}
        onChange={(e) => {
          const gl = v.gl_accounts.find((g) => g.id === e.target.value);
          setForm((f) => ({ ...f, gl: e.target.value }));
          setCurrency(bankCurrencyFor(gl, v.base_currency));
        }}
      >
        <option value="">Choose a GL account</option>
        {v.gl_accounts.map((g) => (
          <option key={g.id} value={g.id} disabled={g.in_use}>
            {g.in_use ? `${g.code} ${g.name} (has a bank account)` : `${g.code} ${g.name}`}
          </option>
        ))}
      </select>
      <p className="admin-note" id={fid('gl-hint')}>
        The account in your chart this bank account posts to. Each can have one bank account.
      </p>
      <label htmlFor={fid('name')}>Name</label>
      <input
        id={fid('name')}
        value={form.name}
        maxLength={100}
        aria-describedby={fid('name-hint')}
        onChange={set('name')}
      />
      <p className="admin-note" id={fid('name-hint')}>
        What you call it, for example Operating.
      </p>
      <label htmlFor={fid('bsb')}>BSB</label>
      <input
        id={fid('bsb')}
        value={form.bsb}
        inputMode="numeric"
        autoComplete="off"
        aria-describedby={fid('bsb-hint')}
        onChange={set('bsb')}
      />
      <p className="admin-note" id={fid('bsb-hint')}>
        6 digits, for example 062-000.
      </p>
      <label htmlFor={fid('number')}>Account number</label>
      <input
        id={fid('number')}
        value={form.number}
        maxLength={20}
        autoComplete="off"
        spellCheck={false}
        aria-describedby={fid('number-hint')}
        onChange={set('number')}
      />
      <p className="admin-note" id={fid('number-hint')}>
        Up to 9 digits. It is stored encrypted; afterwards only its last 3 digits are shown.
      </p>
      <label htmlFor={fid('account-name')}>Account name</label>
      <input
        id={fid('account-name')}
        value={form.accountName}
        aria-describedby={fid('account-name-hint')}
        onChange={set('accountName')}
      />
      <p className="admin-note" id={fid('account-name-hint')}>
        The name the bank holds the account in.
      </p>
      <label htmlFor={fid('currency')}>Currency</label>
      <input
        id={fid('currency')}
        value={currency}
        maxLength={3}
        onChange={(e) => setCurrency(e.target.value)}
      />
      <label htmlFor={fid('apca')}>APCA user id (optional)</label>
      <input
        id={fid('apca')}
        value={form.apca}
        inputMode="numeric"
        maxLength={6}
        autoComplete="off"
        aria-describedby={fid('aba-hint')}
        onChange={set('apca')}
      />
      <label htmlFor={fid('aba-name')}>ABA user name (optional)</label>
      <input
        id={fid('aba-name')}
        value={form.abaName}
        maxLength={26}
        autoComplete="off"
        aria-describedby={fid('aba-hint')}
        onChange={set('abaName')}
      />
      <label htmlFor={fid('mnemonic')}>Bank mnemonic (optional)</label>
      <input
        id={fid('mnemonic')}
        value={form.mnemonic}
        maxLength={3}
        autoComplete="off"
        aria-describedby={fid('aba-hint')}
        onChange={set('mnemonic')}
      />
      <p className="admin-note" id={fid('aba-hint')}>
        For batch payment files (ABA): the 6-digit APCA user id and the user name your bank gave
        you, and the bank’s 3-letter code such as CBA. You can also add or change them later.
      </p>
      {incomplete ? (
        <p className="refusal">
          Choose the GL account and fill in the name, BSB, account number and account name.
        </p>
      ) : null}
      <button type="submit" className="primary" disabled={add.isPending}>
        Add bank account
      </button>
      {add.isSuccess ? (
        <p className="done" role="status">
          {add.data.replayed
            ? `${add.data.account.name} was already there: BSB ${add.data.account.bsb}, account ${bankNumberText(add.data.account.account_number)}.`
            : `${add.data.account.name} added: BSB ${add.data.account.bsb}, account ${bankNumberText(add.data.account.account_number)}.`}
        </p>
      ) : null}
      {add.isError && !isStepUp(add.error) ? <Said error={add.error} /> : null}
    </form>
  );
}

const accountLabel = (a: BankAccount) => `${a.name} (${bankNumberText(a.account_number)})`;
const NO_ABA = { apca: '', abaName: '', mnemonic: '' };
const abaOf = (a: BankAccount | undefined) =>
  a
    ? {
        apca: a.apca_user_id ?? '',
        abaName: a.aba_user_name ?? '',
        mnemonic: a.aba_fi_mnemonic ?? '',
      }
    : NO_ABA;

type Done =
  | { kind: 'aba'; name: string; changed: boolean }
  | { kind: 'archive'; name: string; changed: boolean; released: boolean };

function doneText(d: Done): string {
  if (d.kind === 'aba')
    return d.changed
      ? `ABA details saved for ${d.name}.`
      : `${d.name} already had these ABA details.`;
  if (!d.changed) return `${d.name} was already archived.`;
  return d.released
    ? `${d.name} archived. It was the account printed on your invoices: invoices show no bank account until an Owner or Finance Admin requests a new remittance account and someone approves it.`
    : `${d.name} archived.`;
}

/** Change the ABA details of an active account, or archive it (T-0193, ADR-0094). */
function ChangeAccount({
  v,
  companyId,
  onPrompting,
}: {
  v: BankAccountsView;
  companyId: string;
  onPrompting: (on: boolean) => void;
}) {
  const { env } = useServices();
  const client = useMemo(() => createSettingsClient(env), [env]);
  const queryClient = useQueryClient();
  const active = v.accounts.filter((a) => a.status === 'active');
  const [chosen, setChosen] = useState('');
  const [form, setForm] = useState(NO_ABA);
  const [key, setKey] = useState(newKey);
  const [incomplete, setIncomplete] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [prompting, setPrompting] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const base = useId();
  const fid = (n: string) => `${base}-${n}`;
  const account = active.find((a) => a.id === chosen);
  const set = (k: keyof typeof NO_ABA) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  useEffect(() => {
    if (confirming) keep.current?.focus();
  }, [confirming]);
  useEffect(() => {
    onPrompting(prompting);
  }, [prompting, onPrompting]);

  const settle = async () => {
    setKey(newKey());
    await queryClient.invalidateQueries({ queryKey: ['setup', 'bank-accounts', companyId] });
  };
  const saveAba = useMutation({
    mutationFn: (input: { id: string; aba: BankAccountAba }) =>
      client.setBankAccountAba(companyId, input.id, input.aba, key),
    onMutate: () => setDone(null),
    onSuccess: (r) => setDone({ kind: 'aba', name: r.account.name, changed: r.changed }),
    onError: (e) => setPrompting(isStepUp(e)),
    onSettled: settle,
  });
  const archive = useMutation({
    mutationFn: (id: string) => client.archiveBankAccount(companyId, id, key),
    onMutate: () => setDone(null),
    onSuccess: (r) => {
      setDone({
        kind: 'archive',
        name: r.account.name,
        changed: r.changed,
        released: r.remittance_released,
      });
      setChosen('');
      setForm(NO_ABA);
    },
    onError: (e) => setPrompting(isStepUp(e)),
    onSettled: settle,
  });
  const failed = saveAba.error ?? archive.error;
  useMutationFailureRouting(failed);

  if (prompting && isStepUp(failed))
    return (
      <StepUpPrompt
        error={failed}
        why={CHANGE_STEP_UP_WHY}
        onCancel={() => {
          setPrompting(false);
          saveAba.reset();
          archive.reset();
        }}
      />
    );

  return (
    <form
      className="admin-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const fields = [form.apca, form.abaName, form.mnemonic].map((x) => x.trim());
        if (!account || fields.some((x) => x === '')) {
          setIncomplete(true);
          return;
        }
        setIncomplete(false);
        archive.reset();
        saveAba.mutate({
          id: account.id,
          aba: {
            apca_user_id: form.apca.trim(),
            aba_user_name: form.abaName.trim(),
            aba_fi_mnemonic: form.mnemonic.trim().toUpperCase(),
          },
        });
      }}
    >
      <label htmlFor={fid('account')}>Bank account to change</label>
      <select
        id={fid('account')}
        value={chosen}
        aria-describedby={fid('account-hint')}
        onChange={(e) => {
          setChosen(e.target.value);
          setForm(abaOf(active.find((a) => a.id === e.target.value)));
          setConfirming(false);
          setIncomplete(false);
        }}
      >
        <option value="">Choose a bank account</option>
        {active.map((a) => (
          <option key={a.id} value={a.id}>
            {accountLabel(a)}
          </option>
        ))}
      </select>
      <p className="admin-note" id={fid('account-hint')}>
        The BSB and account number cannot change. If the account itself changed, archive the old one
        and add the new one.
      </p>
      <label htmlFor={fid('apca')}>APCA user id</label>
      <input
        id={fid('apca')}
        value={form.apca}
        inputMode="numeric"
        maxLength={6}
        autoComplete="off"
        aria-describedby={fid('aba-hint')}
        onChange={set('apca')}
      />
      <label htmlFor={fid('aba-name')}>ABA user name</label>
      <input
        id={fid('aba-name')}
        value={form.abaName}
        maxLength={26}
        autoComplete="off"
        aria-describedby={fid('aba-hint')}
        onChange={set('abaName')}
      />
      <label htmlFor={fid('mnemonic')}>Bank mnemonic</label>
      <input
        id={fid('mnemonic')}
        value={form.mnemonic}
        maxLength={3}
        autoComplete="off"
        aria-describedby={fid('aba-hint')}
        onChange={set('mnemonic')}
      />
      <p className="admin-note" id={fid('aba-hint')}>
        The 6-digit APCA user id and the user name your bank gave you for batch payment files, and
        the bank’s 3-letter code such as CBA.
      </p>
      {incomplete ? (
        <p className="refusal">
          Choose the bank account and fill in the APCA user id, ABA user name and bank mnemonic.
        </p>
      ) : null}
      <div className="gl-actions">
        <button type="submit" className="secondary" disabled={saveAba.isPending}>
          Save ABA details
        </button>
        <button
          type="button"
          className="danger"
          disabled={!account || archive.isPending}
          onClick={() => {
            setDone(null);
            setConfirming(true);
          }}
        >
          Archive this account
        </button>
      </div>
      {confirming && account ? (
        <div
          role="alertdialog"
          aria-labelledby={fid('confirm-h')}
          aria-describedby={fid('confirm-text')}
          className="admin-block"
        >
          <h3 id={fid('confirm-h')}>Archive {account.name}?</h3>
          <p id={fid('confirm-text')}>
            {account.name}, BSB {account.bsb}, account {bankNumberText(account.account_number)}:
            statements can no longer be imported to it and batch payment files no longer use it. Its
            history stays. If it is the account printed on your invoices, invoices show no bank
            account until a new one is requested and approved. You cannot undo this here; to use the
            account again, add it as a new bank account.
          </p>
          <div className="gl-actions">
            <button
              type="button"
              className="danger"
              onClick={() => {
                setConfirming(false);
                saveAba.reset();
                archive.mutate(account.id);
              }}
            >
              Archive
            </button>
            <button
              type="button"
              className="secondary"
              ref={keep}
              onClick={() => setConfirming(false)}
            >
              Keep it
            </button>
          </div>
        </div>
      ) : null}
      {done ? (
        <p className="done" role="status">
          {doneText(done)}
        </p>
      ) : null}
      {failed && !isStepUp(failed) ? <Said error={failed} /> : null}
    </form>
  );
}

export function BankAccountsPage() {
  const access = useAccess();
  const { env } = useServices();
  const client = useMemo(() => createSettingsClient(env), [env]);
  const canRead = access.can('settings.read');
  const canManage = access.can('settings.setup.manage');
  const company = useCompany();
  const companyId = company.company?.id ?? '';
  const [changePrompting, setChangePrompting] = useState(false);
  const view = useQuery({
    queryKey: ['setup', 'bank-accounts', companyId],
    queryFn: () => client.bankAccounts(companyId),
    enabled: canRead && !!companyId,
  });
  useFailureRouting(view.error ?? company.error);

  let body;
  if (access.isPending || (canRead && (company.isPending || (!!companyId && view.isPending))))
    body = <Loading what="the bank accounts" />;
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
      <Forbidden heading="You can't see the bank accounts">
        You do not have access to the company settings. The Owner, Finance Admin and Accountant can
        see them; ask your Owner if you need to.
      </Forbidden>
    );
  else if (company.isError || view.isError || !view.data)
    body = (
      <Failure
        heading="We could not load the bank accounts"
        error={view.error ?? company.error}
        onRetry={() => void (view.isError ? view.refetch() : company.refetch())}
      />
    );
  else
    body = (
      <>
        <section className="admin-block" aria-labelledby="bank-accounts-list-h">
          <h2 id="bank-accounts-list-h">Accounts</h2>
          <Accounts v={view.data} />
          {canManage ? null : (
            <p className="admin-note">
              Only the Owner or a Finance Admin can add bank accounts, change their ABA details or
              archive them.
            </p>
          )}
        </section>
        {canManage && view.data.accounts.some((a) => a.status === 'active') ? (
          <section className="admin-block" aria-labelledby="bank-accounts-change-h">
            <h2 id="bank-accounts-change-h">Change ABA details or archive an account</h2>
            <ChangeAccount
              key={companyId}
              v={view.data}
              companyId={companyId}
              onPrompting={setChangePrompting}
            />
          </section>
        ) : null}
        {canManage && !changePrompting ? (
          <section className="admin-block" aria-labelledby="bank-accounts-add-h">
            <h2 id="bank-accounts-add-h">Add a bank account</h2>
            {view.data.kms_configured ? (
              <AddForm key={companyId} v={view.data} companyId={companyId} />
            ) : (
              <p className="admin-note">{NO_KMS}</p>
            )}
          </section>
        ) : null}
      </>
    );

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
