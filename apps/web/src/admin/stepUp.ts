/**
 * Step-up re-authentication (design §6.2, ADR-0025): a route that needs a fresh MFA sign-in
 * answers `401 {error:'step_up_required', max_age}`. The browser leaves the app for the API's
 * `/auth/step-up`, which sends it to the identity provider and back to `return_to`.
 */
export const DEFAULT_STEP_UP_MAX_AGE = 300;
export const MAX_STEP_UP_MAX_AGE = 3600;

export function stepUpUrl(apiBase: string, maxAge: unknown, returnTo: string): string {
  const age =
    typeof maxAge === 'number' &&
    Number.isInteger(maxAge) &&
    maxAge >= 1 &&
    maxAge <= MAX_STEP_UP_MAX_AGE
      ? maxAge
      : DEFAULT_STEP_UP_MAX_AGE;
  // Same-origin path only (the API refuses anything else too: open-redirect guard).
  const back = /^\/(?![/\\])/.test(returnTo) ? returnTo : '/';
  const q = new URLSearchParams({ max_age: String(age), return_to: back });
  return `${apiBase}/auth/step-up?${q.toString()}`;
}
