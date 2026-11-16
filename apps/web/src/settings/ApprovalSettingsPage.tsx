/**
 * Approval amounts: the segregation-of-duties settings of setup wizard step 10 (T-0186,
 * SS-PLAT-131, design §6.5, ADR-0026, ADR-0085). The amounts above which a second person must
 * approve, small-team mode and the time zone of the weekly exception report. They apply to the
 * whole organisation, not one company. Only the Owner (settings.sod.manage) changes them, with a
 * reason; others with settings.read see them read-only. Until they are saved the API shows the
 * design's suggested amounts (an open decision, DL-0131): the screen says so plainly.
 * Amounts stay decimal strings from input to request (apps/web rules).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Fragment, useId, useMemo, useState } from 'react';
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
import { createSettingsClient, type ApprovalSettings, type ThresholdName } from './client.ts';
import { amountEdit, amountInput, approvalRefusal } from './billing-logic.ts';

const TITLE = 'Approval amounts';
const GLOSS =
  'The amounts above which a second person must approve, and how a very small team works. They apply to the whole organisation. Setup step 10.';
const newKey = () => `approvals-${crypto.randomUUID()}`;
const QUERY = ['setup', 'approvals'] as const;

const THRESHOLDS: { name: ThresholdName; label: string }[] = [
  { name: 'bill_self_approval', label: 'Bills: someone else approves a bill above' },
  {
    name: 'credit_note_self_approval',
    label: 'Credit notes: someone else approves a credit note above',
  },
  { name: 'journal_approval', label: 'Manual journals need approval above' },
  { name: 'batch_two_releasers', label: 'Payment batches need two people to release above' },
];
const ZONES = [
  'Australia/Sydney',
  'Australia/Melbourne',
  'Australia/Brisbane',
  'Australia/Adelaide',
  'Australia/Darwin',
  'Australia/Hobart',
  'Australia/Perth',
  'Pacific/Auckland',
];
const SMALL_TEAM =
  'Small-team mode: when nobody else can approve, the person may go ahead, and it is recorded as an exception on the weekly report the Owner acknowledges.';

function Placeholder({ s }: { s: ApprovalSettings }) {
  if (!s.placeholder_defaults) return null;
  return (
    <p className="admin-note">
      Nothing has been saved yet: these are the suggested amounts. Save them as they are or change
      them to finish setup step 10.
    </p>
  );
}

function Said({ error }: { error: unknown }) {
  const text = approvalRefusal(error);
  if (!text) return <Refusal error={error} />;
  return (
    <p className="refusal" role="alert">
      {text}
    </p>
  );
}

function Now({ s }: { s: ApprovalSettings }) {
  return (
    <dl className="settings-dl">
      {THRESHOLDS.map((t) => (
        <Fragment key={t.name}>
          <dt>{t.label}</dt>
          <dd>${amountEdit(s.thresholds[t.name])}</dd>
        </Fragment>
      ))}
      <dt>Small-team mode</dt>
      <dd>{s.small_team_mode ? 'On' : 'Off'}</dd>
      <dt>Weekly report time zone</dt>
      <dd>{s.report_timezone}</dd>
    </dl>
  );
}

function ApprovalForm({ s }: { s: ApprovalSettings }) {
  const { env } = useServices();
  const client = useMemo(() => createSettingsClient(env), [env]);
  const queryClient = useQueryClient();
  const [amounts, setAmounts] = useState<Record<ThresholdName, string>>(() => ({
    bill_self_approval: amountEdit(s.thresholds.bill_self_approval),
    credit_note_self_approval: amountEdit(s.thresholds.credit_note_self_approval),
    journal_approval: amountEdit(s.thresholds.journal_approval),
    batch_two_releasers: amountEdit(s.thresholds.batch_two_releasers),
  }));
  const [smallTeam, setSmallTeam] = useState(s.small_team_mode);
  const [zone, setZone] = useState(s.report_timezone);
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [key, setKey] = useState(newKey);
  const base = useId();
  const id = (n: string) => `${base}-${n}`;
  const save = useMutation({
    mutationFn: (thresholds: Record<ThresholdName, string>) =>
      client.saveApprovals(
        { thresholds, small_team_mode: smallTeam, report_timezone: zone, reason: reason.trim() },
        key,
      ),
    onSuccess: (r) => {
      // Show what is now in force, exactly as the API keeps it; the reason was for this change.
      const t = r.settings.thresholds;
      setAmounts({
        bill_self_approval: amountEdit(t.bill_self_approval),
        credit_note_self_approval: amountEdit(t.credit_note_self_approval),
        journal_approval: amountEdit(t.journal_approval),
        batch_two_releasers: amountEdit(t.batch_two_releasers),
      });
      setReason('');
    },
    onSettled: async () => {
      setKey(newKey());
      await queryClient.invalidateQueries({ queryKey: QUERY });
    },
  });
  const zones = ZONES.includes(s.report_timezone) ? ZONES : [s.report_timezone, ...ZONES];

  return (
    <section className="admin-block" aria-labelledby={id('h')}>
      <h2 id={id('h')}>Amounts and small-team mode</h2>
      <Placeholder s={s} />
      <form
        className="admin-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const read = THRESHOLDS.map((t) => [t.name, amountInput(amounts[t.name])] as const);
          const wrong = read.find(([, v]) => v === null);
          if (wrong) {
            const label = THRESHOLDS.find((t) => t.name === wrong[0])?.label ?? '';
            setProblem(`Write "${label}" as a plain amount, such as 1000 or 1,000.50.`);
            return;
          }
          if (reason.trim() === '') {
            setProblem('Say why the approval amounts are being set or changed.');
            return;
          }
          setProblem(null);
          save.mutate(Object.fromEntries(read) as Record<ThresholdName, string>);
        }}
      >
        {THRESHOLDS.map((t) => (
          <Fragment key={t.name}>
            <label htmlFor={id(t.name)}>{t.label} ($)</label>
            <input
              id={id(t.name)}
              value={amounts[t.name]}
              inputMode="decimal"
              maxLength={24}
              onChange={(e) => setAmounts((a) => ({ ...a, [t.name]: e.target.value }))}
            />
          </Fragment>
        ))}
        <label className="check">
          <input
            type="checkbox"
            checked={smallTeam}
            onChange={(e) => setSmallTeam(e.target.checked)}
          />
          <span>{SMALL_TEAM}</span>
        </label>
        <label htmlFor={id('zone')}>Weekly report time zone</label>
        <select id={id('zone')} value={zone} onChange={(e) => setZone(e.target.value)}>
          {zones.map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </select>
        <label htmlFor={id('reason')}>Reason for the change</label>
        <textarea
          id={id('reason')}
          value={reason}
          maxLength={2000}
          rows={3}
          onChange={(e) => setReason(e.target.value)}
        />
        <p className="admin-note">The reason is kept with the change in the audit log.</p>
        {problem ? (
          <p className="refusal" role="alert">
            {problem}
          </p>
        ) : null}
        <button type="submit" className="primary" disabled={save.isPending}>
          Save approval amounts
        </button>
        {save.isSuccess ? (
          <p className="done" role="status">
            {save.data.changed
              ? 'Approval amounts saved.'
              : 'Nothing changed: these approval amounts were already in force.'}
          </p>
        ) : null}
        {save.isError ? <Said error={save.error} /> : null}
      </form>
    </section>
  );
}

function ReadOnly({ s }: { s: ApprovalSettings }) {
  return (
    <section className="admin-block" aria-labelledby="approvals-ro-h">
      <h2 id="approvals-ro-h">Amounts and small-team mode</h2>
      <Placeholder s={s} />
      <Now s={s} />
      <p className="admin-note">Only the Owner can change the approval amounts.</p>
    </section>
  );
}

export function ApprovalSettingsPage() {
  const access = useAccess();
  const { env } = useServices();
  const client = useMemo(() => createSettingsClient(env), [env]);
  const canRead = access.can('settings.read');
  const canManage = access.can('settings.sod.manage');
  const settings = useQuery({
    queryKey: QUERY,
    queryFn: () => client.approvals(),
    enabled: canRead,
  });
  useFailureRouting(settings.error);

  let body;
  if (access.isPending || (canRead && settings.isPending))
    body = <Loading what="the approval amounts" />;
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
      <Forbidden heading="You can't see the approval amounts">
        You do not have access to the company settings. The Owner, Finance Admin and Accountant can
        see them; ask your Owner if you need to.
      </Forbidden>
    );
  else if (settings.isError || !settings.data)
    body = (
      <Failure
        heading="We could not load the approval amounts"
        error={settings.error}
        onRetry={() => void settings.refetch()}
      />
    );
  else if (canManage) body = <ApprovalForm s={settings.data} />;
  else body = <ReadOnly s={settings.data} />;

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
