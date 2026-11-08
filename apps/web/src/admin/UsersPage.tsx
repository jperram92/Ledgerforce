/**
 * People and roles (SS-PLAT-78, design §6.3–6.4, IA S19): everyone who can use LedgerForce with
 * their status and active roles, and the joiner step (invite). Invite needs users.manage (Owner)
 * and the right to assign each chosen role; the form only offers what the caller may do and says
 * who can do the rest.
 */
import { isRoleId, permissionToAssign, ROLE_IDS, ROLE_TEMPLATES } from '@ledgerforce/shared/rbac';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { useServices } from '../env.tsx';
import type { Invite } from './client.ts';
import {
  Empty,
  Failure,
  Forbidden,
  Loading,
  PageHead,
  READERS,
  Refusal,
  useAccess,
  useFailureRouting,
  USERS_KEY,
} from './common.tsx';
import { roleName, STATUS_TEXT } from './messages.ts';

const TITLE = 'People and roles';
const GLOSS =
  'Who can sign in to LedgerForce and what each person may do (users and role assignments).';

/** Roles a person can hold in the app (Sales user and Integration never sign in here). */
const INTERACTIVE = ROLE_IDS.filter((r) => ROLE_TEMPLATES[r].interactiveLogin);

export function UsersPage() {
  const access = useAccess();
  const { admin } = useServices();
  const canRead = access.can('users.read');
  const users = useQuery({ queryKey: USERS_KEY, queryFn: () => admin.users(), enabled: canRead });
  useFailureRouting(users.error);

  let body;
  if (access.isPending) body = <Loading what="your access" />;
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
      <Forbidden heading="You can't see the people list">
        {READERS} can see who uses LedgerForce. Ask your Owner if you need to.
      </Forbidden>
    );
  else if (users.isPending) body = <Loading what="people" />;
  else if (users.isError)
    body = (
      <Failure
        heading="We could not load the people list"
        error={users.error}
        onRetry={() => void users.refetch()}
      />
    );
  else
    body = (
      <>
        {users.data.length === 0 ? (
          <Empty heading="No people yet">People appear here once they are invited.</Empty>
        ) : (
          <div className="admin-block">
            <table className="admin-table" aria-label="People">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Email</th>
                  <th scope="col">Roles</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {users.data.map((u) => (
                  <tr key={u.id}>
                    <td data-label="Name">
                      <Link to="/settings/users/$userId" params={{ userId: u.id }}>
                        {u.display_name}
                      </Link>
                    </td>
                    <td data-label="Email">{u.email}</td>
                    <td data-label="Roles">
                      {u.roles.length ? u.roles.map(roleName).join(', ') : 'No roles'}
                    </td>
                    <td data-label="Status">
                      <span className="word" data-status={u.status}>
                        {STATUS_TEXT[u.status] ?? u.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {access.can('users.manage') ? (
          <InviteForm can={access.can} />
        ) : (
          <p className="admin-note">Only the Owner can invite people or disable them.</p>
        )}
      </>
    );

  return (
    <>
      <PageHead title={TITLE} gloss={GLOSS} />
      {body}
    </>
  );
}

function InviteForm({ can }: { can: (p: string) => boolean }) {
  const { admin } = useServices();
  const queryClient = useQueryClient();
  const empty: Invite = { email: '', display_name: '', idp_issuer: '', idp_subject: '', roles: [] };
  const [form, setForm] = useState<Invite>(empty);
  const invite = useMutation({
    mutationFn: (body: Invite) => admin.invite(body),
    onSuccess: async () => {
      setForm(empty);
      await queryClient.invalidateQueries({ queryKey: USERS_KEY });
    },
  });
  useFailureRouting(invite.error);
  const assignable = INTERACTIVE.filter((r) => can(permissionToAssign(r)));
  const set = (k: keyof Omit<Invite, 'roles'>) => (e: { target: { value: string } }) => {
    setForm({ ...form, [k]: e.target.value });
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    invite.mutate({
      ...form,
      roles: ROLE_IDS.filter((r) => form.roles.includes(r)),
    });
  };
  const invited = invite.data;
  const needsMfa =
    invited?.roles.some((r) => isRoleId(r) && ROLE_TEMPLATES[r].mfaRequired) ?? false;

  return (
    <section className="admin-block" aria-labelledby="invite-h">
      <h2 id="invite-h">Invite someone</h2>
      <p className="admin-note">
        They sign in with your organisation&apos;s identity provider. They become active the first
        time they sign in.
      </p>
      <form className="admin-form" onSubmit={submit}>
        <label htmlFor="inv-name">Full name</label>
        <input
          id="inv-name"
          required
          maxLength={200}
          value={form.display_name}
          onChange={set('display_name')}
        />
        <label htmlFor="inv-email">Email address</label>
        <input
          id="inv-email"
          type="email"
          required
          maxLength={254}
          autoComplete="off"
          value={form.email}
          onChange={set('email')}
        />
        <label htmlFor="inv-iss">Identity provider (issuer URL)</label>
        <input
          id="inv-iss"
          required
          maxLength={500}
          value={form.idp_issuer}
          onChange={set('idp_issuer')}
        />
        <label htmlFor="inv-sub">Their id at the identity provider</label>
        <input
          id="inv-sub"
          required
          maxLength={255}
          value={form.idp_subject}
          onChange={set('idp_subject')}
        />
        <fieldset>
          <legend>Roles</legend>
          {assignable.map((r) => (
            <label key={r} className="check">
              <input
                type="checkbox"
                checked={form.roles.includes(r)}
                onChange={(e) => {
                  setForm({
                    ...form,
                    roles: e.target.checked
                      ? [...form.roles, r]
                      : form.roles.filter((x) => x !== r),
                  });
                }}
              />
              {roleName(r)}
            </label>
          ))}
        </fieldset>
        <button type="submit" className="primary" disabled={invite.isPending}>
          Send invitation
        </button>
      </form>
      <Refusal error={invite.error} />
      {invited ? (
        <p className="done" role="status">
          Invited {invited.display_name}. They become active the first time they sign in
          {needsMfa ? ', after setting up two-step sign-in' : ''}.
        </p>
      ) : null}
    </section>
  );
}
