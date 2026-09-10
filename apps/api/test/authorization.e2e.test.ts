import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROLES, type Role } from '@audit5s/contracts';
import { ENDPOINT_MATRIX, MATRIX_KEYS, endpointKey, type EndpointExpectation } from './authorization-matrix';
import { expiredToken, startWorld, stopWorld, type TestWorld } from './harness';

/**
 * The authorization suite (ARCHITECTURE.md §15.2, §12.4).
 *
 * Two halves, and the first is the one that keeps the second honest:
 *
 *   1. **Completeness.** Every route the router actually exposes must appear in
 *      `authorization-matrix.ts`, and every entry must correspond to a real route. A new
 *      endpoint with no matrix entry fails CI — which is what stops PART 6 from becoming
 *      documentation that has drifted from the code.
 *   2. **Behaviour.** Every endpoint × every role × {in-scope, out-of-scope, no auth,
 *      expired token}, asserting the exact status.
 */

let world: TestWorld;

beforeAll(async () => {
  world = await startWorld();
});

afterAll(async () => {
  await stopWorld(world);
});

/** Every route Fastify has registered, as `METHOD /path`. */
function registeredRoutes(): string[] {
  const instance = world.app.getHttpAdapter().getInstance() as {
    printRoutes?: () => string;
  };
  const routes = new Set<string>();

  // Fastify's own route table, via the Nest adapter.
  const raw = (instance as unknown as { printRoutes: (o?: object) => string }).printRoutes({
    commonPrefix: false,
    includeMeta: false,
  });

  // printRoutes renders a tree; walk it back into full paths.
  const stack: Array<{ depth: number; segment: string }> = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const match = /^([│└├─\s]*)(\S.*)$/.exec(line);
    if (!match) continue;
    const depth = Math.floor((match[1] ?? '').length / 4);
    let segment = (match[2] ?? '').trim();

    const methodsMatch = /\(([A-Z, ]+)\)\s*$/.exec(segment);
    let methods: string[] = [];
    if (methodsMatch) {
      methods = (methodsMatch[1] ?? '').split(',').map((m) => m.trim()).filter(Boolean);
      segment = segment.slice(0, methodsMatch.index).trim();
    }

    while (stack.length > 0 && (stack.at(-1)?.depth ?? 0) >= depth) stack.pop();
    stack.push({ depth, segment });

    if (methods.length > 0) {
      const path = stack.map((s) => s.segment).join('');
      const normalized = ('/' + path.replace(/^\/+/, '')).replace(/\/+$/, '') || '/';
      for (const method of methods) {
        if (method === 'HEAD' || method === 'OPTIONS') continue;
        routes.add(`${method} ${normalized}`);
      }
    }
  }

  return [...routes].sort();
}

describe('matrix completeness — a new route with no entry fails CI (§15.2)', () => {
  it('has a matrix entry for every registered route', () => {
    const missing = registeredRoutes().filter((route) => !MATRIX_KEYS.has(route));
    expect(
      missing,
      `These routes have no entry in test/authorization-matrix.ts. Add one — deciding what ` +
        `each role may do is part of adding an endpoint, not a follow-up:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('has no matrix entry for a route that no longer exists', () => {
    const registered = new Set(registeredRoutes());
    const stale = [...MATRIX_KEYS].filter((key) => !registered.has(key));
    expect(stale, `Stale matrix entries:\n  ${stale.join('\n  ')}`).toEqual([]);
  });

  it('declares an expectation for at least one role on every guarded route', () => {
    for (const entry of ENDPOINT_MATRIX) {
      if (entry.public) continue;
      expect(
        Object.keys(entry.expected).length,
        `${endpointKey(entry.method, entry.path)} grants nothing to anyone`,
      ).toBeGreaterThan(0);
    }
  });
});

/**
 * Fills route parameters with ids from the fixture world.
 *
 * "In scope" is role-dependent, which is the whole point of PART 6. A COORDINATOR's
 * in-scope user is any member of their Unit; a CONSULTANT's or ZONE_LEADER's is only
 * *themselves*, because those roles hold `own_record` on `user:read`. Pointing the sweep at
 * a Unit colleague for them would assert the opposite of what the matrix says.
 */
function resolvePath(
  entry: EndpointExpectation,
  scope: 'inScope' | 'outOfScope',
  role?: Role,
): string {
  const unitId = scope === 'inScope' ? world.unitA : world.unitB;

  const ownRecordRole = role === 'CONSULTANT' || role === 'ZONE_LEADER';
  const inScopeUser = ownRecordRole && role ? world.actors[role].userId : world.inScopeUserId;
  const userId = scope === 'inScope' ? inScopeUser : world.outOfScopeUserId;

  // `:id` means different things on different routes, which is exactly why it is
  // resolved here from the fixture rather than guessed per test.
  const zoneId = scope === 'inScope' ? world.zoneA : world.zoneB;
  const idFor = entry.path.startsWith('/api/v1/zones/')
    ? zoneId
    : entry.path.includes('/units/')
      ? unitId
      : userId;

  return entry.path
    .replace(':membershipId', '00000000-0000-4000-8000-000000000000')
    .replace(':id', idFor);
}

const sweepable = ENDPOINT_MATRIX.filter((entry) => !entry.public && !entry.coveredBy);

describe.each(sweepable.map((e) => [endpointKey(e.method, e.path), e] as const))(
  '%s',
  (_key, entry) => {
    it.each(ROLES)('%s in scope', async (role: Role) => {
      const actor = world.actors[role];
      const expectation = entry.expected[role];
      const response = await world.request(entry.method, resolvePath(entry, 'inScope', role), {
        token: actor.accessToken,
      });

      // A role with no entry holds no permission at all: 403 from PermissionGuard.
      const expected = expectation?.inScope ?? 403;
      expect(
        response.status,
        `${role} ${entry.method} ${entry.path} in scope: ${JSON.stringify(response.body)}`,
      ).toBe(expected);
    });

    it.each(ROLES)('%s out of scope', async (role: Role) => {
      if (!entry.path.includes(':')) return;

      const actor = world.actors[role];
      const expectation = entry.expected[role];
      const response = await world.request(entry.method, resolvePath(entry, 'outOfScope', role), {
        token: actor.accessToken,
      });

      // AZ-3: a read outside scope is 404 so IDs cannot be probed for existence.
      const fallback = entry.method === 'GET' ? 404 : 403;
      const expected = expectation ? (expectation.outOfScope ?? fallback) : 403;
      expect(
        response.status,
        `${role} ${entry.method} ${entry.path} out of scope: ${JSON.stringify(response.body)}`,
      ).toBe(expected);
    });

    it('unauthenticated', async () => {
      const response = await world.request(entry.method, resolvePath(entry, 'inScope'));
      expect(response.status).toBe(401);
    });

    it('expired token', async () => {
      const token = await expiredToken(world.app, world.actors.SUPER_ADMIN.userId, 'SUPER_ADMIN');
      const response = await world.request(entry.method, resolvePath(entry, 'inScope'), { token });
      expect(response.status).toBe(401);
      expect((response.body as { code?: string }).code).toBe('TOKEN_EXPIRED');
    });
  },
);

describe('the cases ARCHITECTURE.md §6.4 and §15.2 name explicitly', () => {
  it('Coordinator → another Unit’s record returns 404, not 403', async () => {
    const response = await world.request('GET', `/api/v1/units/${world.unitB}`, {
      token: world.actors.COORDINATOR.accessToken,
    });
    expect(response.status).toBe(404);
    expect((response.body as { code: string }).code).toBe('NOT_FOUND');
  });

  it('Consultant → POST /reports/generate is denied by the absent permission (N5)', async () => {
    // The reports module lands in Phase 7. What is asserted now is the rule that produces
    // that 403: the Consultant role simply holds no `report:generate` grant.
    const { grantFor } = await import('@audit5s/domain');
    expect(grantFor('CONSULTANT', 'report:generate')).toBeNull();
  });

  it('Coordinator renaming their own Unit returns 403 FIELD_NOT_EDITABLE naming the field', async () => {
    const response = await world.request('PATCH', `/api/v1/units/${world.unitA}`, {
      token: world.actors.COORDINATOR.accessToken,
      body: { name: 'Renamed' },
    });
    expect(response.status).toBe(403);
    const body = response.body as { code: string; errors?: Array<{ field: string }> };
    expect(body.code).toBe('FIELD_NOT_EDITABLE');
    expect(body.errors?.map((e) => e.field)).toContain('name');
  });

  it('…while the Coordinator-editable fields on the same Unit still succeed', async () => {
    const response = await world.request('PATCH', `/api/v1/units/${world.unitA}`, {
      token: world.actors.COORDINATOR.accessToken,
      body: { city: 'Nashik' },
    });
    expect(response.status).toBe(200);
  });

  it('a revoked Consultant loses the Unit immediately, not at token expiry', async () => {
    const consultant = world.actors.CONSULTANT;

    const before = await world.request('GET', '/api/v1/units', { token: consultant.accessToken });
    expect((before.body as { data: unknown[] }).data).toHaveLength(1);

    await world.owner.query(
      `UPDATE unit_membership SET status='REVOKED', valid_to=now()
       WHERE user_id = $1 AND status='ACTIVE'`,
      [consultant.userId],
    );

    // Same access token, still unexpired. Scope is resolved from the database on every
    // request precisely so this takes effect now (§12.3).
    const after = await world.request('GET', '/api/v1/units', { token: consultant.accessToken });
    expect((after.body as { data: unknown[] }).data).toHaveLength(0);

    await world.owner.query(
      `UPDATE unit_membership SET status='ACTIVE', valid_to=NULL WHERE user_id = $1`,
      [consultant.userId],
    );
  });

  it('the audit log is readable by a Super Admin and by nobody else', async () => {
    const allowed = await world.request('GET', '/api/v1/audit-logs', {
      token: world.actors.SUPER_ADMIN.accessToken,
    });
    expect(allowed.status).toBe(200);

    for (const role of ['CONSULTANT', 'COORDINATOR', 'ZONE_LEADER'] as const) {
      const denied = await world.request('GET', '/api/v1/audit-logs', {
        token: world.actors[role].accessToken,
      });
      expect(denied.status, `${role} must not read the audit log`).toBe(403);
    }
  });
});

describe('the seeded matrix matches PART 6 (§12.4)', () => {
  it('exposes exactly the permissions packages/domain defines', async () => {
    const { PERMISSION_MATRIX } = await import('@audit5s/domain');
    const response = await world.request('GET', '/api/v1/role-permissions', {
      token: world.actors.SUPER_ADMIN.accessToken,
    });
    expect(response.status).toBe(200);

    const body = response.body as { matrixSize: number; seededSize: number };
    // The document, the seed and the runtime cannot drift: the seed is generated from the
    // same table the guards read.
    expect(body.seededSize).toBe(PERMISSION_MATRIX.length);
    expect(body.matrixSize).toBe(PERMISSION_MATRIX.length);
  });
});
