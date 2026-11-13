/**
 * Bills inbox (T-0136, UC-05, SS-UC05-09): the bills suppliers emailed in (T-0051), newest first,
 * with the sender, the supplier the sender address suggests, the PDF to download (RQ-0148: a
 * download, never shown inside the app) and the state in words (P2). Readers: ap.read. Coding an
 * item into a draft bill needs ap.bill.enter (AP Clerks, Owners); it uses the bill entry form
 * (T-0086) and POST /ap/inbox/:id/code with a bill id and an idempotency key chosen once per form.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import {
  Empty,
  Failure,
  Forbidden,
  Loading,
  PageHead,
  useAccess,
  useFailureRouting,
} from '../admin/common.tsx';
import { timeLabel } from '../admin/dates.ts';
import { useServices } from '../env.tsx';
import { BillEditor } from './BillFormPage.tsx';
import { ApForbidden, useApCompany } from './BillsPage.tsx';
import type { InboxItem } from './client.ts';
import { fileSize, inboxStatus } from './inbox-logic.ts';

const ENTERERS = 'AP Clerks and Owners code emailed bills';

function useInbox(companyId: string, enabled: boolean) {
  const { purchases } = useServices();
  return useQuery({
    queryKey: ['ap', 'inbox', companyId],
    queryFn: () => purchases.inbox(companyId),
    enabled: enabled && !!companyId,
  });
}

function Pdfs({ companyId, item }: { companyId: string; item: InboxItem }) {
  const { purchases } = useServices();
  if (item.attachments.length === 0) return <>No PDF</>;
  return (
    <ul className="inbox-pdfs">
      {item.attachments.map((a) => (
        <li key={a.n}>
          <a href={purchases.attachmentUrl(companyId, item.id, a.n)} download={a.file_name}>
            {`Download ${a.file_name} (${fileSize(a.size_bytes)})`}
          </a>
        </li>
      ))}
    </ul>
  );
}

const subjectOf = (i: InboxItem) => i.subject ?? '(no subject)';

export function InboxPage() {
  const access = useAccess();
  const canRead = access.can('ap.read');
  const canEnter = access.can('ap.bill.enter');
  const company = useApCompany();
  const companyId = company.company?.id ?? '';
  const inbox = useInbox(companyId, canRead);
  useFailureRouting(inbox.error ?? company.error);

  let body;
  if (access.isPending || (canRead && company.isPending)) body = <Loading what="the inbox" />;
  else if (access.isError)
    body = (
      <Failure
        heading="We could not check what you may do"
        error={access.error}
        onRetry={() => void access.refetch()}
      />
    );
  else if (!canRead) body = <ApForbidden />;
  else if (company.isError || !companyId)
    body = (
      <Failure
        heading="We could not find your company"
        error={company.error}
        onRetry={() => void company.refetch()}
      />
    );
  else if (inbox.isPending) body = <Loading what="the inbox" />;
  else if (inbox.isError)
    body = (
      <Failure
        heading="We could not load the inbox"
        error={inbox.error}
        onRetry={() => void inbox.refetch()}
      />
    );
  else if (inbox.data.items.length === 0)
    body = (
      <Empty heading="No emailed bills yet">
        Bills appear here when suppliers email them to your bills address.
      </Empty>
    );
  else
    body = (
      <div className="admin-block">
        {canEnter ? null : (
          <p className="admin-note">{ENTERERS}; you can read them and download the PDFs.</p>
        )}
        <table className="admin-table" aria-label="Emailed bills">
          <thead>
            <tr>
              <th scope="col">Received</th>
              <th scope="col">From</th>
              <th scope="col">Supplier</th>
              <th scope="col">PDF</th>
              <th scope="col">Status</th>
              <th scope="col">Next</th>
            </tr>
          </thead>
          <tbody>
            {inbox.data.items.map((i) => {
              const st = inboxStatus(i.status);
              return (
                <tr key={i.id}>
                  <td data-label="Received">{timeLabel(i.received_at)}</td>
                  <td data-label="From">
                    <span className="inbox-from">{i.from_address ?? 'Unknown sender'}</span>
                    <br />
                    {subjectOf(i)}
                  </td>
                  <td data-label="Supplier">
                    {i.supplier_name ?? 'Not matched: choose one when coding'}
                  </td>
                  <td data-label="PDF">
                    <Pdfs companyId={companyId} item={i} />
                  </td>
                  <td data-label="Status">
                    <span className="word" data-status={st.key}>
                      {st.word}
                    </span>
                  </td>
                  <td data-label="Next">
                    <NextStep item={i} canEnter={canEnter} />
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
        title="Bills inbox"
        gloss="Bills suppliers emailed in. Download the PDF, then code it into a draft bill; nothing is posted until an Approver approves it."
      />
      {body}
      <p className="admin-note">
        <Link to="/purchases/bills">All bills</Link>
      </p>
    </>
  );
}

function NextStep({ item, canEnter }: { item: InboxItem; canEnter: boolean }) {
  const { purchases } = useServices();
  const company = useApCompany();
  const bills = useQuery({
    queryKey: ['ap', 'bills', company.company?.id ?? ''],
    queryFn: () => purchases.bills(company.company?.id ?? ''),
    enabled: item.status === 'coded' && !!company.company,
  });
  if (item.status === 'coded' && item.bill_id) {
    const billId = item.bill_id;
    const bill = bills.data?.bills.find((b) => b.id === billId);
    const name = bill ? (bill.bill_no ?? `draft ${bill.supplier_ref}`) : 'the draft';
    return (
      <Link to="/purchases/bills/$billId" params={{ billId }}>
        {`Open bill ${name}`}
      </Link>
    );
  }
  if (item.status === 'new')
    return canEnter ? (
      <Link to="/purchases/inbox/$itemId" params={{ itemId: item.id }}>
        {`Code ${subjectOf(item)}`}
      </Link>
    ) : (
      <>An AP Clerk codes it</>
    );
  if (item.status === 'no_attachment') return <>Ask the supplier for the PDF</>;
  return <>Nothing</>;
}

export function InboxCodePage({ itemId }: { itemId: string }) {
  const access = useAccess();
  const { purchases } = useServices();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const canEnter = access.can('ap.bill.enter');
  const company = useApCompany();
  const companyId = company.company?.id ?? '';
  const inbox = useInbox(companyId, canEnter);
  const coding = useQuery({
    queryKey: ['ap', 'bill-coding', companyId],
    queryFn: () => purchases.coding(companyId),
    enabled: canEnter && !!companyId,
  });
  const [key] = useState(() => crypto.randomUUID());
  useFailureRouting(inbox.error ?? coding.error ?? company.error);
  const item = inbox.data?.items.find((i) => i.id === itemId);

  let body;
  if (access.isPending || (canEnter && (company.isPending || inbox.isPending || coding.isPending)))
    body = <Loading what="the emailed bill" />;
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
        {ENTERERS}. Approvers approve bills someone else entered, so one person never does both.
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
  else if (inbox.isError || coding.isError || !inbox.data || !coding.data)
    body = (
      <Failure
        heading="We could not load the emailed bill"
        error={inbox.error ?? coding.error}
        onRetry={() => {
          void inbox.refetch();
          void coding.refetch();
        }}
      />
    );
  else if (!item)
    body = (
      <Empty heading="This emailed bill is not in your inbox">
        It may belong to another company. Go back to the inbox and choose one from the list.
      </Empty>
    );
  else if (item.status !== 'new')
    body = (
      <Empty heading="Nothing to code">
        {item.status === 'coded'
          ? 'This email is already coded into a bill. Open the bill from the inbox.'
          : 'This email has no PDF bill attached. Ask the supplier to send the PDF.'}
      </Empty>
    );
  else
    body = (
      <>
        <section className="admin-block" aria-labelledby="inbox-email-h">
          <h2 id="inbox-email-h">The email</h2>
          <p>
            {`From ${item.from_address ?? 'an unknown sender'}, received ${timeLabel(item.received_at)}`}
          </p>
          <p>{subjectOf(item)}</p>
          <Pdfs companyId={companyId} item={item} />
          <p className="admin-note">
            {item.supplier_name
              ? `The sender is a contact of ${item.supplier_name}, so that supplier is chosen. Change it if the bill is from someone else.`
              : 'The sender is not a contact of any supplier. Choose the supplier.'}
          </p>
        </section>
        <BillEditor
          companyId={companyId}
          coding={coding.data}
          initialPartyId={item.party_id ?? ''}
          save={(billId, b) => purchases.code(item.id, key, { ...b, bill_id: billId })}
          onSaved={async (billId) => {
            await queryClient.invalidateQueries({ queryKey: ['ap'] });
            await navigate({ to: '/purchases/bills', search: { coded: billId } });
          }}
          cancel={{ to: '/purchases/inbox', text: 'Back to the inbox without saving' }}
        />
      </>
    );

  return (
    <>
      <PageHead
        title="Code an emailed bill"
        gloss="Copy the supplier's tax invoice from the PDF and say what each line was for. Nothing is posted until an Approver approves it."
      />
      {body}
    </>
  );
}
