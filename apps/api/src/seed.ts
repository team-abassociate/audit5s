import 'reflect-metadata';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { Logger, type INestApplicationContext } from '@nestjs/common';
import { eq, notInArray, sql } from 'drizzle-orm';
import {
  createDatabase,
  createPool,
  permissions,
  rolePermissions,
  users,
  type Database,
} from '@audit5s/db';
import { PERMISSION_MATRIX, grantFor, permissionKeyOf, type ScopeContext } from '@audit5s/domain';
import { AppModule } from './app.module';
import { ChecklistImportService } from './modules/checklists/import/checklist-import.service';
import { ChecklistsService } from './modules/checklists/checklists.service';
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
 *   2. the initial Super Admin, from `SEED_SUPER_ADMIN_*`;
 *   3. the nine department checklists, imported from the real workbook **through the real
 *      import pipeline** and published as v1 (HANDOFF.md §5.2).
 *
 * The third is deliberate: hand-writing the templates here would create a second import
 * implementation that nothing exercises, and the one that ships would first run against
 * real data in production. Running the seed *through* the pipeline makes the seed the
 * importer's first integration test.
 *
 * Idempotent: safe to re-run on every deploy. A re-run finds every sheet identical to the
 * published version, which stage 4 reports as "no changes to import" and commits nothing.
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

      const imported = await seedChecklists(app, db, logger);
      logger.log(
        imported === 0
          ? 'Checklists: already up to date'
          : `Checklists: ${imported} version(s) imported and published`,
      );
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

/**
 * The department workbook, as shipped in the repository.
 *
 * `docs/requirements/5S_lean_audit_data_1.xlsx` is the business's real file and the
 * source of truth for the nine templates (R-6a). The path is resolved relative to the
 * repository root when running from source and to `/app` inside the image, so the same
 * code seeds a container and a developer's checkout.
 */
export const CHECKLIST_WORKBOOK_CANDIDATES = [
  resolve(__dirname, '..', '..', '..', 'docs', 'requirements', '5S_lean_audit_data_1.xlsx'),
  resolve(__dirname, '..', 'docs', 'requirements', '5S_lean_audit_data_1.xlsx'),
  resolve(process.cwd(), 'docs', 'requirements', '5S_lean_audit_data_1.xlsx'),
];

export function findChecklistWorkbook(candidates = CHECKLIST_WORKBOOK_CANDIDATES): string | null {
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * Imports the nine department checklists through the real pipeline and publishes each.
 *
 * Runs every stage a Super Admin's upload would: store, parse, validate, duplicate-check,
 * preview, commit, publish. Nothing here reaches past the pipeline into
 * `checklist_version` — if the importer is broken, the seed fails, which is the point.
 *
 * Returns the number of versions published; zero means every sheet already matched the
 * published checklist, which is the normal answer on a re-deploy.
 */
export async function seedChecklists(
  app: INestApplicationContext,
  db: Database,
  logger: Logger,
): Promise<number> {
  const workbook = findChecklistWorkbook();
  if (!workbook) {
    logger.warn(
      'No department workbook found at docs/requirements/5S_lean_audit_data_1.xlsx; ' +
        'skipping checklist import. Import it from the admin web app instead.',
    );
    return 0;
  }

  const scope = await superAdminScope(db);
  if (!scope) {
    throw new Error('Cannot import checklists: no usable SUPER_ADMIN exists');
  }

  const imports = app.get(ChecklistImportService);
  const checklists = app.get(ChecklistsService);

  const job = await imports.upload(scope, {
    fileName: '5S_lean_audit_data_1.xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    body: await readFile(workbook),
  });

  // Called directly rather than through the queue: the seed is a one-shot process and
  // has no worker to wait for. It is the same method the `checklist.import` handler
  // calls, so this is the real pipeline, not a shortcut around it.
  await imports.runPipeline(scope, job.id);

  const preview = await imports.preview(scope, job.id);

  for (const sheet of preview.sheets) {
    if (sheet.severity === 'ERROR') {
      throw new Error(
        `The department workbook failed validation on sheet "${sheet.sheetName}": ` +
          sheet.messages.join('; '),
      );
    }
  }

  const committable = preview.sheets.filter((sheet) => !sheet.duplicateIsPublished);
  if (committable.length === 0) {
    return 0;
  }

  const committed = await imports.commit(scope, job.id, {
    sheetIds: committable.map((sheet) => sheet.id),
    publish: false,
  });

  let published = 0;
  for (const version of committed.versions) {
    await checklists.publish(scope, version.id);
    published += 1;
    logger.log(`  ${version.templateCode} v${version.versionNumber} published`);
  }

  return published;
}

/**
 * The scope the seed acts under: the first usable Super Admin, with the resolver PART 6
 * grants that role — never a hand-made "system" actor that bypasses the matrix (AZ-4).
 */
async function superAdminScope(db: Database): Promise<ScopeContext | null> {
  const [row] = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.auth_phase', 'on', true)`);
    return tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, 'SUPER_ADMIN'))
      .limit(1);
  });

  if (!row) return null;

  const grant = grantFor('SUPER_ADMIN', 'checklist_import:upload');
  if (!grant) return null;

  return {
    actor: {
      userId: row.id,
      role: 'SUPER_ADMIN',
      activeUnitId: null,
      unitIds: [],
      deviceId: null,
    },
    resolver: grant.resolver,
  };
}

if (require.main === module) {
  void bootstrap().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
