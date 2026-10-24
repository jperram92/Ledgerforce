/** Explicit success/failure value for expected failures (no exceptions for control flow). */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export const isOk = <T, E>(r: Result<T, E>): r is { readonly ok: true; readonly value: T } =>
  r.ok;

export const isErr = <T, E>(r: Result<T, E>): r is { readonly ok: false; readonly error: E } =>
  !r.ok;

export const mapResult = <T, U, E>(r: Result<T, E>, f: (t: T) => U): Result<U, E> =>
  r.ok ? ok(f(r.value)) : r;

/** Returns the value, or throws the error (wrapped in an Error if it is not one). */
export const unwrap = <T, E>(r: Result<T, E>): T => {
  if (r.ok) return r.value;
  if (r.error instanceof Error) throw r.error;
  throw new Error(`unwrap() on an error result: ${String(r.error)}`);
};
