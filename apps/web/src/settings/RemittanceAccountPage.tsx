/**
 * Remittance account: the company bank account printed on invoices for bank transfer, part of
 * setup wizard step 8 (T-0183, SS-PLAT-149, design §6.1, §6.5, §6.6, ADR-0079, ADR-0080,
 * ADR-0086). Changing it decides where customers send their money, so it is maker-checker: someone
 * with settings.setup.manage asks for a change (after a fresh sign-in), and a different person
 * approves it (after a fresh sign-in) or rejects it with a reason. The requester is told before
 * asking that they cannot approve their own request; in small-team mode they may, with a reason
 * that is recorded (ADR-0026). Others with settings.read see it read-only. Every account is masked
 * to its last 3 digits: the API never sends more (ADR-0018). The API decides every rule; this
 * screen only says what it answers.
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
import { timeLabel } from '../admin/dates.ts';
import { useServices } from '../env.tsx';
import { isStepUp, StepUpPrompt, useMutationFailureRouting } from '../purchases/StepUpPrompt.tsx';
import { useCompany } from '../sales/InvoicesPage.tsx';
import {
  createSettingsClient,
  type RemittanceAccount,
  type RemittanceChange,
  type RemittanceView,
} from './client.ts';
import {
  REMOVE_REMITTANCE,
  remittanceChoices,
  remittanceRefusal,
  remittanceText,
} from './settings-logic.ts';

const TITLE = 'Remittance account';
const GLOSS =
  'The bank account printed on your invoices for customers who pay by bank transfer. A second person approves every change. Part of setup step 8.';
const REQUEST_WHY =
  'The bank account on your invoices decides where customers send their money, so LedgerForce asks you to confirm your sign-in before you ask for a change.';
const APPROVE_WHY =
  'Approving puts this bank account on your invoices at once, so LedgerForce asks you to confirm your sign-in first.';
const SECOND_PERSON = 'Someone else with the Owner or Finance Admin role has to approve it';
const newKey = () => `remittance-${crypto.randomUUID()}`;
const queryKey = (companyId: string) => ['setup', 'remittance-account', companyId];

function Said({ error }: { error: unknown }) {
  const text = remittanceRefusal(error);
  if (!text) return <Refusal error={error} />;
  return (
    <p className="refusal" role="alert">
      {text}
    </p>
  );
}

const inForceText = (a: RemittanceAccount) =>
  `${remittanceText(a)}, in the name of ${a.account_name} (${a.currency}).`;

function InForce({ v, notice }: { v: RemittanceView; notice: string | null }) {
  return (
    <section className="admin-block" aria-labelledby="remittance-now-h">
      <h2 id="remittance-now-h">On your invoices</h2>
      {v.account ? (
        <p className="admin-note">{inForceText(v.account)}</p>
      ) : (
        <p className="admin-note">
          No remittance account yet. Invoices show no bank details for bank transfer until a change
          is approved.
        </p>
      )}
      {notice ? (
        <p className="done" role="status">
          {notice}
        </p>
      ) : null}
    </section>
  );
}

function useMe(): string {
  const { api } = useServices();
  const me = useQuery({ queryKey: ['auth', 'me'], queryFn: () => api.me() });
  return me.data?.user_id ?? '';
}

function Pending({
  p,
  companyId,
  canManage,
  smallTeam,
  onDone,
}: {
  p: RemittanceChange;
  companyId: string;
  canManage: boolean;
  smallTeam: boolean;
  onDone: (notice: string) => void;
}) {
  const { env } = useServices();
  const client = useMemo(() => createSettingsClient(env), [env]);
  const queryClient = useQueryClient();
  const me = useMe();
  const mine = me !== '' && me === p.requested_by;
  const [own, setOwn] = useState('');
  const [why, setWhy] = useState('');
  const [needsWhy, setNeedsWhy] = useState(false);
  const [prompting, setPrompting] = useState(false);
  const [key, setKey] = useState(newKey);
  const ids = { h: useId(), own: useId(), why: useId(), note: useId() };
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKey(companyId) });

  const approve = useMutation({
    mutationFn: () =>
      client.approveRemittance(companyId, p.id, key, mine ? { reason: own.trim() } : undefined),
    onSuccess: (c) => onDone(`Approved. Invoices now print ${remittanceText(c.bank_account)}.`),
    onError: (e) => setPrompting(isStepUp(e)),
    onSettled: async () => {
      setKey(newKey());
      await refresh();
    },
  });
  const reject = useMutation({
    mutationFn: (reason: string) => client.rejectRemittance(companyId, p.id, reason, key),
    onSuccess: (c) =>
      onDone(
        c.previous_bank_account
          ? `Rejected. Invoices still print ${remittanceText(c.previous_bank_account)}.`
          : 'Rejected. Invoices still show no bank details for bank transfer.',
      ),
    onSettled: async () => {
      setKey(newKey());
      await refresh();
    },
  });
  useMutationFailureRouting(approve.error);
  useFailureRouting(reject.error);

  if (prompting && isStepUp(approve.error))
    return (
      <StepUpPrompt
        error={approve.error}
        why={APPROVE_WHY}
        onCancel={() => {
          setPrompting(false);
          approve.reset();
        }}
      />
    );

  const busy = approve.isPending || reject.isPending;
  return (
    <section className="admin-block" aria-labelledby={ids.h}>
      <h2 id={ids.h}>Waiting for approval</h2>
      <p className="admin-note">
        {p.bank_account
          ? `Change to ${remittanceText(p.bank_account)}, in the name of ${p.bank_account.account_name}.`
          : 'Remove the remittance account, so invoices show no bank details for bank transfer.'}
      </p>
      <p className="admin-note">
        {p.previous_bank_account
          ? `Instead of ${remittanceText(p.previous_bank_account)}.`
          : 'There is no remittance account now.'}{' '}
        Asked by {mine ? 'you' : 'someone else'} on {timeLabel(p.requested_at)}.
      </p>
      {!canManage ? (
        <p className="admin-note">Only the Owner or a Finance Admin can approve or reject it.</p>
      ) : (
        <div className="admin-form">
          {mine ? (
            <p className="admin-note" id={ids.note}>
              You asked for this change, so you can’t approve it. {SECOND_PERSON}.
              {smallTeam
                ? ' Your organisation is in small-team mode: if nobody else can approve it, you may approve it yourself if you write why. That is recorded for the Owner’s weekly review, and every Owner and Finance Admin is told.'
                : ''}
            </p>
          ) : (
            <p className="admin-note" id={ids.note}>
              Invoices print it as soon as it is approved. Check the details with the person who
              asked, by phone or in person, before you approve.
            </p>
          )}
          {mine && smallTeam ? (
            <>
              <label htmlFor={ids.own}>Why you are approving your own change</label>
              <textarea
                id={ids.own}
                rows={2}
                maxLength={2000}
                value={own}
                onChange={(e) => setOwn(e.target.value)}
              />
            </>
          ) : null}
          {!mine || smallTeam ? (
            <div className="gl-actions">
              <button
                type="button"
                className="primary"
                aria-describedby={ids.note}
                disabled={busy || (mine && own.trim() === '')}
                onClick={() => approve.mutate()}
              >
                {mine ? 'Approve my own change' : 'Approve this change'}
              </button>
            </div>
          ) : null}
          {approve.isError && !isStepUp(approve.error) ? <Said error={approve.error} /> : null}
          <label htmlFor={ids.why}>Why you are rejecting it</label>
          <textarea
            id={ids.why}
            rows={2}
            maxLength={2000}
            value={why}
            onChange={(e) => {
              setWhy(e.target.value);
              setNeedsWhy(false);
            }}
          />
          {needsWhy ? <p className="refusal">Write why you are rejecting this change.</p> : null}
          <div className="gl-actions">
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                if (why.trim() === '') {
                  setNeedsWhy(true);
                  return;
                }
                reject.mutate(why.trim());
              }}
            >
              Reject this change
            </button>
          </div>
          {reject.isError ? <Said error={reject.error} /> : null}
        </div>
      )}
    </section>
  );
}

function AskForm({
  v,
  companyId,
  onDone,
}: {
  v: RemittanceView;
  companyId: string;
  onDone: (notice: string) => void;
}) {
  const { env } = useServices();
  const client = useMemo(() => createSettingsClient(env), [env]);
  const queryClient = useQueryClient();
  const accounts = useQuery({
    queryKey: ['setup', 'bank-accounts', companyId],
    queryFn: () => client.bankAccounts(companyId),
  });
  const [choice, setChoice] = useState('');
  const [prompting, setPrompting] = useState(false);
  const ids = { h: useId(), c: useId(), note: useId() };
  const ask = useMutation({
    // A new change id (and key) for each attempt: a refused or step-up attempt wrote nothing.
    mutationFn: (target: string | null) =>
      client.requestRemittance(companyId, crypto.randomUUID(), target, newKey()),
    onSuccess: async () => {
      setChoice('');
      onDone(`Change asked for. ${SECOND_PERSON}.`);
      await queryClient.invalidateQueries({ queryKey: queryKey(companyId) });
    },
    // A refusal stays on screen next to the form; its words say when to reload.
    onError: (e) => setPrompting(isStepUp(e)),
  });
  useMutationFailureRouting(ask.error);
  useFailureRouting(accounts.error);

  if (prompting && isStepUp(ask.error))
    return (
      <StepUpPrompt
        error={ask.error}
        why={REQUEST_WHY}
        onCancel={() => {
          setPrompting(false);
          ask.reset();
        }}
      />
    );

  let form;
  if (accounts.isPending) form = <Loading what="the bank accounts" />;
  else if (accounts.isError)
    form = (
      <Failure
        heading="We could not load the bank accounts"
        error={accounts.error}
        onRetry={() => void accounts.refetch()}
      />
    );
  else {
    const choices = remittanceChoices(accounts.data.accounts, v.account?.id ?? null);
    form =
      choices.length === 0 ? (
        <p className="admin-note">
          There is no other active bank account to choose. Add one first on{' '}
          <Link to="/settings/bank-accounts">Bank accounts</Link>.
        </p>
      ) : (
        <form
          className="admin-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (choice) ask.mutate(choice === REMOVE_REMITTANCE ? null : choice);
          }}
        >
          <label htmlFor={ids.c}>Bank account to print on invoices</label>
          <select id={ids.c} value={choice} onChange={(e) => setChoice(e.target.value)}>
            <option value="">Choose a bank account</option>
            {choices.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="primary"
            aria-describedby={ids.note}
            disabled={ask.isPending || !choice}
          >
            Ask for this change
          </button>
          {ask.isError && !isStepUp(ask.error) ? <Said error={ask.error} /> : null}
        </form>
      );
  }
  return (
    <section className="admin-block" aria-labelledby={ids.h}>
      <h2 id={ids.h}>Ask for a change</h2>
      <p className="admin-note" id={ids.note}>
        Nothing changes on your invoices until the change is approved. {SECOND_PERSON}: you cannot
        approve your own request.
      </p>
      {form}
    </section>
  );
}

export function RemittanceAccountPage() {
  const access = useAccess();
  const { env } = useServices();
  const client = useMemo(() => createSettingsClient(env), [env]);
  const canRead = access.can('settings.read');
  const canManage = access.can('settings.setup.manage');
  const company = useCompany();
  const companyId = company.company?.id ?? '';
  const [notice, setNotice] = useState<string | null>(null);
  const view = useQuery({
    queryKey: queryKey(companyId),
    queryFn: () => client.remittance(companyId),
    enabled: canRead && !!companyId,
  });
  // Small-team mode decides whether a requester may approve their own change (ADR-0026).
  const sod = useQuery({
    queryKey: ['sod', 'settings'],
    queryFn: () => client.approvals(),
    enabled: canRead && canManage,
  });
  useFailureRouting(view.error ?? company.error);

  let body;
  if (access.isPending || (canRead && (company.isPending || (!!companyId && view.isPending))))
    body = <Loading what="the remittance account" />;
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
      <Forbidden heading="You can't see the remittance account">
        You do not have access to the company settings. The Owner, Finance Admin and Accountant can
        see them; ask your Owner if you need to.
      </Forbidden>
    );
  else if (company.isError || view.isError || !view.data)
    body = (
      <Failure
        heading="We could not load the remittance account"
        error={view.error ?? company.error}
        onRetry={() => void (view.isError ? view.refetch() : company.refetch())}
      />
    );
  else {
    const v = view.data;
    body = (
      <>
        <InForce v={v} notice={notice} />
        {v.pending ? (
          <Pending
            key={v.pending.id}
            p={v.pending}
            companyId={companyId}
            canManage={canManage}
            smallTeam={sod.data?.small_team_mode === true}
            onDone={setNotice}
          />
        ) : canManage ? (
          <AskForm v={v} companyId={companyId} onDone={setNotice} />
        ) : (
          <p className="admin-note">
            Only the Owner or a Finance Admin can ask for a change, and a second person approves it.
          </p>
        )}
      </>
    );
  }

  return (
    <>
      <PageHead title={TITLE} gloss={GLOSS} />
      <p className="admin-note">
        <Link to="/settings/billing">Back to Numbering and billing</Link>
      </p>
      {body}
    </>
  );
}
