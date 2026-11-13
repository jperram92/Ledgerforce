/**
 * Shared pieces of the bank reconciliation screens (T-0088): the caller's access, the company, the
 * chosen bank account and statement, and the refusal box. The API (T-0149) is the authority on
 * permissions and on every figure; this only hides actions and explains answers.
 */
import { useQuery } from '@tanstack/react-query';
import { useId, type ReactNode } from 'react';
import { AdminApiError } from '../admin/client.ts';
import { Forbidden, PageHead, Refusal, useAccess, useFailureRouting } from '../admin/common.tsx';
import { useServices } from '../env.tsx';
import { useCompany } from '../sales/InvoicesPage.tsx';
import type { BankAccount, Statement } from './client.ts';

export function Region({ heading, children }: { heading: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="admin-block" aria-labelledby={id}>
      <h2 id={id}>{heading}</h2>
      {children}
    </section>
  );
}

/** A 409/422 from the bank routes: the module's own message; anything else as usual. */
export function BankRefusal({ error, what }: { error: unknown; what: string }) {
  if (!(error instanceof AdminApiError) || (error.status !== 422 && error.status !== 409))
    return <Refusal error={error} />;
  const message = typeof error.body['message'] === 'string' ? error.body['message'] : null;
  return (
    <p className="refusal" role="alert">
      We could not {what}
      {message ? `: ${message}` : '.'}
    </p>
  );
}

export function BankForbidden({ title, gloss }: { title: string; gloss: string }) {
  return (
    <>
      <PageHead title={title} gloss={gloss} />
      <Forbidden heading="You can't see bank reconciliation">
        You do not have access to bank statements and reconciliation. The Owner, Finance Admin,
        Accountant and Auditor can see them; ask your Owner if you need to.
      </Forbidden>
    </>
  );
}

export interface BankContext {
  access: ReturnType<typeof useAccess>;
  canRead: boolean;
  companyId: string;
  accounts: BankAccount[];
  account: BankAccount | undefined;
  statements: Statement[];
  statement: Statement | undefined;
  isPending: boolean;
  error: unknown;
  refetch: () => void;
}

/**
 * The bank account named in the address (else the first) and its statements; the statement
 * named in the address (else the newest).
 */
export function useBankContext(accountId?: string, statementId?: string): BankContext {
  const access = useAccess();
  const { bank } = useServices();
  const canRead = access.can('bank.read');
  const company = useCompany();
  const companyId = company.company?.id ?? '';
  const accounts = useQuery({
    queryKey: ['bank', 'accounts', companyId],
    queryFn: () => bank.accounts(companyId),
    enabled: canRead && !!companyId,
  });
  const list = accounts.data?.accounts ?? [];
  const account = list.find((a) => a.id === accountId) ?? (accountId ? undefined : list[0]);
  const chosenAccount = account?.id ?? '';
  const statements = useQuery({
    queryKey: ['bank', 'statements', companyId, chosenAccount],
    queryFn: () => bank.statements(companyId, chosenAccount),
    enabled: canRead && !!companyId && !!chosenAccount,
  });
  const sList = statements.data?.statements ?? [];
  const statement = sList.find((s) => s.id === statementId) ?? (statementId ? undefined : sList[0]);
  const error = statements.error ?? accounts.error ?? company.error;
  useFailureRouting(error);
  return {
    access,
    canRead,
    companyId,
    accounts: list,
    account,
    statements: sList,
    statement,
    isPending:
      access.isPending ||
      (canRead &&
        (company.isPending || accounts.isPending || (!!chosenAccount && statements.isPending))),
    error: access.error ?? error,
    refetch: () => {
      void (accounts.isError ? accounts.refetch() : statements.refetch());
    },
  };
}

export const dayText = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-AU', { dateStyle: 'medium' });

/** "2026-11-02" as "2 Nov 2026", without a time zone shift. */
export const dateText = (day: string): string =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString('en-AU', {
    dateStyle: 'medium',
    timeZone: 'UTC',
  });
