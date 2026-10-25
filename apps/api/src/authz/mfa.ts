import { ForbiddenException, UnauthorizedException } from '@nestjs/common';

/**
 * MFA and step-up rules (design §6.2, ADR-0025, RQ-0027). Pure functions; TenantInterceptor
 * applies them after the session is verified, and the step-up callback uses `isMfa` too.
 */

/** RFC 8176 `amr` values accepted as proof of more than one factor (RQ-0027 finding 1). */
export const MFA_AMR: readonly string[] = Object.freeze(['mfa', 'otp', 'hwk']);
/** The `acr` the self-host realm maps to its MFA level; deployments may configure others. */
export const DEFAULT_MFA_ACR = 'urn:ledgerforce:loa:mfa';
/** Maximum age of a step-up when a route does not name one (ADR-0025). */
export const DEFAULT_STEP_UP_MAX_AGE_SECONDS = 300;
export const MAX_STEP_UP_MAX_AGE_SECONDS = 3600;
/** An IdP clock slightly ahead of ours is tolerated; a far-future auth_time is not. */
export const AUTH_TIME_SKEW_MS = 60_000;

export interface MfaPolicy {
  /** `acr` values that mean MFA in this deployment; the first is sent as `acr_values` at step-up. */
  acrValues: readonly string[];
}
export const defaultMfaPolicy: MfaPolicy = Object.freeze({ acrValues: [DEFAULT_MFA_ACR] });

export interface AuthenticationFacts {
  amr: readonly string[];
  acr: string | null;
}

export function isMfa(a: AuthenticationFacts, policy: MfaPolicy): boolean {
  if (a.amr.some((m) => MFA_AMR.includes(m))) return true;
  return a.acr !== null && policy.acrValues.includes(a.acr);
}

/** Step-up holds when the session is MFA and its last authentication is at most `maxAge` old. */
export function stepUpSatisfied(
  a: AuthenticationFacts & { authTime: Date | null },
  maxAgeSeconds: number,
  now: Date,
  policy: MfaPolicy,
): boolean {
  if (!isMfa(a, policy) || a.authTime === null) return false;
  const age = now.getTime() - a.authTime.getTime();
  return age <= maxAgeSeconds * 1000 && age >= -AUTH_TIME_SKEW_MS;
}

export function isValidMaxAge(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= MAX_STEP_UP_MAX_AGE_SECONDS;
}

/** 403 `{error:'mfa_required'}`: a finance role on a permission route without MFA. */
export class MfaRequired extends ForbiddenException {
  constructor() {
    super({ error: 'mfa_required' });
  }
}

/** 401 `{error:'step_up_required', max_age}`: the client should start `/auth/step-up` (RFC 9470 idea). */
export class StepUpRequired extends UnauthorizedException {
  constructor(readonly maxAge: number) {
    super({ error: 'step_up_required', max_age: maxAge });
  }
}
