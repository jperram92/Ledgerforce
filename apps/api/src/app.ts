import 'reflect-metadata';
import { type DynamicModule, Module, type INestApplication } from '@nestjs/common';
import { APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import type { Database } from '@ledgerforce/db';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { AddressInfo } from 'node:net';
import { AuthController, SESSION_SERVICE } from './auth/auth.controller.ts';
import { SessionTenantResolver } from './auth/session-tenant-resolver.ts';
import { SessionService, type Clock } from './auth/session.service.ts';
import { CompaniesController } from './companies/companies.controller.ts';
import { HealthController } from './health/health.controller.ts';
import { PartyBankAccountsController } from './parties/bank-accounts.controller.ts';
import { TenantInterceptor } from './tenancy/tenant.interceptor.ts';
import {
  refuseAllResolver,
  TENANT_RESOLVER,
  type TenantResolver,
} from './tenancy/tenant-resolver.ts';
import { AuditTrail, TenantTx } from './tenancy/tenant-tx.ts';
import { requestIdMiddleware } from './audit/request-id.ts';
import { DB } from './tokens.ts';

export interface ApiOptions {
  /** Connection string for lf_app (never a superuser or the migrator). */
  databaseUrl: string;
  poolSize?: number;
  /** Server-side sessions (ADR-0016). When set, the session resolver is used unless `tenantResolver` is given. */
  sessions?: { clock?: Clock };
  /** Explicit resolver (tests); otherwise sessions, otherwise refuse-all. */
  tenantResolver?: TenantResolver;
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

@Module({})
class AppModule {
  static forRoot(
    db: Kysely<Database>,
    resolver: TenantResolver,
    sessions: SessionService | undefined,
  ): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        HealthController,
        CompaniesController,
        PartyBankAccountsController,
        ...(sessions ? [AuthController] : []),
      ],
      providers: [
        { provide: DB, useValue: db },
        { provide: TENANT_RESOLVER, useValue: resolver },
        { provide: SESSION_SERVICE, useValue: sessions ?? null },
        TenantTx,
        AuditTrail,
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
  const sessions = opts.sessions ? new SessionService(db, opts.sessions.clock) : undefined;
  const resolver =
    opts.tenantResolver ?? (sessions ? new SessionTenantResolver(sessions) : refuseAllResolver);
  const app = await NestFactory.create(AppModule.forRoot(db, resolver, sessions), {
    logger: ['error', 'warn'],
  });
  app.use(requestIdMiddleware);
  await app.listen(opts.port ?? 0, opts.host ?? '127.0.0.1');
  const addr = app.getHttpServer().address() as AddressInfo;
  return {
    app,
    db,
    sessions,
    url: `http://${opts.host ?? '127.0.0.1'}:${String(addr.port)}`,
    async close() {
      await app.close();
      await db.destroy();
    },
  };
}
