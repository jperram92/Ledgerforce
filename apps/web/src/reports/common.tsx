/**
 * Shared parts of the report screens (T-0089): the access and company gate, the filter bar with
 * its one primary action ("Show report") and the CSV download, and the refusal state. Totals and
 * balanced flags always come from the API.
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { Forbidden, Loading, useAccess, useFailureRouting } from '../admin/common.tsx';
import { useServices } from '../env.tsx';
import type { ReportCompany } from './client.ts';
import { download, readersOf, reportMessage } from './logic.ts';

export function ReportFailure({
  heading,
  error,
  onRetry,
}: {
  heading: string;
  error: unknown;
  onRetry: () => void;
}) {
  return (
    <div className="admin-state" role="alert">
      <h2>{heading}</h2>
      <p>{reportMessage(error)}</p>
      <button type="button" className="secondary" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

/**
 * Who may see the report and which company it is for. `blocked` is the state to show instead
 * of the report (loading, forbidden, failure); otherwise `company` is set.
 */
export function useReportGate(
  permission: string,
  what: string,
): { blocked: ReactNode; company: ReportCompany | undefined } {
  const access = useAccess();
  const { reports } = useServices();
  const allowed = access.can(permission);
  const companies = useQuery({
    queryKey: ['companies'],
    queryFn: () => reports.companies(),
    enabled: allowed,
  });
  useFailureRouting(companies.error);
  const company = companies.data?.[0];
  let blocked: ReactNode = null;
  if (access.isPending) blocked = <Loading what="your access" />;
  else if (access.isError)
    blocked = (
      <ReportFailure
        heading="We could not check what you may do"
        error={access.error}
        onRetry={() => void access.refetch()}
      />
    );
  else if (!allowed)
    blocked = (
      <Forbidden heading={`You can't see ${what}`}>
        You do not have access to {what}. {readersOf(permission)} can see it; ask your Owner if you
        need to.
      </Forbidden>
    );
  else if (companies.isPending) blocked = <Loading what="your company" />;
  else if (companies.isError || !company)
    blocked = (
      <ReportFailure
        heading="We could not find your company"
        error={companies.error}
        onRetry={() => void companies.refetch()}
      />
    );
  return { blocked, company: blocked ? undefined : company };
}

/** The loading / refused state of a report query, or null once it has data. */
export function queryState(q: UseQueryResult, what: string): ReactNode {
  if (q.isPending) return <Loading what={what} />;
  if (q.isError)
    return (
      <ReportFailure
        heading={`We could not show ${what}`}
        error={q.error}
        onRetry={() => void q.refetch()}
      />
    );
  return null;
}

export interface DateField {
  name: string;
  label: string;
  value: string;
  hint?: string;
  required?: boolean;
}

/**
 * The filter bar: date fields (and any extra controls), "Show report" and, once figures are
 * shown, "Download CSV". Submitting hands the entered values back; the page puts them in the URL.
 */
export function ReportFilters({
  fields,
  extra,
  onShow,
  csv,
}: {
  fields: DateField[];
  extra?: ReactNode;
  onShow: (values: Record<string, string>) => void;
  csv?: { fileName: string; content: () => string } | undefined;
}) {
  const base = useId();
  const [values, setValues] = useState(() =>
    Object.fromEntries(fields.map((f) => [f.name, f.value])),
  );
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const extraValues = Object.fromEntries(
      [...new FormData(e.currentTarget).entries()].filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string' && !(entry[0] in values),
      ),
    );
    onShow({ ...extraValues, ...values });
  };
  return (
    <form className="admin-filters report-bar" aria-label="Report dates" onSubmit={submit}>
      {fields.map((f) => (
        <div className="field" key={f.name}>
          <label htmlFor={`${base}-${f.name}`}>{f.label}</label>
          <input
            id={`${base}-${f.name}`}
            type="date"
            value={values[f.name] ?? ''}
            required={f.required ?? true}
            aria-describedby={f.hint ? `${base}-${f.name}-hint` : undefined}
            onChange={(e) => {
              setValues((v) => ({ ...v, [f.name]: e.target.value }));
            }}
          />
          {f.hint ? (
            <span className="report-hint" id={`${base}-${f.name}-hint`}>
              {f.hint}
            </span>
          ) : null}
        </div>
      ))}
      {extra}
      <div className="actions">
        <button type="submit" className="primary">
          Show report
        </button>
        {csv ? (
          <button
            type="button"
            className="secondary"
            onClick={() => {
              download(csv.fileName, csv.content());
            }}
          >
            Download CSV
          </button>
        ) : null}
      </div>
    </form>
  );
}

/** One line under the heading: the company, the dates and the currency of every figure. */
export function ReportScope({ children }: { children: ReactNode }) {
  return <p className="admin-note report-scope">{children}</p>;
}
