import { withTenant, type Database } from '@ledgerforce/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import * as client from 'openid-client';
import { defaultMfaPolicy, isMfa, type MfaPolicy } from '../authz/mfa.ts';
import {
  parseSessionCookie,
  SessionError,
  systemClock,
  type Clock,
  type Principal,
  type SessionService,
} from './session.service.ts';

/** ADR-0016: the pre-auth record lives 10 minutes and is used once. */
export const AUTH_REQUEST_TTL_SECONDS = 10 * 60;

export interface OidcOptions {
  /** Issuer URL; the configuration comes from its discovery document. */
  issuer: string;
  clientId: string;
  /** Confidential client secret, from the environment or a secret store (never committed). */
  clientSecret: string;
  /** Public base URL of this API; the redirect URI is `<publicUrl>/auth/callback`. Defaults to the listen URL. */
  publicUrl?: string;
  /** Tests only: allows an http:// issuer (openid-client refuses it otherwise). */
  allowInsecureIssuer?: boolean;
}

export type LoginFailure =
  | 'not_found'
  | 'invalid_request'
  | 'login_failed'
  | 'not_invited'
  /** Step-up (ADR-0025): the IdP authenticated a different user than the session's. */
  | 'step_up_mismatch'
  /** Step-up (ADR-0025): the IdP's answer shows no MFA. */
  | 'mfa_required';

export class LoginError extends Error {
  constructor(readonly reason: LoginFailure) {
    super(reason);
    this.name = 'LoginError';
  }
}

/** What the callback did: a login made a new session; a step-up refreshed the existing one. */
export type CallbackResult =
  { kind: 'login'; cookie: string } | { kind: 'step_up'; returnTo: string };

/** Request facts for the login audit row. */
export interface LoginContext {
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

const SLUG = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/; // openid-client randomState(): 32 bytes, base64url

/** `lf_oidc=<tenant_id>.<state>`: names the tenant; the row under that tenant's RLS proves it. */
export function parseOidcCookie(
  value: string | undefined,
): { tenantId: string; state: string } | null {
  const parts = (value ?? '').split('.');
  if (parts.length !== 2) return null;
  const [tenantId = '', state = ''] = parts;
  if (!UUID.test(tenantId) || !TOKEN.test(state)) return null;
  return { tenantId, state };
}

/**
 * OIDC relying party (ADR-0016, RQ-0020): authorization code + PKCE S256 + state + nonce.
 * The tenant comes from the login URL's slug; everything after the slug lookup runs under that
 * tenant's RLS. Users must have been invited with (idp_issuer, idp_subject); no JIT accounts.
 */
export class OidcService {
  private config: Promise<client.Configuration> | undefined;

  constructor(
    private readonly db: Kysely<Database>,
    private readonly sessions: SessionService,
    private readonly opts: OidcOptions,
    private readonly publicUrl: () => string,
    private readonly clock: Clock = systemClock,
    private readonly mfa: MfaPolicy = defaultMfaPolicy,
  ) {}

  get redirectUri(): string {
    return `${this.publicUrl()}/auth/callback`;
  }

  /** Cookies get `Secure` whenever the public URL is https. */
  get secureCookies(): boolean {
    return this.publicUrl().startsWith('https:');
  }

  /** Discovery on first use (the API starts even if the IdP is briefly down); retried after a failure. */
  private configuration(): Promise<client.Configuration> {
    this.config ??= client
      .discovery(
        new URL(this.opts.issuer),
        this.opts.clientId,
        this.opts.clientSecret,
        undefined,
        this.opts.allowInsecureIssuer ? { execute: [client.allowInsecureRequests] } : undefined,
      )
      .catch((error: unknown) => {
        this.config = undefined;
        throw error;
      });
    return this.config;
  }

  /** Step 1: returns the IdP authorization URL and the `lf_oidc` cookie value. */
  async begin(slug: string): Promise<{ location: string; cookie: string }> {
    if (!SLUG.test(slug)) throw new LoginError('not_found');
    const found = await sql<{
      id: string | null;
    }>`SELECT app.tenant_id_for_slug(${slug}) AS id`.execute(this.db);
    const tenantId = found.rows[0]?.id ?? null;
    if (!tenantId) throw new LoginError('not_found');

    const config = await this.configuration();
    return withTenant(this.db, tenantId, (trx) => this.authorize(trx, tenantId, config, null));
  }

  /**
   * Step-up (ADR-0025, RQ-0027): a new authorization request for the signed-in `principal`,
   * inside the request's tenant transaction. It asks the IdP to re-authenticate now
   * (`prompt=login`, `max_age`) with MFA (`acr_values`); the callback checks the answer itself.
   */
  async beginStepUp(
    trx: Transaction<Database>,
    principal: Principal,
    opts: { maxAgeSeconds: number; returnTo: string },
  ): Promise<{ location: string; cookie: string }> {
    const config = await this.configuration();
    return this.authorize(trx, principal.tenantId, config, {
      sessionId: principal.sessionId,
      ...opts,
    });
  }

  /** Stores the pre-auth row (state, nonce, PKCE verifier; step-up link) and builds the IdP URL. */
  private async authorize(
    trx: Transaction<Database>,
    tenantId: string,
    config: client.Configuration,
    stepUp: { sessionId: string; maxAgeSeconds: number; returnTo: string } | null,
  ): Promise<{ location: string; cookie: string }> {
    const state = client.randomState();
    const nonce = client.randomNonce();
    const verifier = client.randomPKCECodeVerifier();
    const now = this.clock.now();
    await trx
      .insertInto('app.auth_request')
      .values({
        state,
        nonce,
        code_verifier: verifier,
        created_at: now,
        expires_at: new Date(now.getTime() + AUTH_REQUEST_TTL_SECONDS * 1000),
        session_id: stepUp?.sessionId ?? null,
        max_age_seconds: stepUp?.maxAgeSeconds ?? null,
        return_to: stepUp?.returnTo ?? null,
      })
      .execute();
    const acrValues = this.mfa.acrValues[0];
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: this.redirectUri,
      scope: 'openid',
      state,
      nonce,
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      ...(stepUp
        ? {
            prompt: 'login',
            max_age: String(stepUp.maxAgeSeconds),
            ...(acrValues ? { acr_values: acrValues } : {}),
          }
        : {}),
    });
    return { location: url.href, cookie: `${tenantId}.${state}` };
  }

  /**
   * Step 2: the IdP redirected back to `/auth/callback` (`callbackUrl` = redirect URI + query).
   * Order: browser binding → single-use consume of the pre-auth row (unexpired) → code exchange
   * with PKCE verifier, state and nonce (and, for a step-up, `maxAge` on `auth_time`) → then
   * either a login (invited user by (iss, sub) → session + audit row in one transaction) or a
   * step-up of the session named by the row (`sessionCookie` must be that session, the user
   * the same, the answer MFA → the session's auth_time/amr/acr updated + audit row).
   */
  async complete(
    oidcCookie: string | undefined,
    callbackUrl: URL,
    ctx: LoginContext,
    sessionCookie?: string,
  ): Promise<CallbackResult> {
    const bound = parseOidcCookie(oidcCookie);
    const state = callbackUrl.searchParams.get('state');
    if (!bound || state !== bound.state) throw new LoginError('invalid_request');
    const { tenantId } = bound;

    const now = this.clock.now();
    const pending = await withTenant(this.db, tenantId, (trx) =>
      trx
        .updateTable('app.auth_request')
        .set({ consumed_at: now })
        .where('state', '=', state)
        .where('consumed_at', 'is', null)
        .where('expires_at', '>', now)
        .returning(['nonce', 'code_verifier', 'session_id', 'max_age_seconds', 'return_to'])
        .executeTakeFirst(),
    );
    if (!pending) throw new LoginError('invalid_request');
    const stepUp =
      pending.session_id !== null && pending.max_age_seconds !== null
        ? {
            sessionId: pending.session_id,
            maxAge: pending.max_age_seconds,
            returnTo: pending.return_to ?? '/',
          }
        : null;

    let claims: client.IDToken | undefined;
    try {
      const tokens = await client.authorizationCodeGrant(await this.configuration(), callbackUrl, {
        pkceCodeVerifier: pending.code_verifier,
        expectedState: state,
        expectedNonce: pending.nonce,
        idTokenExpected: true,
        // Step-up: openid-client requires auth_time and rejects it if older than max_age (RQ-0027).
        ...(stepUp ? { maxAge: stepUp.maxAge } : {}),
      });
      claims = tokens.claims();
    } catch {
      throw new LoginError('login_failed');
    }
    if (!claims) throw new LoginError('login_failed');
    const amr = Array.isArray(claims.amr)
      ? claims.amr.filter((m): m is string => typeof m === 'string')
      : [];
    const acr = typeof claims.acr === 'string' ? claims.acr : null;
    const authTime =
      typeof claims.auth_time === 'number' ? new Date(claims.auth_time * 1000) : null;
    const { iss, sub } = claims;

    if (stepUp) {
      const auth = { amr, acr, authTime };
      await this.completeStepUp(tenantId, stepUp.sessionId, sessionCookie, { iss, sub }, auth, ctx);
      return { kind: 'step_up', returnTo: stepUp.returnTo };
    }

    const cookie = await withTenant(this.db, tenantId, async (trx) => {
      const user = await trx
        .selectFrom('app.app_user')
        .select(['id', 'status'])
        .where('idp_issuer', '=', iss)
        .where('idp_subject', '=', sub)
        .executeTakeFirst();
      if (!user || user.status === 'disabled') throw new LoginError('not_invited');
      const activated = user.status === 'invited';
      if (activated) {
        // First login completes the invitation (design §6.3 joiner flow).
        await trx
          .updateTable('app.app_user')
          .set({ status: 'active' })
          .where('id', '=', user.id)
          .execute();
      }
      const session = await this.sessions.createInTx(trx, tenantId, {
        userId: user.id,
        amr,
        acr,
        authTime,
      });
      await trx
        .insertInto('audit.audit_log')
        .values({
          actor_type: 'user',
          actor_user_id: user.id,
          action: 'login',
          entity_type: 'session',
          entity_id: session.sessionId,
          before: null,
          after: JSON.stringify({ amr, acr, activated }),
          ip: ctx.ip,
          user_agent: ctx.userAgent,
          request_id: ctx.requestId,
        })
        .execute();
      return session.cookie;
    });
    return { kind: 'login', cookie };
  }

  /**
   * The step-up half of the callback. The browser must still present the session the step-up was
   * started for (a valid one); the IdP must have authenticated that same user, with MFA. Only then
   * the session's authentication facts change. A wrong user or a non-MFA answer is refused and
   * audited, with the session untouched.
   */
  private async completeStepUp(
    tenantId: string,
    sessionId: string,
    sessionCookie: string | undefined,
    idp: { iss: string; sub: string },
    auth: { amr: string[]; acr: string | null; authTime: Date | null },
    ctx: LoginContext,
  ): Promise<void> {
    const cookie = parseSessionCookie(sessionCookie);
    if (!cookie || cookie.tenantId !== tenantId || cookie.sessionId !== sessionId) {
      throw new LoginError('invalid_request');
    }
    const refused = await withTenant(this.db, tenantId, async (trx) => {
      let principal: Principal;
      try {
        principal = await this.sessions.verify(trx, cookie);
      } catch (e) {
        if (e instanceof SessionError) return 'invalid_request' as const;
        throw e;
      }
      const user = await trx
        .selectFrom('app.app_user')
        .select('id')
        .where('idp_issuer', '=', idp.iss)
        .where('idp_subject', '=', idp.sub)
        .executeTakeFirst();
      const reason: LoginFailure | null =
        user?.id !== principal.userId
          ? 'step_up_mismatch'
          : !isMfa(auth, this.mfa) || auth.authTime === null
            ? 'mfa_required'
            : null;
      const audit = (action: string, after: unknown) =>
        trx
          .insertInto('audit.audit_log')
          .values({
            actor_type: 'user',
            actor_user_id: principal.userId,
            action,
            entity_type: 'session',
            entity_id: sessionId,
            before: null,
            after: JSON.stringify(after),
            ip: ctx.ip,
            user_agent: ctx.userAgent,
            request_id: ctx.requestId,
          })
          .execute();
      if (reason) {
        await audit('step_up_refused', { reason });
        return reason;
      }
      await this.sessions.reauthenticateInTx(trx, sessionId, {
        amr: auth.amr,
        acr: auth.acr,
        authTime: auth.authTime,
      });
      await audit('step_up', {
        amr: auth.amr,
        acr: auth.acr,
        auth_time: auth.authTime?.toISOString() ?? null,
      });
      return null;
    });
    if (refused) throw new LoginError(refused);
  }
}
