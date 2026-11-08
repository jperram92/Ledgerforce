import { describe, expect, it } from 'vitest';
import { err, isErr, isOk, mapResult, ok, unwrap, type Result } from './result.ts';
import { DomainError } from './errors.ts';

describe('Result', () => {
  it('ok/err discriminate', () => {
    const a: Result<number, string> = ok(1);
    const b: Result<number, string> = err('nope');
    expect(isOk(a)).toBe(true);
    expect(isErr(b)).toBe(true);
    if (a.ok) expect(a.value).toBe(1);
    if (!b.ok) expect(b.error).toBe('nope');
  });

  it('maps only the ok branch', () => {
    expect(mapResult(ok(2), (n: number) => n * 3)).toEqual(ok(6));
    expect(mapResult(err('x') as Result<number, string>, (n: number) => n * 3)).toEqual(err('x'));
  });

  it('unwrap returns the value or throws the error', () => {
    expect(unwrap(ok('v'))).toBe('v');
    const e = new DomainError('SOME_CODE', 'boom');
    expect(() => unwrap(err(e))).toThrow(e);
  });
});

describe('DomainError', () => {
  it('carries a stable machine-readable code', () => {
    const e = new DomainError('PERIOD_LOCKED', 'Period is locked');
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('PERIOD_LOCKED');
    expect(e.name).toBe('DomainError');
  });
});
