import 'reflect-metadata';
import { type DynamicModule, Module, type INestApplication } from '@nestjs/common';
import { APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import type { Database } from '@ledgerforce/db';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { AddressInfo } from 'node:net';
import { CompaniesController } from './companies/companies.controller.ts';
import { HealthController } from './health/health.controller.ts';
import { TenantInterceptor } from './tenancy/tenant.interceptor.ts';
import {
  refuseAllResolver,
  TENANT_RESOLVER,
  type TenantResolver,
} from './tenancy/tenant-resolver.ts';
import { TenantTx } from './tenancy/tenant-tx.ts';
import { DB } from './tokens.ts';

export interface ApiOptions {
  /** Connection string for lf_app (never a superuser or the migrator). */
  databaseUrl: string;
  poolSize?: number;
  /** Defaults to refusing every tenant route until OIDC exists (T-0011). */
  tenantResolver?: TenantResolver;
  /** Test hook: called once per SQL statement. */
  onQuery?: () => void;
  port?: number;
  host?: string;
}

export interface Api {
  app: INestApplication;
  db: Kysely<Database>;
  url: string;
  close(): Promise<void>;
}

@Module({})
class AppModule {
  static forRoot(db: Kysely<Database>, resolver: TenantResolver): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, CompaniesController],
      providers: [
        { provide: DB, useValue: db },
        { provide: TENANT_RESOLVER, useValue: resolver },
        TenantTx,
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
  const app = await NestFactory.create(
    AppModule.forRoot(db, opts.tenantResolver ?? refuseAllResolver),
    {
      logger: ['error', 'warn'],
    },
  );
  await app.listen(opts.port ?? 0, opts.host ?? '127.0.0.1');
  const addr = app.getHttpServer().address() as AddressInfo;
  return {
    app,
    db,
    url: `http://${opts.host ?? '127.0.0.1'}:${String(addr.port)}`,
    async close() {
      await app.close();
      await db.destroy();
    },
  };
}
