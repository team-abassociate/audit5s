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
  /**
   * Supabase (and most managed Postgres) require TLS on the wire and self-hosted Postgres
   * in docker-compose does not speak it at all — so this is a plain env toggle rather than
   * something inferred from the connection string. `no-verify` is what Supabase's pooler
   * needs in practice: the leaf cert chains to a CA Node's default trust store does not
   * carry, so full verification fails even though the connection is genuinely encrypted.
   */
  DATABASE_SSL: z.enum(['disable', 'require', 'no-verify']).default('disable'),

  // RS256: asymmetric so workers verify without holding the signing key (§12.3).
  JWT_PRIVATE_KEY_B64: z.string().min(1),
  JWT_PUBLIC_KEY_B64: z.string().min(1),
  JWT_ISSUER: z.string().min(1),
  JWT_AUDIENCE: z.string().min(1),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  BOOTSTRAP_PASSWORD_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(72),

  /**
   * Object storage. The endpoint is a variable precisely so R2, MinIO or any other
   * S3-compatible target needs no code change (STACK.md §2). Leaving it unset selects the
   * filesystem driver, which is the development and CI path — see StorageModule.
   */
  R2_ENDPOINT: z.string().optional(),
  R2_REGION: z.string().default('auto'),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET_EVIDENCE: z.string().default('audit5s-evidence'),
  R2_BUCKET_REPORTS: z.string().default('audit5s-reports'),
  R2_BUCKET_IMPORTS: z.string().default('audit5s-imports'),
  OBJECT_STORAGE_LOCAL_DIR: z.string().default('.data/object-storage'),
  /**
   * Where the filesystem driver's presigned URLs point (R-9). Absolute, because a device
   * and a browser both have to resolve it without knowing how the API is mounted.
   */
  OBJECT_STORAGE_PUBLIC_URL: z.string().default('http://127.0.0.1:3000/api/v1'),
  /**
   * Signs those URLs. Unset means a fresh key per process, so a restart invalidates
   * outstanding links — the right default for a driver that is not a production path.
   */
  OBJECT_STORAGE_SIGNING_SECRET: z.string().min(16).optional(),
  /** §12.6: presigned GET ≤ 300 s, presigned PUT ≤ 900 s. Both capped in the port. */
  EVIDENCE_GET_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(300).default(300),
  EVIDENCE_PUT_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(900),
  /**
   * §9.5's Layer 1 grace: a PAUSED audit keeps its device lock this long, then the sweep
   * releases it so a lost phone does not strand the work on it.
   */
  DEVICE_RELEASE_GRACE_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  /**
   * `corrective_action.due_at`, counted from the audit's completion. §5.7 leaves the value
   * open; seven days is a house default, not a requirement, and 0 means "no due date".
   */
  CORRECTIVE_ACTION_DUE_DAYS: z.coerce.number().int().min(0).max(365).default(7),

  /**
   * Where the signed corrective-action link points (§10.4). The PDF prints
   * `{WEB_APP_URL}/ca/{token}`, so this value is baked into every report ever generated —
   * changing it later does not rewrite the documents already issued, which is why it is
   * one setting rather than a per-report argument.
   */
  WEB_APP_URL: z.string().default('http://127.0.0.1:5173'),
  /** §10.4: "Default 30 days, configurable per report." */
  REPORT_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  /** A report's presigned download. §12.6 caps it at 300 s regardless. */
  REPORT_GET_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(300).default(300),
  /**
   * STACK.md §5: "120s job timeout, one retry, then a visible dead-letter."
   */
  REPORT_RENDER_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(600_000).default(120_000),
  /**
   * Where `worker-report` finds its browser. Unset means Playwright's own resolution,
   * which is what a developer machine wants; the image pins a path.
   */
  CHROMIUM_EXECUTABLE_PATH: z.string().optional(),

  /** §12.8: a hard cap on the workbook an import will even attempt to read. */
  CHECKLIST_IMPORT_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(50 * 1024 * 1024)
    .default(10 * 1024 * 1024),
  /** Stage 5 is a dry run that expires, so a stale preview cannot be committed later. */
  CHECKLIST_IMPORT_PREVIEW_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),

  PGBOSS_SCHEMA: z.string().default('pgboss'),
  /**
   * How long a completed job is kept before pg-boss deletes it (STACK.md §5's
   * archive-retention policy). One knob, because pg-boss 12 has one: the separate archive
   * table of earlier versions is gone, so the two settings that named it described a
   * mechanism that no longer exists.
   */
  PGBOSS_JOB_RETENTION_DAYS: z.coerce.number().int().min(1).max(90).default(7),

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
