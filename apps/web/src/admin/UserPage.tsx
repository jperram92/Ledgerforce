/**
 * One person (SS-PLAT-78, design §6.3 mover and leaver): their active roles, giving and removing
 * roles (users.roles.assign; the Owner role needs users.roles.assign_owner), and disabling them
 * with a reason and a successor for their approvals (users.manage). Nobody may grant themselves a
 * role: the screen says so first, and shows the API's refusal if it is tried anyway (ADR-0027).
 */
import { isRoleId, permissionToAssign, ROLE_IDS, ROLE_TEMPLATES } from '@ledgerforce/shared/rbac';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { useServices } from '../env.tsx';
import { AdminApiError, type OffboardResult, type UserDetail, type UserRow } from './client.ts';
import {
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
import { timeLabel } from './dates.ts';
import { roleName, STATUS_TEXT } from './messages.ts';

const INTERACTIVE = ROLE_IDS.filter((r) => ROLE_TEMPLATES[r].interactiveLogin);
const plural = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`;

export function UserPage({ userId }: { userId: string }) {
  const access = useAccess();
  const { admin } = useServices();
  const canRead = access.can('users.read');
  const person = useQuery({
    queryKey: ['admin', 'user', userId],
    queryFn: () => admin.user(userId),
    enabled: canRead,
  });
  const users = useQuery({ queryKey: USERS_KEY, queryFn: () => admin.users(), enabled: canRead });
  useFailureRouting(person.error);

  const back = (
    <p className="admin-back">
      <Link to="/settings/users">All people</Link>
    </p>
  );
  if (access.isPending || (canRead && person.isPending)) {
    return (
      <>
        <PageHead title="Person" gloss="One person, their roles and their access." />
        <Loading what="this person" />
      </>
    );
  }
  if (access.isError || !canRead) {
    return (
      <>
        <PageHead title="Person" gloss="One person, their roles and their access." />
        {access.isError ? (
          <Failure
            heading="We could not check what you may do"
            error={access.error}
            onRetry={() => void access.refetch()}
          />
        ) : (
          <Forbidden heading="You can't see the people list">
            {READERS} can see who uses LedgerForce. Ask your Owner if you need to.
          </Forbidden>
        )}
      </>
    );
  }
  if (person.isError) {
    const missing = person.error instanceof AdminApiError && person.error.status === 404;
    return (
      <>
        <PageHead
          title={missing ? 'Person not found' : 'Person'}
          gloss={
            missing
              ? 'Nobody with this id uses LedgerForce in your organisation.'
              : 'One person, their roles and their access.'
          }
        />
        {missing ? null : (
          <Failure
            heading="We could not load this person"
            error={person.error}
            onRetry={() => void person.refetch()}
          />
        )}
        {back}
      </>
    );
  }
  const u = person.data;
  if (!u) return null;
  return (
    <>
      <PageHead
        title={u.display_name}
        gloss={`${u.email}. Status: ${STATUS_TEXT[u.status] ?? u.status}.`}
      />
      {back}
      <Roles person={u} can={access.can} />
      <Leave person={u} can={access.can} others={users.data ?? []} />
    </>
  );
}

function useSelf(): string | undefined {
  const { api } = useServices();
  return useQuery({ queryKey: ['auth', 'me'], queryFn: () => api.me() }).data?.user_id;
}

function Roles({ person, can }: { person: UserDetail; can: (p: string) => boolean }) {
  const { admin } = useServices();
  const queryClient = useQueryClient();
  const self = useSelf() === person.id;
  const [role, setRole] = useState('');
  const [reason, setReason] = useState('');
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['admin', 'user', person.id] });
    await queryClient.invalidateQueries({ queryKey: USERS_KEY });
  };
  const grant = useMutation({
    mutationFn: (r: string) => admin.grantRole(person.id, r),
    onSuccess: refresh,
  });
  const revoke = useMutation({
    mutationFn: (r: string) =>
      admin.revokeRole(person.id, r, reason.trim() || 'Removed in People and roles'),
    onSuccess: refresh,
  });
  useFailureRouting(grant.error ?? revoke.error);
  const mayChange = can('users.roles.assign');
  const assignable = INTERACTIVE.filter(
    (r) => can(permissionToAssign(r)) && !person.roles.includes(r),
  );
  const disabled = person.status === 'disabled';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    revoke.reset();
    if (role) grant.mutate(role);
  };

  return (
    <section className="admin-block" aria-labelledby="roles-h">
      <h2 id="roles-h">Roles</h2>
      {person.roles.length === 0 ? (
        <p>{person.display_name} has no roles, so they can sign in but do nothing.</p>
      ) : (
        <ul className="admin-roles" aria-label="Current roles">
          {person.roles.map((r) => (
            <li key={r}>
              <span>{roleName(r)}</span>
              {mayChange && !disabled && isRoleId(r) && can(permissionToAssign(r)) ? (
                <button
                  type="button"
                  className="secondary"
                  disabled={revoke.isPending}
                  onClick={() => {
                    grant.reset();
                    revoke.mutate(r);
                  }}
                >
                  Remove {roleName(r)}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {disabled ? (
        <p className="admin-note">Disabled people keep no roles. Invite them again to return.</p>
      ) : !mayChange ? (
        <p className="admin-note">Only the Owner or a Finance Admin can change roles.</p>
      ) : (
        <>
          {self ? (
            <p className="admin-note" id="self-note">
              You can&apos;t change your own roles: another Owner or Finance Admin has to.
            </p>
          ) : null}
          <form className="admin-form inline" onSubmit={submit}>
            <label htmlFor="give-role">Role to give</label>
            <select
              id="give-role"
              value={role}
              onChange={(e) => {
                setRole(e.target.value);
              }}
              {...(self ? { 'aria-describedby': 'self-note' } : {})}
            >
              <option value="">Choose a role</option>
              {assignable.map((r) => (
                <option key={r} value={r}>
                  {roleName(r)}
                </option>
              ))}
            </select>
            <button type="submit" className="secondary" disabled={grant.isPending || !role}>
              Give role
            </button>
            <label htmlFor="role-reason">Reason for removing a role (kept in the audit log)</label>
            <input
              id="role-reason"
              maxLength={500}
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
              }}
            />
          </form>
          <p className="admin-note">
            A change signs {person.display_name} out everywhere, so it takes effect at once.
          </p>
        </>
      )}
      <Refusal error={grant.error ?? revoke.error} />
      {grant.isSuccess ? (
        <p className="done" role="status">
          Gave {person.display_name} the {roleName(grant.variables)} role.
        </p>
      ) : null}
      {revoke.isSuccess ? (
        <p className="done" role="status">
          Removed the {roleName(revoke.variables)} role from {person.display_name}.
        </p>
      ) : null}
    </section>
  );
}

function Leave({
  person,
  can,
  others,
}: {
  person: UserDetail;
  can: (p: string) => boolean;
  others: readonly UserRow[];
}) {
  const { admin } = useServices();
  const queryClient = useQueryClient();
  const self = useSelf() === person.id;
  const [reason, setReason] = useState('');
  const [successor, setSuccessor] = useState('');
  const [confirming, setConfirming] = useState(false);
  const offboard = useMutation({
    mutationFn: () =>
      admin.offboard(person.id, {
        reason: reason.trim(),
        ...(successor ? { successor_user_id: successor } : {}),
      }),
    onSuccess: async () => {
      setConfirming(false);
      await queryClient.invalidateQueries({ queryKey: USERS_KEY });
    },
  });
  useFailureRouting(offboard.error);
  const nameOf = (id: string | null | undefined) =>
    others.find((o) => o.id === id)?.display_name ?? 'someone no longer listed';

  if (offboard.data) return <LeaveDone person={person} result={offboard.data} nameOf={nameOf} />;
  if (person.status === 'disabled') {
    return (
      <section className="admin-block" aria-labelledby="leave-h">
        <h2 id="leave-h">Disabled</h2>
        <p>
          Disabled
          {person.disabled_at ? ` on ${timeLabel(person.disabled_at)}` : ''}
          {person.disable_reason ? `. Reason: ${person.disable_reason}` : ''}. Their history stays;
          nothing was deleted.
          {person.successor_user_id
            ? ` Their approvals go to ${nameOf(person.successor_user_id)}.`
            : ''}
        </p>
      </section>
    );
  }
  if (!can('users.manage')) return null;
  if (self) {
    return (
      <section className="admin-block" aria-labelledby="leave-h">
        <h2 id="leave-h">Disable this person</h2>
        <p className="admin-note">You can&apos;t disable yourself. Ask another Owner to do it.</p>
      </section>
    );
  }
  const successors = others.filter((o) => o.status === 'active' && o.id !== person.id);
  return (
    <section className="admin-block" aria-labelledby="leave-h">
      <h2 id="leave-h">Disable this person</h2>
      <p>
        When someone leaves, disable them: they are signed out everywhere and lose their API tokens
        and roles. Nothing is deleted, and their history stays in the audit log.
      </p>
      <form
        className="admin-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (reason.trim() === '') return;
          setConfirming(true);
        }}
      >
        <label htmlFor="leave-reason">Why are they leaving?</label>
        <textarea
          id="leave-reason"
          required
          maxLength={500}
          rows={2}
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            setConfirming(false);
          }}
        />
        <label htmlFor="leave-successor">Who takes over their approvals</label>
        <select
          id="leave-successor"
          value={successor}
          onChange={(e) => {
            setSuccessor(e.target.value);
            setConfirming(false);
          }}
        >
          <option value="">Nobody yet</option>
          {successors.map((o) => (
            <option key={o.id} value={o.id}>
              {o.display_name}
            </option>
          ))}
        </select>
        {confirming ? (
          <div className="confirm" role="group" aria-label="Confirm">
            <p>
              {person.display_name} loses access now. You can invite them again later, but this
              can&apos;t be undone.
            </p>
            <button
              type="button"
              className="danger"
              disabled={offboard.isPending}
              onClick={() => {
                offboard.mutate();
              }}
            >
              Yes, disable {person.display_name} now
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setConfirming(false);
              }}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button type="submit" className="secondary">
            Disable {person.display_name}
          </button>
        )}
      </form>
      <Refusal error={offboard.error} />
    </section>
  );
}

function LeaveDone({
  person,
  result,
  nameOf,
}: {
  person: UserDetail;
  result: OffboardResult;
  nameOf: (id: string | null | undefined) => string;
}) {
  const text = !result.changed
    ? `${person.display_name} was already disabled.`
    : `${person.display_name} is disabled. Revoked ${plural(result.sessions_revoked ?? 0, 'session', 'sessions')}, ${plural(result.tokens_revoked ?? 0, 'API token', 'API tokens')} and ${plural(result.roles_revoked ?? 0, 'role', 'roles')}. ${
        result.approvals_assignee
          ? `Approvals now go to ${nameOf(result.approvals_assignee)}.`
          : 'Nobody takes over their approvals yet.'
      }`;
  return (
    <section className="admin-block" aria-labelledby="leave-h">
      <h2 id="leave-h">Disabled</h2>
      <p className="done" role="status">
        {text}
      </p>
    </section>
  );
}
