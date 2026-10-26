/**
 * SS-PLAT-91 (unit) — failure classification and the dead-letter output contract of the Sync
 * issues inbox (T-0071, RQ-0044): permanent means `retryable === false`; the summary is
 * secret-free and bounded; only our `{ handler, failureId }` output is trusted.
 */
import { describe, expect, it } from 'vitest';
import {
  connectorOf,
  describeFailure,
  isPermanentFailure,
  parseFailureOutput,
  UNKNOWN_HANDLER,
} from './sync-issues.ts';

class ConnectorError extends Error {
  readonly kind: string;
  readonly status: number | null;
  readonly errorCode: string | null;
  readonly retryable: boolean;
  constructor(kind: string, status: number | null, errorCode: string | null, retryable: boolean) {
    super(`connector failed (${kind})`);
    this.name = 'ConnectorError';
    this.kind = kind;
    this.status = status;
    this.errorCode = errorCode;
    this.retryable = retryable;
  }
}

describe('SS-PLAT-91 failure classification', () => {
  it('SS-PLAT-91 only an error that says retryable: false is permanent', () => {
    expect(isPermanentFailure(new ConnectorError('rejected', 400, 'INVALID_FIELD', false))).toBe(
      true,
    );
    expect(isPermanentFailure(new ConnectorError('unavailable', 503, null, true))).toBe(false);
    expect(isPermanentFailure(new Error('boom'))).toBe(false);
    expect(isPermanentFailure({ retryable: 'no' })).toBe(false);
    expect(isPermanentFailure(null)).toBe(false);
    expect(isPermanentFailure('text')).toBe(false);
  });

  it('SS-PLAT-91 describeFailure keeps name, kind, code, status, retryable and a bounded message', () => {
    expect(describeFailure(new ConnectorError('rejected', 400, 'INVALID_FIELD', false))).toEqual({
      errorName: 'ConnectorError',
      errorKind: 'rejected',
      errorCode: 'INVALID_FIELD',
      httpStatus: 400,
      retryable: false,
      message: 'connector failed (rejected)',
    });
    expect(describeFailure(new Error('x'.repeat(5000))).message).toHaveLength(1000);
    expect(describeFailure('plain text')).toEqual({
      errorName: 'Error',
      errorKind: null,
      errorCode: null,
      httpStatus: null,
      retryable: true,
      message: 'plain text',
    });
    // Values that would break the table's checks are dropped, not stored.
    const odd = Object.assign(new Error('odd'), {
      name: 'bad name!',
      kind: 'Bad Kind',
      status: 42,
    });
    expect(describeFailure(odd)).toMatchObject({
      errorName: 'Error',
      errorKind: null,
      httpStatus: null,
    });
    expect(
      describeFailure(Object.assign(new Error('e'), { errorCode: 'C'.repeat(300) })).errorCode,
    ).toHaveLength(200);
  });

  it('SS-PLAT-91 parseFailureOutput accepts only { handler, failureId }', () => {
    const failureId = '01900000-0000-7000-8000-000000000001';
    expect(parseFailureOutput({ handler: 'salesforce.writeback', failureId })).toEqual({
      handler: 'salesforce.writeback',
      failureId,
    });
    expect(parseFailureOutput({ message: 'boom', stack: '…' })).toBeNull();
    expect(parseFailureOutput({ handler: 'Bad Handler', failureId })).toBeNull();
    expect(parseFailureOutput({ handler: 'a.b', failureId: 'nope' })).toBeNull();
    expect(parseFailureOutput(null)).toBeNull();
    expect(connectorOf('salesforce.writeback')).toBe('salesforce');
    expect(connectorOf(UNKNOWN_HANDLER)).toBe('outbox');
  });
});
