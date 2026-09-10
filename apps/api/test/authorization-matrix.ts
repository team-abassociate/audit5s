import type { Role } from '@audit5s/contracts';

/**
 * The authorization matrix, as test data (ARCHITECTURE.md §15.2).
 *
 * Every HTTP route × every role × {in-scope, out-of-scope, unauthenticated, expired token},
 * with the exact status each must return.
 *
 * **A route with no entry here fails CI.** That completeness check is what stops PART 6
 * from decaying into documentation that no longer describes the code: adding an endpoint
 * without deciding what each of the four roles may do with it is not possible.
 */

export type ScopeCase = 'inScope' | 'outOfScope';

export interface RoleExpectation {
  /** Status when the actor is inside scope. */
  inScope: number;
  /**
   * Status when the resource belongs to another Unit. Defaults to 404 for reads (AZ-3:
   * existence must not leak) and 403 for writes on a resource the actor can already read.
   */
  outOfScope?: number;
}

export interface EndpointExpectation {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** The Nest route path, exactly as the router reports it. */
  path: string;
  /** Human note; shown in test names. */
  description: string;
  /** `true` for routes deliberately outside the guard chain (`/auth/*`, `/health`). */
  public?: boolean;
  /** Expected status per role. A role absent from this map must be denied with 403. */
  expected: Partial<Record<Role, RoleExpectation>>;
  /**
   * Set where this route is exercised by a dedicated test instead of the generic sweep —
   * because it needs a body the sweep cannot invent, or has a side effect that would
   * disturb the shared fixture. The completeness check still requires the entry.
   */
  coveredBy?: string;
}

const DENIED = 403;
const NOT_FOUND = 404;
const OK = 200;
const CREATED = 201;
const NO_CONTENT = 204;

export const ENDPOINT_MATRIX: EndpointExpectation[] = [
  // ------------------------------------------------------------------ health
  {
    method: 'GET',
    path: '/api/v1/health',
    description: 'Liveness and a real database round trip',
    public: true,
    expected: {},
  },

  // -------------------------------------------------------------------- auth
  {
    method: 'POST',
    path: '/api/v1/auth/login',
    description: 'Login; rate-limited rather than authorized',
    public: true,
    expected: {},
    coveredBy: 'auth-lifecycle.e2e.test.ts',
  },
  {
    method: 'POST',
    path: '/api/v1/auth/refresh',
    description: 'Rotate a refresh token, with reuse detection (R-1)',
    public: true,
    expected: {},
    coveredBy: 'auth-lifecycle.e2e.test.ts',
  },
  {
    method: 'POST',
    path: '/api/v1/auth/logout',
    description: 'Revoke the token family',
    public: true,
    expected: {},
    coveredBy: 'auth-lifecycle.e2e.test.ts',
  },
  {
    method: 'POST',
    path: '/api/v1/auth/forgot-password',
    description: 'Always 202, so it is not a login-ID oracle',
    public: true,
    expected: {},
    coveredBy: 'auth-lifecycle.e2e.test.ts',
  },
  {
    method: 'POST',
    path: '/api/v1/auth/otp/request',
    description: 'OTP scaffold',
    public: true,
    expected: {},
    coveredBy: 'auth-lifecycle.e2e.test.ts',
  },
  {
    method: 'POST',
    path: '/api/v1/auth/otp/verify',
    description: 'OTP scaffold',
    public: true,
    expected: {},
    coveredBy: 'auth-lifecycle.e2e.test.ts',
  },
  {
    method: 'POST',
    path: '/api/v1/auth/change-password',
    description: 'user:reset_password on own_record; the way out of a forced reset',
    expected: {
      SUPER_ADMIN: { inScope: NO_CONTENT },
      CONSULTANT: { inScope: NO_CONTENT },
      COORDINATOR: { inScope: NO_CONTENT },
      ZONE_LEADER: { inScope: NO_CONTENT },
    },
    coveredBy: 'auth-lifecycle.e2e.test.ts',
  },
  {
    method: 'GET',
    path: '/api/v1/auth/me',
    description: 'user:read; returns the server-resolved scope',
    expected: {
      SUPER_ADMIN: { inScope: OK },
      CONSULTANT: { inScope: OK },
      COORDINATOR: { inScope: OK },
      ZONE_LEADER: { inScope: OK },
    },
  },

  // ------------------------------------------------------------------- users
  {
    method: 'POST',
    path: '/api/v1/users',
    description: 'user:create — SUPER_ADMIN organization; COORDINATOR own_unit, ZONE_LEADERs only',
    expected: {
      SUPER_ADMIN: { inScope: CREATED },
      COORDINATOR: { inScope: CREATED },
    },
    coveredBy: 'users.e2e.test.ts',
  },
  {
    method: 'GET',
    path: '/api/v1/users',
    description: 'user:read, scope-filtered list',
    expected: {
      SUPER_ADMIN: { inScope: OK },
      CONSULTANT: { inScope: OK },
      COORDINATOR: { inScope: OK },
      ZONE_LEADER: { inScope: OK },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/users/:id',
    description: 'user:read on one record; out of scope is 404, not 403 (AZ-3)',
    expected: {
      SUPER_ADMIN: { inScope: OK, outOfScope: OK },
      CONSULTANT: { inScope: OK, outOfScope: NOT_FOUND },
      COORDINATOR: { inScope: OK, outOfScope: NOT_FOUND },
      ZONE_LEADER: { inScope: OK, outOfScope: NOT_FOUND },
    },
  },
  {
    method: 'PATCH',
    path: '/api/v1/users/:id',
    description: 'user:update, field-level allow-list per role',
    expected: {
      SUPER_ADMIN: { inScope: OK, outOfScope: OK },
      CONSULTANT: { inScope: OK, outOfScope: DENIED },
      COORDINATOR: { inScope: OK, outOfScope: NOT_FOUND },
      ZONE_LEADER: { inScope: OK, outOfScope: DENIED },
    },
    coveredBy: 'users.e2e.test.ts',
  },
  {
    method: 'POST',
    path: '/api/v1/users/:id/disable',
    description: 'user:disable — COORDINATOR may disable ZONE_LEADERs only',
    expected: {
      SUPER_ADMIN: { inScope: NO_CONTENT, outOfScope: NO_CONTENT },
      COORDINATOR: { inScope: NO_CONTENT, outOfScope: NOT_FOUND },
    },
    coveredBy: 'users.e2e.test.ts',
  },
  {
    method: 'POST',
    path: '/api/v1/users/:id/reset-password',
    description: 'user:reset_password; issues a fresh bootstrap credential, returns none',
    expected: {
      SUPER_ADMIN: { inScope: OK, outOfScope: OK },
      CONSULTANT: { inScope: OK, outOfScope: NOT_FOUND },
      COORDINATOR: { inScope: OK, outOfScope: NOT_FOUND },
      ZONE_LEADER: { inScope: OK, outOfScope: NOT_FOUND },
    },
    coveredBy: 'users.e2e.test.ts',
  },

  // ------------------------------------------------------------------- units
  {
    method: 'POST',
    path: '/api/v1/units',
    description: 'unit:create — SUPER_ADMIN only',
    expected: { SUPER_ADMIN: { inScope: CREATED } },
    coveredBy: 'units.e2e.test.ts',
  },
  {
    method: 'GET',
    path: '/api/v1/units',
    description: 'unit:read; a Consultant sees only assigned Units',
    expected: {
      SUPER_ADMIN: { inScope: OK },
      CONSULTANT: { inScope: OK },
      COORDINATOR: { inScope: OK },
      ZONE_LEADER: { inScope: OK },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/units/:id',
    description: 'unit:read; §6.4 — a Coordinator reading another Unit gets 404',
    expected: {
      SUPER_ADMIN: { inScope: OK, outOfScope: OK },
      CONSULTANT: { inScope: OK, outOfScope: NOT_FOUND },
      COORDINATOR: { inScope: OK, outOfScope: NOT_FOUND },
      ZONE_LEADER: { inScope: OK, outOfScope: NOT_FOUND },
    },
  },
  {
    method: 'PATCH',
    path: '/api/v1/units/:id',
    description: 'unit:update_profile; a Coordinator sending name gets 403 FIELD_NOT_EDITABLE (U-1)',
    expected: {
      SUPER_ADMIN: { inScope: OK, outOfScope: OK },
      COORDINATOR: { inScope: OK, outOfScope: NOT_FOUND },
    },
    coveredBy: 'units.e2e.test.ts',
  },
  {
    method: 'POST',
    path: '/api/v1/units/:id/archive',
    description: 'unit:archive — SUPER_ADMIN only',
    expected: { SUPER_ADMIN: { inScope: NO_CONTENT, outOfScope: NO_CONTENT } },
    coveredBy: 'units.e2e.test.ts',
  },

  // ------------------------------------------------------------- memberships
  {
    method: 'POST',
    path: '/api/v1/units/:id/memberships',
    description: 'unit_membership:create — SUPER_ADMIN only',
    expected: { SUPER_ADMIN: { inScope: CREATED } },
    coveredBy: 'memberships.e2e.test.ts',
  },
  {
    method: 'DELETE',
    path: '/api/v1/units/:id/memberships/:membershipId',
    description: 'unit_membership:revoke — soft revoke; effective immediately',
    expected: { SUPER_ADMIN: { inScope: NO_CONTENT, outOfScope: NOT_FOUND } },
    coveredBy: 'memberships.e2e.test.ts',
  },
  {
    method: 'GET',
    path: '/api/v1/memberships',
    description: 'unit_membership:read, scope-filtered',
    expected: {
      SUPER_ADMIN: { inScope: OK },
      CONSULTANT: { inScope: OK },
      COORDINATOR: { inScope: OK },
      ZONE_LEADER: { inScope: OK },
    },
  },

  // ------------------------------------------------------- roles/permissions
  {
    method: 'GET',
    path: '/api/v1/role-permissions',
    description: 'role_permission:read — SUPER_ADMIN only',
    expected: { SUPER_ADMIN: { inScope: OK } },
  },

  // ---------------------------------------------------------------- audit log
  {
    method: 'GET',
    path: '/api/v1/audit-logs',
    description: 'audit_log:read — SUPER_ADMIN only (PART 6.3)',
    expected: { SUPER_ADMIN: { inScope: OK } },
  },
];

/** `METHOD path` — the key the completeness check compares on. */
export function endpointKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

export const MATRIX_KEYS = new Set(ENDPOINT_MATRIX.map((e) => endpointKey(e.method, e.path)));
