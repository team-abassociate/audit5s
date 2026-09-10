import { z } from 'zod';

/**
 * The environment contract. Parsed once at boot and never read from `process.env`
 * elsewhere, so a missing variable is a startup failure with a clear message rather than
 * an `undefined` surfacing three layers down at request time.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  API_HOST: z.string().default('0.0.0.0'),
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),

  DATABASE_URL: z.string().min(1),
  /**
   * The owner connection. Used only by the seed, which writes reference data the
   * application role is deliberately not allowed to write (permission/role_permission are
   * SELECT-only for the app). Never used to serve a request.
   */
  DATABASE_MIGRATION_URL: z.string().optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  // RS256: asymmetric so workers verify without holding the signing key (§12.3).
  JWT_PRIVATE_KEY_B64: z.string().min(1),
  JWT_PUBLIC_KEY_B64: z.string().min(1),
  JWT_ISSUER: z.string().min(1),
  JWT_AUDIENCE: z.string().min(1),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  BOOTSTRAP_PASSWORD_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(72),

  PGBOSS_SCHEMA: z.string().default('pgboss'),
  PGBOSS_ARCHIVE_COMPLETED_AFTER_SECONDS: z.coerce.number().int().default(43_200),
  PGBOSS_DELETE_ARCHIVED_AFTER_DAYS: z.coerce.number().int().default(7),
  WORKER_QUEUES: z.string().default(''),

  SEED_SUPER_ADMIN_FULL_NAME: z.string().optional(),
  SEED_SUPER_ADMIN_PHONE: z.string().optional(),
  SEED_SUPER_ADMIN_EMAIL: z.string().optional(),

  SENTRY_DSN: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export interface AppConfig extends Omit<Env, 'JWT_PRIVATE_KEY_B64' | 'JWT_PUBLIC_KEY_B64'> {
  jwtPrivateKeyPem: string;
  jwtPublicKeyPem: string;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${detail}`);
  }

  const { JWT_PRIVATE_KEY_B64, JWT_PUBLIC_KEY_B64, ...rest } = parsed.data;

  return {
    ...rest,
    jwtPrivateKeyPem: Buffer.from(JWT_PRIVATE_KEY_B64, 'base64').toString('utf8'),
    jwtPublicKeyPem: Buffer.from(JWT_PUBLIC_KEY_B64, 'base64').toString('utf8'),
  };
}

export const CONFIG = Symbol('APP_CONFIG');
