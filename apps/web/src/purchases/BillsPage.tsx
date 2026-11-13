/**
 * Bills list (T-0086, UC-05, SS-UC05-08): every supplier bill of the company, newest first, with its
 * state in words (P2) and who acts next (P13). Readers: ap.read. "Enter a bill" only for those with
 * ap.bill.enter (AP Clerks, Owners); Approvers approve from the bill itself.
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Money } from '@ledgerforce/ui';
import {
  Empty,
  Failure,
  Forbidden,
  Loading,
  PageHead,
  useAccess,
  useFailureRouting,
} from '../admin/common.tsx';
import { useServices } from '../env.tsx';
import { billName, billStatus, nextTurn } from './bill-logic.ts';

export const AP_READERS = 'Owners, Finance Admins, Accountants, AP Clerks, Approvers and Auditors';

export function ApForbidden() {
  return (
    <Forbidden heading="You can't see bills">
      You do not have access to supplier bills. {AP_READERS} can see them; ask your Owner if you
      need to.
    </Forbidden>
  );
}

/** The caller's company (the first; multi-company choice is a later task, as on invoices). */
export function useApCompany() {
  const { purchases } = useServices();
  const q = useQuery({ queryKey: ['companies'], queryFn: () => purchases.companies() });
  return { ...q, company: q.data?.[0] };
}

export function BillsPage() {
  const access = useAccess();
  const { purchases } = useServices();
  const canRead = access.can('ap.read');
  const company = useApCompany();
  const list = useQuery({
    queryKey: ['ap', 'bills', company.company?.id ?? ''],
    queryFn: () => purchases.bills(company.company?.id ?? ''),
    enabled: canRead && !!company.company,
  });
  useFailureRouting(list.error ?? company.error);

  let body;
  if (access.isPending || (canRead && company.isPending)) body = <Loading what="bills" />;
  else if (access.isError)
    body = (
      <Failure
        heading="We could not check what you may do"
        error={access.error}
        onRetry={() => void access.refetch()}
      />
    );
  else if (!canRead) body = <ApForbidden />;
  else if (company.isError || !company.company)
    body = (
      <Failure
        heading="We could not find your company"
        error={company.error}
        onRetry={() => void company.refetch()}
      />
    );
  else if (list.isPending) body = <Loading what="bills" />;
  else if (list.isError)
    body = (
      <Failure
        heading="We could not load the bills"
        error={list.error}
        onRetry={() => void list.refetch()}
      />
    );
  else if (list.data.bills.length === 0)
    body = (
      <Empty heading="No bills yet">
        Bills appear here when suppliers email them in or someone enters one.
      </Empty>
    );
  else
    body = (
      <div className="admin-block">
        <table className="admin-table" aria-label="Bills">
          <thead>
            <tr>
              <th scope="col">Dated</th>
              <th scope="col">Bill</th>
              <th scope="col">Status</th>
              <th scope="col">Who acts next</th>
              <th scope="col">Due</th>
              <th scope="col" className="num">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {list.data.bills.map((b) => {
              const st = billStatus(b);
              return (
                <tr key={b.id}>
                  <td data-label="Dated">{b.bill_date}</td>
                  <td data-label="Bill">
                    <Link to="/purchases/bills/$billId" params={{ billId: b.id }}>
                      {billName(b)}
                    </Link>
                  </td>
                  <td data-label="Status">
                    <span className="word" data-status={st.key}>
                      {st.word}
                    </span>
                  </td>
                  <td data-label="Who acts next">{nextTurn(b)}</td>
                  <td data-label="Due">{b.due_date}</td>
                  <td data-label="Total" className="num">
                    <Money value={b.gross} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );

  return (
    <>
      <PageHead
        title="Bills"
        gloss="What suppliers have billed you (accounts payable): drafts, bills waiting for approval and posted bills."
      />
      {canRead && access.can('ap.bill.enter') ? (
        <p className="admin-note">
          <Link to="/purchases/bills/new" className="primary">
            Enter a bill
          </Link>
        </p>
      ) : null}
      {body}
    </>
  );
}
