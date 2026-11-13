/**
 * Inbound issues → the Sync issues inbox (design §5.6 rule 2; ADR-0006 rule 2; DL-0295).
 *
 * The mapping reports an unmappable change, or an inbound edit of a LedgerForce-owned field, as an
 * outbox event (topic `salesforce.inbound.issue`, aggregate = the processed-change row) written in
 * the mapping's transaction. Its handler `salesforce.inbound` re-runs the mapping: when it now
 * maps (e.g. after the Account arrived or a Family mapping was added) the row is settled and the
 * delivery succeeds; otherwise it throws a permanent `InboundIssueError`, so the outbox worker
 * dead-letters it at once and it lands in the Sync issues inbox with the error and the payload,
 * where "Retry" runs the handler again. A conflict always stays an issue (it can be ignored): the
 * next write-back restores the field. This module needs no outbox import: the message and the
 * handler are plain shapes the worker wires (`enqueue`, `HandlerRegistry`).
 */
import type { Database } from '@ledgerforce/db';
import type { Transaction } from 'kysely';
import type { InboundChange, InboundChangeType } from './inbound-map.ts';

export const SALESFORCE_INBOUND_ISSUE_TOPIC = 'salesforce.inbound.issue';
export const SALESFORCE_INBOUND_HANDLER = 'salesforce.inbound';
export const INBOUND_CHANGE_AGGREGATE = 'salesforce_inbound_change';

export type InboundIssueKind = 'unmappable' | 'conflict';

export interface InboundIssue {
  kind: InboundIssueKind;
  /** UPPER_SNAKE code, e.g. UNKNOWN_ACCOUNT, UNMAPPED_FAMILY, LF_OWNED_FIELD. */
  code: string;
  message: string;
  /** The processed-change row (app.salesforce_inbound_change.id). */
  changeRowId: string;
  /** LedgerForce-owned Salesforce fields the change touched (ignored). */
  conflicts: string[];
  change: InboundChange;
}

/** Writes the issue (in production: `enqueue` of `inboundIssueMessage`); returns the event id. */
export type InboundIssueSink = (trx: Transaction<Database>, issue: InboundIssue) => Promise<string>;

/** Structurally an outbox `OutboxMessage`. */
export interface InboundIssueMessage {
  companyId: string;
  topic: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}

/** JSON-safe copy: bigint → decimal string, Buffer → base64. */
function jsonSafe(v: unknown): unknown {
  return JSON.parse(
    JSON.stringify(v, (_k, x: unknown) =>
      typeof x === 'bigint'
        ? x.toString()
        : x && typeof x === 'object' && (x as { type?: unknown }).type === 'Buffer'
          ? Buffer.from((x as { data: number[] }).data).toString('base64')
          : x,
    ),
  ) as unknown;
}

export function inboundIssueMessage(companyId: string, issue: InboundIssue): InboundIssueMessage {
  return {
    companyId,
    topic: SALESFORCE_INBOUND_ISSUE_TOPIC,
    aggregateType: INBOUND_CHANGE_AGGREGATE,
    aggregateId: issue.changeRowId,
    payload: {
      version: 1,
      kind: issue.kind,
      code: issue.code,
      message: issue.message,
      conflicts: issue.conflicts,
      change: jsonSafe(issue.change),
    },
  };
}

export interface InboundIssuePayload {
  kind: InboundIssueKind;
  code: string;
  message: string;
  conflicts: string[];
  change: InboundChange;
}

export function parseInboundIssuePayload(payload: Record<string, unknown>): InboundIssuePayload {
  const c = payload['change'] as Record<string, unknown> | undefined;
  const kind = payload['kind'];
  if (payload['version'] !== 1 || (kind !== 'unmappable' && kind !== 'conflict') || !c) {
    throw new InboundIssueError(
      'unmappable',
      'BAD_ISSUE_PAYLOAD',
      'inbound issue payload is not version 1',
    );
  }
  return {
    kind,
    code: String(payload['code']),
    message: String(payload['message']),
    conflicts: (payload['conflicts'] as string[] | undefined) ?? [],
    change: {
      source: String(c['source']),
      entityName: String(c['entityName']),
      recordId: String(c['recordId']),
      changeType: String(c['changeType']) as InboundChangeType,
      commitNumber: BigInt(String(c['commitNumber'])),
      sequenceNumber: Number(c['sequenceNumber']),
      transactionKey: String(c['transactionKey']),
      commitTimestamp: BigInt(String(c['commitTimestamp'])),
      changedFields: (c['changedFields'] as string[] | undefined) ?? [],
      nulledFields: (c['nulledFields'] as string[] | undefined) ?? [],
      fields: (c['fields'] as Record<string, unknown> | undefined) ?? {},
      ...(c['snapshot'] === true ? { snapshot: true } : {}),
    },
  };
}

/** Permanent (retryable false): the worker dead-letters it into the Sync issues inbox at once. */
export class InboundIssueError extends Error {
  readonly retryable = false;
  readonly kind: InboundIssueKind;
  readonly errorCode: string;
  constructor(kind: InboundIssueKind, code: string, message: string) {
    super(message);
    this.name = 'SalesforceInboundIssue';
    this.kind = kind;
    this.errorCode = code;
  }
}
