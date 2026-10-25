/** Injection token for the Kysely instance (lf_app pool). */
export const DB = Symbol('DB');
/** Injection token for the request clock (sessions' clock; tests inject one). */
export const CLOCK = Symbol('CLOCK');
/** Injection token for the MFA policy (ADR-0025: which acr values mean MFA). */
export const MFA_POLICY = Symbol('MFA_POLICY');
