import { Global, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createDatabase, createPool, type Database } from '@audit5s/db';
import { Pool } from 'pg';
import { CONFIG, loadConfig, type AppConfig } from '../../config/env';

export const DATABASE = Symbol('DATABASE');
export const DATABASE_POOL = Symbol('DATABASE_POOL');

@Global()
@Module({
  providers: [
    {
      provide: CONFIG,
      useFactory: (): AppConfig => loadConfig(),
    },
    {
      provide: DATABASE_POOL,
      inject: [CONFIG],
      useFactory: (config: AppConfig): Pool =>
        createPool({ connectionString: config.DATABASE_URL, max: config.DATABASE_POOL_MAX }),
    },
    {
      provide: DATABASE,
      inject: [DATABASE_POOL],
      useFactory: (pool: Pool): Database => createDatabase(pool),
    },
  ],
  exports: [CONFIG, DATABASE, DATABASE_POOL],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor() {}

  async onApplicationShutdown(): Promise<void> {
    // The pool is closed by the Nest shutdown hook wired in main.ts.
  }
}
