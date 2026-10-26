/** Injection token for the Kysely instance (lf_app pool). */
export const DB = Symbol('DB');
/** Injection token for the request clock (sessions' clock; tests inject one). */
export const CLOCK = Symbol('CLOCK');
/** Injection token for the MFA policy (ADR-0025: which acr values mean MFA). */
export const MFA_POLICY = Symbol('MFA_POLICY');
/** Injection token for the key service sealing bank details (ADR-0018); null when not configured. */
export const KMS = Symbol('KMS');
/** Injection token for the outbox re-queue of the Sync issues retry (T-0071); null without a queue. */
export const SYNC_REQUEUE = Symbol('SYNC_REQUEUE');
