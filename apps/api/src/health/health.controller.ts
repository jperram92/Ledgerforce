import { Controller, Get, HttpCode, HttpException, Inject } from '@nestjs/common';
import type { Database } from '@ledgerforce/db';
import { sql, type Kysely } from 'kysely';
import { Public } from '../tenancy/public.decorator.ts';
import { DB } from '../tokens.ts';

@Controller('health')
export class HealthController {
  constructor(@Inject(DB) private readonly db: Kysely<Database>) {}

  @Public()
  @Get()
  @HttpCode(200)
  async check(): Promise<{ status: 'ok'; db: 'ok' }> {
    try {
      await sql`SELECT 1`.execute(this.db);
    } catch {
      throw new HttpException({ status: 'degraded', db: 'down' }, 503);
    }
    return { status: 'ok', db: 'ok' };
  }
}
