import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { API_BASE_PATH, HEADER_DEVICE_ID, type Role } from '@audit5s/contracts';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';
import { FASTIFY_ADAPTER_OPTIONS, registerHttpPlugins } from '../src/bootstrap';
import { RequestContextMiddleware } from '../src/common/observability/request-context.middleware';
import { RateLimitService } from '../src/common/rate-limit/rate-limit.service';
import { seedPermissionMatrix } from '../src/seed';
import { createDatabase, createPool } from '@audit5s/db';

export const OWNER_URL =
  process.env.DATABASE_MIGRATION_URL ??
  'postgres://audit5s_owner:audit5s_owner@127.0.0.1:5432/audit5s_test';
export const APP_URL =
  process.env.DATABASE_URL ?? 'postgres://audit5s_app:audit5s_app@127.0.0.1:5432/audit5s_test';

export interface TestActor {
  role: Role;
  userId: string;
  loginId: string;
  accessToken: string;
  refreshToken: string;
  unitId: string | null;
}

export interface TestWorld {
  app: NestFastifyApplication;
  owner: Client;
  /** Unit A — where every in-scope actor lives. */
  unitA: string;
  /** Unit B — the other Unit, used for every out-of-scope case. */
  unitB: string;
  /** One Zone per Unit, so the sweep has an in-scope and an out-of-scope `/zones/:id`. */
  zoneA: string;
  zoneB: string;
  actors: Record<Role, TestActor>;
  /** A user in Unit B, for out-of-scope reads. */
  outOfScopeUserId: string;
  /** The same user, whole, so a suite can act *as* them rather than only name them. */
  outOfScopeActor: TestActor;
  /** A user in Unit A, safe to read in scope. */
  inScopeUserId: string;
  request: (
    method: string,
    path: string,
    options?: { token?: string | null; body?: unknown; headers?: Record<string, string> },
  ) => Promise<{ status: number; body: unknown }>;
  /** POSTs a file as `multipart/form-data`, the way the import upload receives it. */
  upload: (
    path: string,
    file: { field?: string; filename: string; contentType: string; body: Buffer },
    options?: { token?: string | null },
  ) => Promise<{ status: number; body: unknown }>;
}

export const FIXTURE_PASSWORD = 'orchard-piston-58-VQ';
const PASSWORD = FIXTURE_PASSWORD;

export async function startWorld(): Promise<TestWorld> {
  // Through the package's own script, so tests apply migrations exactly as CI and the
  // deploy do — not through a second code path that could drift from it.
  execFileSync('pnpm', ['--filter', '@audit5s/db', 'migrate'], {
    cwd: resolve(__dirname, '..', '..', '..'),
    env: { ...process.env, DATABASE_MIGRATION_URL: OWNER_URL },
    stdio: 'pipe',
  });

  const owner = new Client({ connectionString: OWNER_URL });
  await owner.connect();
  await truncateAll(owner);

  const ownerPool = createPool({ connectionString: OWNER_URL, max: 2 });
  await seedPermissionMatrix(createDatabase(ownerPool));
  await ownerPool.end();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(FASTIFY_ADAPTER_OPTIONS),
    {
    logger: process.env.TEST_LOG === '1' ? undefined : false,
  });
  app.setGlobalPrefix(API_BASE_PATH);
  // The same list `main.ts` applies, from the same function: the suites build the
  // application themselves, and two copies of this list drift the moment either changes.
  await registerHttpPlugins(app, { CHECKLIST_IMPORT_MAX_BYTES: 10 * 1024 * 1024 });
  // Nest's `configure()` middleware is registered by the platform on init; applying it
  // explicitly here keeps the request context available under `app.inject`.
  void RequestContextMiddleware;
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const request: TestWorld['request'] = async (method, path, options = {}) => {
    // Fastify refuses `content-type: application/json` with an empty body, and a real
    // client would not send one either.
    const headers: Record<string, string> = {
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    };
    if (options.token) {
      headers.authorization = `Bearer ${options.token}`;
    }
    const response = await app.inject({
      method: method as 'GET',
      url: path,
      headers,
      ...(options.body !== undefined ? { payload: JSON.stringify(options.body) } : {}),
    });
    let body: unknown = null;
    try {
      body = response.body ? JSON.parse(response.body) : null;
    } catch {
      body = response.body;
    }
    return { status: response.statusCode, body };
  };

  const upload: TestWorld['upload'] = async (path, file, options = {}) => {
    const boundary = `----audit5s${Math.random().toString(16).slice(2)}`;
    const head = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${file.field ?? 'file'}"; ` +
        `filename="${file.filename}"\r\n` +
        `Content-Type: ${file.contentType}\r\n\r\n`,
      'utf8',
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');

    const response = await app.inject({
      method: 'POST',
      url: path,
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      payload: Buffer.concat([head, file.body, tail]),
    });

    let body: unknown = null;
    try {
      body = response.body ? JSON.parse(response.body) : null;
    } catch {
      body = response.rawPayload;
    }
    return { status: response.statusCode, body };
  };

  const world = { app, owner, request, upload } as Partial<TestWorld> as TestWorld;

  const unitA = await insertUnit(owner, 'U-A', 'Unit A');
  const unitB = await insertUnit(owner, 'U-B', 'Unit B');
  world.unitA = unitA;
  world.unitB = unitB;
  world.zoneA = await insertZone(owner, unitA, 'Z-01', 'Press');
  world.zoneB = await insertZone(owner, unitB, 'Z-01', 'Assembly');

  // Rate limits are per-process and would otherwise leak between test files.
  app.get(RateLimitService).reset();

  world.actors = {
    SUPER_ADMIN: await makeActor(owner, request, 'SUPER_ADMIN', 'Sam Admin', '+919000000101', null),
    CONSULTANT: await makeActor(owner, request, 'CONSULTANT', 'Cara Consult', '+919000000102', unitA),
    COORDINATOR: await makeActor(owner, request, 'COORDINATOR', 'Cole Coord', '+919000000103', unitA),
    ZONE_LEADER: await makeActor(owner, request, 'ZONE_LEADER', 'Zoe Leader', '+919000000104', unitA),
  };

  world.inScopeUserId = world.actors.ZONE_LEADER.userId;
  world.outOfScopeActor = await makeActor(
    owner,
    request,
    'ZONE_LEADER',
    'Otto Outside',
    '+919000000105',
    unitB,
  );
  world.outOfScopeUserId = world.outOfScopeActor.userId;

  return world;
}

export async function stopWorld(world: TestWorld | undefined): Promise<void> {
  await world?.app.close();
  await world?.owner.end();
}

export async function truncateAll(owner: Client): Promise<void> {
  await owner.query(`
    TRUNCATE notification_delivery, notification, notification_preference,
             corrective_action_submission, corrective_action,
             evidence, sync_conflict, device_sync_record,
             question_response, audit_zone_section_score, audit_zone, audit,
             audit_assignment,
             checklist_import_row, checklist_import_sheet, checklist_import_job,
             checklist_question, checklist_version, checklist_template, zone,
             audit_log, login_attempt, idempotency_key, revoked_access_token,
             refresh_token, otp_challenge, device, unit_membership, unit, "user"
    RESTART IDENTITY CASCADE;
  `);
}

async function insertZone(
  owner: Client,
  unitId: string,
  code: string,
  name: string,
): Promise<string> {
  const { rows } = await owner.query(
    `INSERT INTO zone (unit_id, code, name) VALUES ($1, $2, $3) RETURNING id`,
    [unitId, code, name],
  );
  return rows[0].id as string;
}

async function insertUnit(owner: Client, code: string, name: string): Promise<string> {
  const { rows } = await owner.query(
    `INSERT INTO unit (code, name) VALUES ($1, $2) RETURNING id`,
    [code, name],
  );
  return rows[0].id as string;
}

/**
 * Creates a user directly, with its password already rotated.
 *
 * Deliberately not via the API: every route except the reset itself is closed while
 * `must_reset_password` is set (CH-1), so a fixture built through the API would have to
 * walk each actor through a reset before it could test anything else. The forced-reset
 * behaviour has its own test.
 */
async function makeActor(
  owner: Client,
  request: TestWorld['request'],
  role: Role,
  fullName: string,
  phone: string,
  unitId: string | null,
): Promise<TestActor> {
  const argon2 = await import('argon2');
  const { ARGON2_OPTIONS } = await import('../src/modules/auth/password.service');
  const passwordHash = await argon2.hash(PASSWORD, ARGON2_OPTIONS);

  const loginId = `${fullName.replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase()}${phone.slice(-4)}`;

  const { rows } = await owner.query(
    `INSERT INTO "user" (login_id, full_name, phone_e164, role, password_hash,
                         must_reset_password, status)
     VALUES ($1, $2, $3, $4, $5, false, 'ACTIVE') RETURNING id`,
    [loginId, fullName, phone, role, passwordHash],
  );
  const userId = rows[0].id as string;

  if (unitId) {
    await owner.query(
      `INSERT INTO unit_membership (user_id, unit_id, role, assigned_by_user_id)
       VALUES ($1, $2, $3, $1)`,
      [userId, unitId, role],
    );
  }

  const login = await request('POST', `${API_BASE_PATH}/auth/login`, {
    body: { loginId, password: PASSWORD },
  });

  if (login.status !== 200) {
    throw new Error(`Fixture login failed for ${role}: ${JSON.stringify(login.body)}`);
  }

  const tokens = login.body as { accessToken: string; refreshToken: string };
  return {
    role,
    userId,
    loginId,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    unitId,
  };
}

/** An access token that is syntactically valid and definitely expired. */
export async function expiredToken(app: NestFastifyApplication, userId: string, role: Role): Promise<string> {
  const { SignJWT, importPKCS8 } = await import('jose');
  const { CONFIG } = await import('../src/config/env');
  const config = app.get(CONFIG) as { jwtPrivateKeyPem: string; JWT_ISSUER: string; JWT_AUDIENCE: string };
  const key = await importPKCS8(config.jwtPrivateKeyPem, 'RS256');
  const past = Math.floor(Date.now() / 1000) - 3600;

  return new SignJWT({ role, deviceId: null })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setSubject(userId)
    .setJti(randomUUID())
    .setIssuedAt(past - 900)
    .setExpirationTime(past)
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_AUDIENCE)
    .sign(key);
}

/**
 * Signs an actor in again from a device, returning a token bound to it.
 *
 * An audit is a device's work: `owning_device_id` is a foreign key to `device`, and the
 * single-writer lock (D7) has nothing to hold without one. Logging in with a `deviceId`
 * both registers the device row and binds the session to it, exactly as the mobile app
 * does — the audit suites use this rather than inserting a device row behind the API.
 */
export async function loginFromDevice(
  world: TestWorld,
  actor: TestActor,
  deviceId: string,
): Promise<string> {
  const response = await world.request('POST', `${API_BASE_PATH}/auth/login`, {
    body: {
      loginId: actor.loginId,
      password: PASSWORD,
      deviceId,
      platform: 'android',
      model: 'Pixel 8',
      osVersion: '15',
      appVersion: '1.0.0',
    },
  });

  if (response.status !== 200) {
    throw new Error(`Device login failed for ${actor.role}: ${JSON.stringify(response.body)}`);
  }
  return (response.body as { accessToken: string }).accessToken;
}

/**
 * A one-by-one pixel JPEG. Real bytes, with a real JPEG magic number, because `commit`
 * sniffs them (§12.8) and a buffer of zeros would be refused exactly as a renamed ZIP is.
 */
export const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
    'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The whole of §9.4's media flow, as the device performs it: intent → PUT → commit.
 *
 * It goes through the real endpoints and the real presigned URL rather than inserting a
 * row, because the point of having it in the harness is that every suite that needs a
 * photograph exercises the actual three-step protocol. The PUT is injected at the signed
 * storage route (R-9), which is where the filesystem driver's URL points.
 */
export async function captureEvidence(
  world: TestWorld,
  options: {
    token: string;
    evidenceId: string;
    auditId: string;
    kind?: 'AUDITOR_SELFIE' | 'QUESTION_EVIDENCE' | 'WALK_BY_PHOTO' | 'CORRECTIVE_AFTER';
    auditZoneId?: string;
    questionResponseId?: string;
    classification?: 'GOOD' | 'NONCONFORMITY' | 'NEUTRAL';
    /** `CORRECTIVE_AFTER` only: the action, and the attempt the photo is taken for. */
    correctiveActionId?: string;
    correctiveActionSubmissionId?: string;
    isLiveCapture?: boolean;
    deviceId?: string;
    bytes?: Buffer;
    /** Skips the commit, leaving the row SYNCING — §9.4's `orphan_metadata` case. */
    skipCommit?: boolean;
  },
): Promise<{ evidenceId: string; objectKey: string; uploadUrl: string; checksum: string }> {
  const bytes = options.bytes ?? TINY_JPEG;
  const checksum = sha256Hex(bytes);
  const headers: Record<string, string> = options.deviceId
    ? { [HEADER_DEVICE_ID]: options.deviceId }
    : {};

  const intent = await world.request('POST', `${API_BASE_PATH}/evidence/upload-intent`, {
    token: options.token,
    headers,
    body: {
      id: options.evidenceId,
      kind: options.kind ?? 'AUDITOR_SELFIE',
      auditId: options.auditId,
      ...(options.auditZoneId ? { auditZoneId: options.auditZoneId } : {}),
      ...(options.questionResponseId ? { questionResponseId: options.questionResponseId } : {}),
      ...(options.classification ? { classification: options.classification } : {}),
      ...(options.correctiveActionId ? { correctiveActionId: options.correctiveActionId } : {}),
      ...(options.correctiveActionSubmissionId
        ? { correctiveActionSubmissionId: options.correctiveActionSubmissionId }
        : {}),
      contentType: 'image/jpeg',
      byteSize: bytes.byteLength,
      checksumSha256: checksum,
      capturedAt: new Date().toISOString(),
      isLiveCapture: options.isLiveCapture ?? true,
    },
  });

  if (intent.status !== 201) {
    throw new Error(`upload-intent failed: ${JSON.stringify(intent.body)}`);
  }
  const { objectKey, uploadUrl } = intent.body as { objectKey: string; uploadUrl: string };

  // Straight to the presigned URL, carrying no session — exactly as a device would.
  const put = await world.app.inject({
    method: 'PUT',
    url: uploadUrl.replace(/^https?:\/\/[^/]+/, ''),
    headers: { 'content-type': 'image/jpeg' },
    payload: bytes,
  });
  if (put.statusCode !== 200) {
    throw new Error(`presigned PUT failed: ${put.statusCode} ${put.body}`);
  }

  if (!options.skipCommit) {
    const commit = await world.request(
      'POST',
      `${API_BASE_PATH}/evidence/${options.evidenceId}/commit`,
      { token: options.token, headers, body: { checksumSha256: checksum } },
    );
    if (commit.status !== 200) {
      throw new Error(`commit failed: ${JSON.stringify(commit.body)}`);
    }
  }

  return { evidenceId: options.evidenceId, objectKey, uploadUrl, checksum };
}
