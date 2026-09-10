import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { eq, notInArray, sql } from 'drizzle-orm';
import {
  createDatabase,
  createPool,
  permissions,
  rolePermissions,
  users,
  type Database,
} from '@audit5s/db';
import { PERMISSION_MATRIX, permissionKeyOf } from '@audit5s/domain';
import { AppModule } from './app.module';
import { PasswordService } from './modules/auth/password.service';
import { CONFIG, type AppConfig } from './config/env';
import { StructuredLogger } from './common/observability/logger';

/**
 * The fourth entrypoint of the API image (`node dist/seed`).
 *
 * It runs through the Nest application context so it uses the real services rather than a
 * parallel implementation — the same `PasswordService`, the same config.
 *
 * Seeds:
 *   1. the permission matrix from PART 6, generated from `packages/domain` so the
 *      document, the seed and the runtime cannot drift;
 *   2. the initial Super Admin, from `SEED_SUPER_ADMIN_*`.
 *
 * The nine checklist templates are imported through the real import pipeline in Phase 2 —
 * that import is deliberately the importer's first integration test, so it waits for the
 * pipeline rather than being hand-written here.
 *
 * Idempotent: safe to re-run on every deploy.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: new StructuredLogger(),
  });
  const logger = new Logger('seed');

  try {
    const config = app.get<AppConfig>(CONFIG);
    const passwords = app.get(PasswordService);

    if (!config.DATABASE_MIGRATION_URL) {
      throw new Error(
        'DATABASE_MIGRATION_URL must be set to seed: permission and role_permission are ' +
          'SELECT-only for the application role, by design.',
      );
    }

    // The owner connection, for the same reason the migration runner uses it.
    const ownerPool = createPool({ connectionString: config.DATABASE_MIGRATION_URL, max: 2 });
    const db = createDatabase(ownerPool);

    try {
      const permissionCount = await seedPermissionMatrix(db);
      logger.log(`Permission matrix: ${permissionCount} permissions`);

      const superAdmin = await seedSuperAdmin(db, config, passwords, logger);
      if (superAdmin) {
        logger.log(`Super Admin ready: ${superAdmin}`);
      }
    } finally {
      await ownerPool.end();
    }
  } finally {
    await app.close();
  }
}

/**
 * Writes `permission` and `role_permission` from the matrix.
 *
 * Grants are replaced rather than merged: a grant removed from PART 6 must disappear from
 * the database, or the runtime would keep honouring a permission the document no longer
 * gives. That is the whole reason this is generated rather than hand-maintained.
 */
export async function seedPermissionMatrix(db: Database): Promise<number> {
  return db.transaction(async (tx) => {
    // The seed runs as the owner, which is not subject to the app role's policies, but the
    // context is set anyway so the same code path works when run as the app role in tests.
    await tx.execute(sql`SELECT set_config('app.auth_phase', 'on', true)`);

    for (const definition of PERMISSION_MATRIX) {
      const [permission] = await tx
        .insert(permissions)
        .values({
          resource: definition.resource,
          action: definition.action,
          description: definition.description,
        })
        .onConflictDoUpdate({
          target: [permissions.resource, permissions.action],
          set: { description: definition.description },
        })
        .returning({ id: permissions.id });

      const permissionId = permission!.id;

      await tx.delete(rolePermissions).where(eq(rolePermissions.permissionId, permissionId));

      const grants = Object.entries(definition.grants);
      if (grants.length > 0) {
        await tx.insert(rolePermissions).values(
          grants.map(([role, grant]) => ({
            role: role as (typeof rolePermissions.role.enumValues)[number],
            permissionId,
            scopeRule: grant.resolver,
            condition: grant.condition ?? null,
          })),
        );
      }
    }

    // Anything in the table but not in the matrix is a stale permission from an older
    // version of PART 6, and must go — otherwise the runtime keeps honouring a grant the
    // document no longer makes.
    const keys = PERMISSION_MATRIX.map(permissionKeyOf) as string[];
    await tx
      .delete(permissions)
      .where(notInArray(sql`${permissions.resource} || ':' || ${permissions.action}`, keys));

    return PERMISSION_MATRIX.length;
  });
}

/**
 * Q4's default: read the identity from the environment and **fail loudly if unset**,
 * rather than inventing a Super Admin nobody expected to exist.
 */
export async function seedSuperAdmin(
  db: Database,
  config: AppConfig,
  passwords: PasswordService,
  logger: Logger,
): Promise<string | null> {
  const fullName = config.SEED_SUPER_ADMIN_FULL_NAME;
  const phone = config.SEED_SUPER_ADMIN_PHONE;

  if (!fullName || !phone) {
    throw new Error(
      'SEED_SUPER_ADMIN_FULL_NAME and SEED_SUPER_ADMIN_PHONE must be set. ' +
        'Refusing to invent an initial administrator identity.',
    );
  }

  const existing = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.auth_phase', 'on', true)`);
    const [row] = await tx
      .select({ id: users.id, loginId: users.loginId })
      .from(users)
      .where(eq(users.role, 'SUPER_ADMIN'))
      .limit(1);
    return row ?? null;
  });

  if (existing) {
    logger.log('A Super Admin already exists; leaving it untouched');
    return existing.loginId;
  }

  const { loginIdCandidate } = await import('@audit5s/domain');
  const loginId = loginIdCandidate(fullName, phone, 0);

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.auth_phase', 'on', true)`);
    const [created] = await tx
      .insert(users)
      .values({
        loginId,
        fullName,
        phoneE164: phone,
        email: config.SEED_SUPER_ADMIN_EMAIL ?? null,
        role: 'SUPER_ADMIN',
        // The bootstrap credential is the phone number, hashed like any other password,
        // and must be rotated within 72 hours (CH-1). It is never printed.
        passwordHash: await passwords.hash(phone),
        mustResetPassword: true,
        bootstrapExpiresAt: new Date(
          Date.now() + config.BOOTSTRAP_PASSWORD_TTL_HOURS * 60 * 60 * 1000,
        ),
        status: 'INVITED',
      })
      .returning({ loginId: users.loginId });
    return created!.loginId;
  });
}

if (require.main === module) {
  void bootstrap().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
