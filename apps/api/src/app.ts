import 'reflect-metadata';
import { type DynamicModule, Module, type INestApplication, type Type } from '@nestjs/common';
import { APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import type { Database } from '@ledgerforce/db';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { AddressInfo } from 'node:net';
import { AuthController, SESSION_SERVICE } from './auth/auth.controller.ts';
import { LoginController, OIDC_SERVICE } from './auth/login.controller.ts';
import { OidcService, type OidcOptions } from './auth/oidc.service.ts';
import { ApiTokenService } from './auth/api-token.service.ts';
import { SessionTenantResolver } from './auth/session-tenant-resolver.ts';
import { SessionService, systemClock, type Clock } from './auth/session.service.ts';
import { Authz } from './authz/authz.ts';
import { defaultMfaPolicy, type MfaPolicy } from './authz/mfa.ts';
import { UserRolesController } from './authz/user-roles.controller.ts';
import { SodController } from './sod/sod.controller.ts';
import { ApiTokensController, UserApiTokensController } from './tokens/api-tokens.controller.ts';
import { UsersController } from './users/users.controller.ts';
import { CompaniesController } from './companies/companies.controller.ts';
import { HealthController } from './health/health.controller.ts';
import { PartyBankAccountsController } from './parties/bank-accounts.controller.ts';
import { BankDetailChangesController } from './parties/bank-detail-changes.controller.ts';
import { ManualJournalsController } from './journals/manual-journals.controller.ts';
import type { Kms } from '@ledgerforce/shared/crypto';
import { TenantInterceptor } from './tenancy/tenant.interceptor.ts';
import {
  refuseAllResolver,
  TENANT_RESOLVER,
  type TenantResolver,
} from './tenancy/tenant-resolver.ts';
import { AuditTrail, TenantTx } from './tenancy/tenant-tx.ts';
import { AuditLogController } from './audit/audit-log.controller.ts';
import { requestIdMiddleware } from './audit/request-id.ts';
import { SyncIssuesController } from './sync/sync-issues.controller.ts';
import { CLOCK, DB, KMS, MFA_POLICY, SYNC_REQUEUE } from './tokens.ts';
import type { DeliveryRequeue } from '@ledgerforce/outbox';

export interface ApiOptions {
  /** Connection string for lf_app (never a superuser or the migrator). */
  databaseUrl: string;
  poolSize?: number;
  /** Server-side sessions (ADR-0016). When set, the session resolver is used unless `tenantResolver` is given. */
  sessions?: { clock?: Clock };
  /** OIDC login (ADR-0016, T-0011): GET /t/:slug/auth/login and GET /auth/callback. Needs `sessions`. */
  oidc?: OidcOptions;
  /** MFA policy (ADR-0025): which `acr` values mean MFA here. Default `urn:ledgerforce:loa:mfa`. */
  mfa?: Partial<MfaPolicy>;
  /**
   * Key service that seals bank account numbers (ADR-0018). Without it, routes that store bank
   * details answer 503 `{error:'kms_not_configured'}` (ADR-0030).
   */
  kms?: Kms;
  /**
   * Re-queues an outbox delivery for the Sync issues one-click retry (T-0071), e.g.
   * `bossRequeue(runtime pg-boss)`. Without it, POST /sync-issues/:id/retry answers 503
   * `{error:'queue_not_configured'}`.
   */
  syncRequeue?: DeliveryRequeue;
  /** Explicit resolver (tests); otherwise sessions, otherwise refuse-all. */
  tenantResolver?: TenantResolver;
  /** Test hook: extra controllers (stand-ins for routes of later tasks, e.g. SS-UC02-07). */
  testControllers?: Type[];
  /** Test hook: called once per SQL statement. */
  onQuery?: () => void;
  port?: number;
  host?: string;
}

export interface Api {
  app: INestApplication;
  db: Kysely<Database>;
  /** Present when `sessions` was configured. */
  sessions: SessionService | undefined;
  url: string;
  close(): Promise<void>;
}

/** Every controller the API can mount (routes.test.ts checks each declares its access, ADR-0023). */
export const API_CONTROLLERS: readonly Type[] = [
  HealthController,
  CompaniesController,
  PartyBankAccountsController,
  BankDetailChangesController,
  ManualJournalsController,
  UserRolesController,
  SodController,
  UsersController,
  ApiTokensController,
  UserApiTokensController,
  AuditLogController,
  SyncIssuesController,
  AuthController,
  LoginController,
];

@Module({})
class AppModule {
  static forRoot(
    db: Kysely<Database>,
    resolver: TenantResolver,
    sessions: SessionService | undefined,
    oidc: OidcService | undefined,
    testControllers: Type[],
    clock: Clock,
    mfa: MfaPolicy,
    kms: Kms | null,
    syncRequeue: DeliveryRequeue | null,
  ): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        HealthController,
        CompaniesController,
        PartyBankAccountsController,
        BankDetailChangesController,
        ManualJournalsController,
        UserRolesController,
        SodController,
        UsersController,
        ApiTokensController,
        UserApiTokensController,
        AuditLogController,
        SyncIssuesController,
        ...(sessions ? [AuthController] : []),
        ...(oidc ? [LoginController] : []),
        ...testControllers,
      ],
      providers: [
        { provide: DB, useValue: db },
        { provide: TENANT_RESOLVER, useValue: resolver },
        { provide: SESSION_SERVICE, useValue: sessions ?? null },
        { provide: OIDC_SERVICE, useValue: oidc ?? null },
        { provide: CLOCK, useValue: clock },
        { provide: MFA_POLICY, useValue: mfa },
        { provide: KMS, useValue: kms },
        { provide: SYNC_REQUEUE, useValue: syncRequeue },
        TenantTx,
        AuditTrail,
        Authz,
        { provide: APP_INTERCEPTOR, useClass: TenantInterceptor },
      ],
    };
  }
}

export async function createApi(opts: ApiOptions): Promise<Api> {
  const onQuery = opts.onQuery;
  const db = new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: opts.databaseUrl, max: opts.poolSize ?? 10 }),
    }),
    ...(onQuery
      ? {
          log: (e: { level: string }) => {
            if (e.level === 'query') onQuery();
          },
        }
      : {}),
  });
  const clock = opts.sessions?.clock ?? systemClock;
  const mfa: MfaPolicy = { acrValues: opts.mfa?.acrValues ?? defaultMfaPolicy.acrValues };
  const sessions = opts.sessions ? new SessionService(db, clock) : undefined;
  if (opts.oidc && !sessions) throw new Error('createApi: oidc login needs sessions');
  // The listen URL is known only after listen(); the redirect URI is first needed at login.
  let listenUrl = '';
  const oidc =
    opts.oidc && sessions
      ? new OidcService(
          db,
          sessions,
          opts.oidc,
          () => opts.oidc?.publicUrl ?? listenUrl,
          clock,
          mfa,
        )
      : undefined;
  const resolver =
    opts.tenantResolver ??
    (sessions
      ? new SessionTenantResolver(sessions, new ApiTokenService(clock))
      : refuseAllResolver);
  const app = await NestFactory.create(
    AppModule.forRoot(
      db,
      resolver,
      sessions,
      oidc,
      opts.testControllers ?? [],
      clock,
      mfa,
      opts.kms ?? null,
      opts.syncRequeue ?? null,
    ),
    {
      logger: ['error', 'warn'],
    },
  );
  app.use(requestIdMiddleware);
  await app.listen(opts.port ?? 0, opts.host ?? '127.0.0.1');
  const addr = app.getHttpServer().address() as AddressInfo;
  listenUrl = `http://${opts.host ?? '127.0.0.1'}:${String(addr.port)}`;
  return {
    app,
    db,
    sessions,
    url: listenUrl,
    async close() {
      await app.close();
      await db.destroy();
    },
  };
}
