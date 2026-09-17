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
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
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
const GONE = 410;

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
    path: '/api/v1/auth/reset-password',
    description:
      'Completes the emailed link. Public by necessity — the caller cannot sign in, which ' +
      'is why they are here. The token is the credential, and an invalid, expired or ' +
      'already-spent one is refused with the same code so it says nothing about which.',
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
    path: '/api/v1/users/:id/archive',
    description: 'user:archive — a Super Admin only; removal is archival, never deletion (R-25, D8)',
    expected: {
      SUPER_ADMIN: { inScope: NO_CONTENT, outOfScope: NO_CONTENT },
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

  // ------------------------------------------------------------------- zones
  {
    method: 'POST',
    path: '/api/v1/units/:id/zones',
    description: 'zone:create — SUPER_ADMIN organization; COORDINATOR own_unit',
    expected: {
      SUPER_ADMIN: { inScope: CREATED },
      COORDINATOR: { inScope: CREATED, outOfScope: NOT_FOUND },
    },
    coveredBy: 'zones.e2e.test.ts',
  },
  {
    method: 'GET',
    path: '/api/v1/units/:id/zones',
    description: 'zone:read — the Zone dropdown source, active Zones by default',
    expected: {
      SUPER_ADMIN: { inScope: OK, outOfScope: OK },
      CONSULTANT: { inScope: OK, outOfScope: NOT_FOUND },
      COORDINATOR: { inScope: OK, outOfScope: NOT_FOUND },
      ZONE_LEADER: { inScope: OK, outOfScope: NOT_FOUND },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/zones',
    description: 'zone:read, scope-filtered across every Unit the actor may touch',
    expected: {
      SUPER_ADMIN: { inScope: OK },
      CONSULTANT: { inScope: OK },
      COORDINATOR: { inScope: OK },
      ZONE_LEADER: { inScope: OK },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/zones/:id',
    description: 'zone:read on one Zone; §6.4 — another Unit’s Zone is 404, not 403',
    expected: {
      SUPER_ADMIN: { inScope: OK, outOfScope: OK },
      CONSULTANT: { inScope: OK, outOfScope: NOT_FOUND },
      COORDINATOR: { inScope: OK, outOfScope: NOT_FOUND },
      ZONE_LEADER: { inScope: OK, outOfScope: NOT_FOUND },
    },
  },
  {
    method: 'PATCH',
    path: '/api/v1/zones/:id',
    description: 'zone:update — a description edit never touches history (D6)',
    expected: {
      SUPER_ADMIN: { inScope: OK, outOfScope: OK },
      COORDINATOR: { inScope: OK, outOfScope: NOT_FOUND },
    },
    coveredBy: 'zones.e2e.test.ts',
  },
  {
    method: 'POST',
    path: '/api/v1/zones/:id/leader',
    description: 'zone:assign_leader — a responsibility pointer, not a grant (C2)',
    expected: {
      SUPER_ADMIN: { inScope: OK, outOfScope: NOT_FOUND },
      COORDINATOR: { inScope: OK, outOfScope: NOT_FOUND },
    },
    coveredBy: 'zones.e2e.test.ts',
  },
  {
    method: 'POST',
    path: '/api/v1/zones/:id/archive',
    description: 'zone:archive — 409 ZONE_HAS_IN_PROGRESS_AUDIT while an audit is running',
    expected: {
      SUPER_ADMIN: { inScope: NO_CONTENT, outOfScope: NO_CONTENT },
      COORDINATOR: { inScope: NO_CONTENT, outOfScope: NOT_FOUND },
    },
    coveredBy: 'zones.e2e.test.ts',
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

  // -------------------------------------------------------------- industries
  // The same shape as the checklist catalogue below it, and for the same reason: a sector
  // list carries no Unit-identifying data and labels a catalogue every client already
  // reads. Writing is a Super Admin's — what sector a business is in is not day-to-day
  // upkeep, and a Coordinator changing it would silently re-point their plant's auditors
  // at a different set of checklists.
  {
    method: 'GET',
    path: '/api/v1/industries',
    description: 'industry:read — the sector list, cached beside the catalogue it labels',
    expected: {
      SUPER_ADMIN: { inScope: OK },
      CONSULTANT: { inScope: OK },
      COORDINATOR: { inScope: OK },
      ZONE_LEADER: { inScope: OK },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/industries',
    description: 'industry:create — Super Admin only',
    expected: {
      SUPER_ADMIN: { inScope: CREATED },
      CONSULTANT: { inScope: DENIED },
      COORDINATOR: { inScope: DENIED },
      ZONE_LEADER: { inScope: DENIED },
    },
  },
  {
    method: 'PATCH',
    path: '/api/v1/industries/:id',
    description: 'industry:update — Super Admin only',
    expected: {
      SUPER_ADMIN: { inScope: OK, outOfScope: OK },
      CONSULTANT: { inScope: DENIED, outOfScope: DENIED },
      COORDINATOR: { inScope: DENIED, outOfScope: DENIED },
      ZONE_LEADER: { inScope: DENIED, outOfScope: DENIED },
    },
  },
  {
    method: 'DELETE',
    path: '/api/v1/industries/:id',
    description: 'industry:archive — Super Admin only; archives, never deletes (D8)',
    expected: {
      SUPER_ADMIN: { inScope: OK, outOfScope: OK },
      CONSULTANT: { inScope: DENIED, outOfScope: DENIED },
      COORDINATOR: { inScope: DENIED, outOfScope: DENIED },
      ZONE_LEADER: { inScope: DENIED, outOfScope: DENIED },
    },
  },

  // -------------------------------------------------------------- checklists
  // Organization-wide reference data (D2): read is broad, write is Super Admin only.
  {
    method: 'GET',
    path: '/api/v1/checklist-templates',
    description: 'checklist_template:read — the catalogue every client caches',
    expected: {
      SUPER_ADMIN: { inScope: OK },
      CONSULTANT: { inScope: OK },
      COORDINATOR: { inScope: OK },
      ZONE_LEADER: { inScope: OK },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/checklist-templates/:id',
    description: 'checklist_template:read — one department; no Unit is involved',
    expected: {
      SUPER_ADMIN: { inScope: OK, outOfScope: OK },
      CONSULTANT: { inScope: OK, outOfScope: OK },
      COORDINATOR: { inScope: OK, outOfScope: OK },
      ZONE_LEADER: { inScope: OK, outOfScope: OK },
    },
    coveredBy: 'checklists.e2e.test.ts',
  },
  {
    method: 'PATCH',
    path: '/api/v1/checklist-templates/:id',
    description: 'checklist_template:update — SUPER_ADMIN only',
    expected: { SUPER_ADMIN: { inScope: OK, outOfScope: OK } },
    coveredBy: 'checklists.e2e.test.ts',
  },
  {
    method: 'GET',
    path: '/api/v1/checklist-versions',
    description: 'checklist_version:read — ?status=PUBLISHED is the catalogue-sync source',
    expected: {
      SUPER_ADMIN: { inScope: OK },
      CONSULTANT: { inScope: OK },
      COORDINATOR: { inScope: OK },
      ZONE_LEADER: { inScope: OK },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/checklist-versions/:id',
    description: 'checklist_version:read — immutable once published (CV-1), hence the ETag',
    expected: {
      SUPER_ADMIN: { inScope: OK, outOfScope: OK },
      CONSULTANT: { inScope: OK, outOfScope: OK },
      COORDINATOR: { inScope: OK, outOfScope: OK },
      ZONE_LEADER: { inScope: OK, outOfScope: OK },
    },
    coveredBy: 'checklists.e2e.test.ts',
  },
  {
    method: 'POST',
    path: '/api/v1/checklist-versions/:id/publish',
    description: 'checklist_version:publish — SUPER_ADMIN only; supersedes the previous',
    expected: { SUPER_ADMIN: { inScope: OK, outOfScope: OK } },
    coveredBy: 'checklists.e2e.test.ts',
  },
  {
    method: 'POST',
    path: '/api/v1/checklist-versions/:id/deactivate',
    description: 'checklist_version:deactivate — in-flight audits keep their pinned version',
    expected: { SUPER_ADMIN: { inScope: OK, outOfScope: OK } },
    coveredBy: 'checklists.e2e.test.ts',
  },

  // ----------------------------------------------------------- checklist import
  {
    method: 'POST',
    path: '/api/v1/checklist-imports',
    description: 'checklist_import:upload — SUPER_ADMIN only; multipart workbook',
    expected: { SUPER_ADMIN: { inScope: CREATED } },
    coveredBy: 'checklist-import.e2e.test.ts',
  },
  {
    method: 'GET',
    path: '/api/v1/checklist-imports',
    description: 'checklist_import:preview — the import history',
    expected: { SUPER_ADMIN: { inScope: OK } },
  },
  {
    method: 'GET',
    path: '/api/v1/checklist-imports/:jobId',
    description: 'checklist_import:preview — one job',
    expected: { SUPER_ADMIN: { inScope: OK, outOfScope: NOT_FOUND } },
    coveredBy: 'checklist-import.e2e.test.ts',
  },
  {
    method: 'POST',
    path: '/api/v1/checklist-imports/:jobId/validate',
    description: 'checklist_import:preview — enqueues stages 2–5 on worker-general (R-2)',
    expected: { SUPER_ADMIN: { inScope: 202, outOfScope: NOT_FOUND } },
    coveredBy: 'checklist-import.e2e.test.ts',
  },
  {
    method: 'GET',
    path: '/api/v1/checklist-imports/:jobId/preview',
    description: 'checklist_import:preview — stage 5; no writes have occurred',
    expected: { SUPER_ADMIN: { inScope: OK, outOfScope: NOT_FOUND } },
    coveredBy: 'checklist-import.e2e.test.ts',
  },
  {
    method: 'GET',
    path: '/api/v1/checklist-imports/:jobId/error-report',
    description: 'checklist_import:preview — the annotated .xlsx',
    expected: { SUPER_ADMIN: { inScope: OK, outOfScope: NOT_FOUND } },
    coveredBy: 'checklist-import.e2e.test.ts',
  },
  {
    method: 'POST',
    path: '/api/v1/checklist-imports/:jobId/commit',
    description: 'checklist_import:commit — stage 6, the first write to checklist_version',
    expected: { SUPER_ADMIN: { inScope: OK, outOfScope: NOT_FOUND } },
    coveredBy: 'checklist-import.e2e.test.ts',
  },

  // ---------------------------------------------------------- audit assignments
  {
    method: 'POST',
    path: '/api/v1/audit-assignments',
    description: 'audit_assignment:create — SUPER_ADMIN only; AA-1 checks the membership',
    expected: { SUPER_ADMIN: { inScope: CREATED } },
    coveredBy: 'audits.e2e.test.ts',
  },
  {
    method: 'GET',
    path: '/api/v1/audit-assignments',
    description: 'audit_assignment:read — CONSULTANT sees their own, COO/ZL their Unit’s',
    expected: {
      SUPER_ADMIN: { inScope: OK },
      CONSULTANT: { inScope: OK },
      COORDINATOR: { inScope: OK },
      ZONE_LEADER: { inScope: OK },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/audit-assignments/:assignmentId',
    description: 'audit_assignment:read on one record; out of scope is 404 (AZ-3)',
    expected: {
      SUPER_ADMIN: { inScope: OK, outOfScope: OK },
      CONSULTANT: { inScope: OK, outOfScope: NOT_FOUND },
      COORDINATOR: { inScope: OK, outOfScope: NOT_FOUND },
      ZONE_LEADER: { inScope: OK, outOfScope: NOT_FOUND },
    },
    coveredBy: 'audits.e2e.test.ts',
  },
  {
    method: 'POST',
    path: '/api/v1/audit-assignments/:assignmentId/cancel',
    description: 'audit_assignment:cancel — SUPER_ADMIN only; cancels, never deletes',
    expected: { SUPER_ADMIN: { inScope: OK, outOfScope: NOT_FOUND } },
    coveredBy: 'audits.e2e.test.ts',
  },

  // -------------------------------------------------------------------- audits
  {
    method: 'POST',
    path: '/api/v1/audits',
    description:
      'audit:create_external / create_walk_by / create_cross — the cell is chosen by the ' +
      'auditType in the body, because §8.6 gives creation one endpoint and PART 6 gives it three',
    expected: {
      SUPER_ADMIN: { inScope: CREATED },
      CONSULTANT: { inScope: CREATED },
      ZONE_LEADER: { inScope: CREATED },
    },
    coveredBy: 'audits.e2e.test.ts',
  },
  {
    method: 'GET',
    path: '/api/v1/audits',
    description: 'audit:read, scope-filtered; ?active=true is the live audit board',
    expected: {
      SUPER_ADMIN: { inScope: OK },
      CONSULTANT: { inScope: OK },
      COORDINATOR: { inScope: OK },
      ZONE_LEADER: { inScope: OK },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/audits/:auditId',
    description: 'audit:read — the audit with its Zones and responses',
    expected: {
      SUPER_ADMIN: { inScope: OK, outOfScope: OK },
      CONSULTANT: { inScope: OK, outOfScope: NOT_FOUND },
      COORDINATOR: { inScope: OK, outOfScope: NOT_FOUND },
      ZONE_LEADER: { inScope: OK, outOfScope: NOT_FOUND },
    },
    coveredBy: 'audits.e2e.test.ts',
  },
  {
    method: 'GET',
    path: '/api/v1/audits/:auditId/summary',
    description: 'report:score_summary — the Consultant read model (N6), never a PDF (N5)',
    expected: {
      SUPER_ADMIN: { inScope: OK, outOfScope: OK },
      CONSULTANT: { inScope: OK, outOfScope: NOT_FOUND },
      COORDINATOR: { inScope: OK, outOfScope: NOT_FOUND },
      ZONE_LEADER: { inScope: OK, outOfScope: NOT_FOUND },
    },
    coveredBy: 'audits.e2e.test.ts',
  },
  {
    method: 'POST',
    path: '/api/v1/audits/:auditId/start',
    description: 'audit:update — claims the single-writer lock; a second device gets 409 (D7)',
    expected: {
      SUPER_ADMIN: { inScope: OK, outOfScope: OK },
      CONSULTANT: { inScope: OK, outOfScope: NOT_FOUND },
      ZONE_LEADER: { inScope: OK, outOfScope: NOT_FOUND },
    },
    coveredBy: 'audits.e2e.test.ts',
  },
  {
    method: 'POST',
    path: '/api/v1/audits/:auditId/pause',
    description: 'audit:pause — abort saves and never discards (N7)',
    expected: {
      SUPER_ADMIN: { inScope: OK, outOfScope: OK },
      CONSULTANT: { inScope: OK, outOfScope: NOT_FOUND },
      ZONE_LEADER: { inScope: OK, outOfScope: NOT_FOUND },
    },
    coveredBy: 'audits.e2e.test.ts',
  },
  {
    method: 'POST',
    path: '/api/v1/audits/:auditId/resume',
    description: 'audit:resume — same auditor, from the persisted cursors',
    expected: {
      SUPER_ADMIN: { inScope: OK, outOfScope: OK },
      CONSULTANT: { inScope: OK, outOfScope: NOT_FOUND },
      ZONE_LEADER: { inScope: OK, outOfScope: NOT_FOUND },
    },
    coveredBy: 'audits.e2e.test.ts',
  },
  {
    method: 'POST',
    path: '/api/v1/audits/:auditId/complete',
    description: 'audit:complete — the server recomputes every score on this edge (D5)',
    expected: {
      SUPER_ADMIN: { inScope: OK, outOfScope: OK },
      CONSULTANT: { inScope: OK, outOfScope: NOT_FOUND },
      ZONE_LEADER: { inScope: OK, outOfScope: NOT_FOUND },
    },
    coveredBy: 'audits.e2e.test.ts',
  },
  {
    method: 'POST',
    path: '/api/v1/audits/:auditId/cancel',
    description: 'audit:cancel — SUPER_ADMIN only; every row is retained (A-1)',
    expected: { SUPER_ADMIN: { inScope: OK, outOfScope: OK } },
    coveredBy: 'audits.e2e.test.ts',
  },
  {
    method: 'POST',
    path: '/api/v1/audits/:auditId/release-device',
    description:
      'audit:release_device — D7’s force-release (§9.5 Layer 1). SUPER_ADMIN only, always ' +
      'audit-logged; it is what unblocks a lost phone and it changes nothing but the lock',
    expected: { SUPER_ADMIN: { inScope: OK, outOfScope: OK } },
    coveredBy: 'sync.e2e.test.ts',
  },
  {
    method: 'PATCH',
    path: '/api/v1/audits/:auditId/post-completion',
    description: 'audit:edit_after_completion — A-2’s only door, always audit-logged',
    expected: { SUPER_ADMIN: { inScope: OK, outOfScope: OK } },
    coveredBy: 'audits.e2e.test.ts',
  },
  {
    method: 'PUT',
    path: '/api/v1/audits/:auditId/zones/:auditZoneId',
    description: 'audit_zone:update — the upsert that takes the D6 snapshots on insert',
    expected: {
      SUPER_ADMIN: { inScope: OK, outOfScope: OK },
      CONSULTANT: { inScope: OK, outOfScope: NOT_FOUND },
      ZONE_LEADER: { inScope: OK, outOfScope: NOT_FOUND },
    },
    coveredBy: 'audits.e2e.test.ts',
  },
  {
    method: 'POST',
    path: '/api/v1/audits/:auditId/zones/:auditZoneId/complete',
    description: 'audit_zone:complete — guarded on every question of the pinned version (7.2)',
    expected: {
      SUPER_ADMIN: { inScope: OK, outOfScope: OK },
      CONSULTANT: { inScope: OK, outOfScope: NOT_FOUND },
      ZONE_LEADER: { inScope: OK, outOfScope: NOT_FOUND },
    },
    coveredBy: 'audits.e2e.test.ts',
  },
  {
    method: 'PUT',
    path: '/api/v1/audit-zones/:auditZoneId/responses/:responseId',
    description: 'question_response:upsert — device owner, audit not COMPLETED; idempotent',
    expected: {
      SUPER_ADMIN: { inScope: OK, outOfScope: OK },
      CONSULTANT: { inScope: OK, outOfScope: NOT_FOUND },
      ZONE_LEADER: { inScope: OK, outOfScope: NOT_FOUND },
    },
    coveredBy: 'audits.e2e.test.ts',
  },

  // ---------------------------------------------------------------- evidence
  {
    method: 'POST',
    path: '/api/v1/evidence/upload-intent',
    description:
      'evidence:create — the metadata half of §9.4. Field roles, and a Super Admin, who is ' +
      'refused nothing (R-18)',
    expected: {
      SUPER_ADMIN: { inScope: CREATED },
      CONSULTANT: { inScope: CREATED },
      ZONE_LEADER: { inScope: CREATED },
    },
    coveredBy: 'evidence.e2e.test.ts',
  },
  {
    method: 'POST',
    path: '/api/v1/evidence/:evidenceId/commit',
    description: 'evidence:create — HEAD, checksum, magic bytes, then E-1. Replaying it is §9.6',
    expected: {
      SUPER_ADMIN: { inScope: OK, outOfScope: OK },
      CONSULTANT: { inScope: OK, outOfScope: NOT_FOUND },
      ZONE_LEADER: { inScope: OK, outOfScope: NOT_FOUND },
    },
    coveredBy: 'evidence.e2e.test.ts',
  },
  {
    method: 'GET',
    path: '/api/v1/evidence/:evidenceId',
    description: 'evidence:read — metadata; a Coordinator and a Zone Leader get own_unit',
    expected: {
      SUPER_ADMIN: { inScope: OK, outOfScope: OK },
      CONSULTANT: { inScope: OK, outOfScope: NOT_FOUND },
      COORDINATOR: { inScope: OK, outOfScope: NOT_FOUND },
      ZONE_LEADER: { inScope: OK, outOfScope: NOT_FOUND },
    },
    coveredBy: 'evidence.e2e.test.ts',
  },
  {
    method: 'GET',
    path: '/api/v1/evidence/:evidenceId/view-url',
    description: 'evidence:view_url — a ≤300 s presigned GET, minted after the scope check (§12.6)',
    expected: {
      SUPER_ADMIN: { inScope: OK, outOfScope: OK },
      CONSULTANT: { inScope: OK, outOfScope: NOT_FOUND },
      COORDINATOR: { inScope: OK, outOfScope: NOT_FOUND },
      ZONE_LEADER: { inScope: OK, outOfScope: NOT_FOUND },
    },
    coveredBy: 'evidence.e2e.test.ts',
  },
  {
    method: 'GET',
    path: '/api/v1/audits/:auditId/evidence',
    description:
      'evidence:read — the audit-wide gallery: the same filters as the Zone listing, one ' +
      'level up, because the admin gallery and the summary report both ask what an audit found',
    expected: {
      SUPER_ADMIN: { inScope: OK, outOfScope: OK },
      CONSULTANT: { inScope: OK, outOfScope: NOT_FOUND },
      COORDINATOR: { inScope: OK, outOfScope: NOT_FOUND },
      ZONE_LEADER: { inScope: OK, outOfScope: NOT_FOUND },
    },
    coveredBy: 'evidence.e2e.test.ts',
  },
  {
    method: 'PATCH',
    path: '/api/v1/evidence/:evidenceId',
    description: 'evidence:set_summary_flag — a clash is 409 SUMMARY_FLAG_TAKEN, from the index',
    expected: {
      SUPER_ADMIN: { inScope: OK, outOfScope: OK },
      CONSULTANT: { inScope: OK, outOfScope: NOT_FOUND },
      ZONE_LEADER: { inScope: OK, outOfScope: NOT_FOUND },
    },
    coveredBy: 'evidence.e2e.test.ts',
  },
  {
    method: 'DELETE',
    path: '/api/v1/evidence/:evidenceId',
    description: 'evidence:soft_delete — soft, and 409 once the audit is completed (E-4)',
    expected: {
      SUPER_ADMIN: { inScope: OK, outOfScope: OK },
      CONSULTANT: { inScope: OK, outOfScope: NOT_FOUND },
      ZONE_LEADER: { inScope: OK, outOfScope: NOT_FOUND },
    },
    coveredBy: 'evidence.e2e.test.ts',
  },
  {
    method: 'GET',
    path: '/api/v1/audit-zones/:auditZoneId/evidence',
    description: 'evidence:read — the Zone gallery, filtered by classification',
    expected: {
      SUPER_ADMIN: { inScope: OK, outOfScope: OK },
      CONSULTANT: { inScope: OK, outOfScope: NOT_FOUND },
      COORDINATOR: { inScope: OK, outOfScope: NOT_FOUND },
      ZONE_LEADER: { inScope: OK, outOfScope: NOT_FOUND },
    },
    coveredBy: 'evidence.e2e.test.ts',
  },

  // ------------------------------------------------------- corrective actions
  {
    method: 'GET',
    path: '/api/v1/corrective-actions',
    description:
      'corrective_action:read — the queue; a Consultant sees what their own audits raised, ' +
      'a Coordinator and a Zone Leader their Unit’s',
    expected: {
      SUPER_ADMIN: { inScope: OK },
      CONSULTANT: { inScope: OK },
      COORDINATOR: { inScope: OK },
      ZONE_LEADER: { inScope: OK },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/corrective-actions/:correctiveActionId',
    description: 'corrective_action:read — one action with its whole submission history (§8.8)',
    expected: {
      SUPER_ADMIN: { inScope: OK, outOfScope: OK },
      CONSULTANT: { inScope: OK, outOfScope: NOT_FOUND },
      COORDINATOR: { inScope: OK, outOfScope: NOT_FOUND },
      ZONE_LEADER: { inScope: OK, outOfScope: NOT_FOUND },
    },
    coveredBy: 'corrective-actions.e2e.test.ts',
  },
  {
    method: 'POST',
    path: '/api/v1/corrective-actions/:correctiveActionId/submissions',
    description:
      'corrective_action:submit — Option A or B, one action, Idempotency-Key required. A ' +
      'Zone Leader of the Unit, assigned or not (R-3b), or a Super Admin (R-18)',
    expected: { SUPER_ADMIN: { inScope: CREATED, outOfScope: CREATED }, ZONE_LEADER: { inScope: CREATED, outOfScope: NOT_FOUND } },
    coveredBy: 'corrective-actions.e2e.test.ts',
  },
  {
    method: 'POST',
    path: '/api/v1/corrective-actions/:correctiveActionId/verify',
    description: 'corrective_action:verify — Super Admin only; may close the audit',
    expected: { SUPER_ADMIN: { inScope: OK, outOfScope: OK } },
    coveredBy: 'corrective-actions.e2e.test.ts',
  },
  {
    method: 'POST',
    path: '/api/v1/corrective-actions/:correctiveActionId/reopen',
    description: 'corrective_action:reopen — Super Admin only, reason required, attempts kept',
    expected: { SUPER_ADMIN: { inScope: OK, outOfScope: OK } },
    coveredBy: 'corrective-actions.e2e.test.ts',
  },
  {
    method: 'POST',
    path: '/api/v1/corrective-actions/:correctiveActionId/reassign',
    description: 'corrective_action:reassign — a Super Admin, or the Coordinator of the Unit',
    expected: {
      SUPER_ADMIN: { inScope: OK, outOfScope: OK },
      COORDINATOR: { inScope: OK, outOfScope: NOT_FOUND },
    },
    coveredBy: 'corrective-actions.e2e.test.ts',
  },

  // ---------------------------------------------------------------- reports
  /*
   * N5/C4: the official PDF is a Super Admin deliverable, and a Consultant holds **no**
   * cell for `report:generate` at all — so they are refused 403 by `PermissionGuard`
   * rather than 404 by a scope. That distinction is the point of the row and is asserted
   * explicitly in reports.e2e.test.ts.
   *
   * Coordinator and Zone Leader read and download their own Unit's reports (`own_unit`)
   * and can do nothing else here.
   */
  {
    method: 'POST',
    path: '/api/v1/reports/generate',
    description: 'report:generate — Super Admin only (N5). 202; the render is a queued job',
    expected: { SUPER_ADMIN: { inScope: 202, outOfScope: 202 } },
    coveredBy: 'reports.e2e.test.ts',
  },
  {
    method: 'POST',
    path: '/api/v1/reports/preview',
    description: 'report:generate — HTML for template iteration; no snapshot, no PDF, no token',
    expected: { SUPER_ADMIN: { inScope: OK, outOfScope: OK } },
    coveredBy: 'reports.e2e.test.ts',
  },
  {
    method: 'GET',
    path: '/api/v1/reports',
    description: 'report:read_snapshot — the version history, newest first (§10.5)',
    expected: {
      SUPER_ADMIN: { inScope: OK },
      COORDINATOR: { inScope: OK },
      ZONE_LEADER: { inScope: OK },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/reports/:snapshotId',
    description: 'report:read_snapshot — metadata and status',
    expected: {
      SUPER_ADMIN: { inScope: OK, outOfScope: OK },
      COORDINATOR: { inScope: OK, outOfScope: NOT_FOUND },
      ZONE_LEADER: { inScope: OK, outOfScope: NOT_FOUND },
    },
    coveredBy: 'reports.e2e.test.ts',
  },
  {
    method: 'GET',
    path: '/api/v1/reports/:snapshotId/payload',
    description: 'report:read_snapshot — the frozen payload, for the on-screen preview',
    expected: {
      SUPER_ADMIN: { inScope: OK, outOfScope: OK },
      COORDINATOR: { inScope: OK, outOfScope: NOT_FOUND },
      ZONE_LEADER: { inScope: OK, outOfScope: NOT_FOUND },
    },
    coveredBy: 'reports.e2e.test.ts',
  },
  {
    method: 'GET',
    path: '/api/v1/reports/:snapshotId/download-url',
    description: 'report:download — a short-TTL presigned GET, minted after the scope check',
    expected: {
      SUPER_ADMIN: { inScope: OK, outOfScope: OK },
      COORDINATOR: { inScope: OK, outOfScope: NOT_FOUND },
      ZONE_LEADER: { inScope: OK, outOfScope: NOT_FOUND },
    },
    coveredBy: 'reports.e2e.test.ts',
  },
  {
    method: 'POST',
    path: '/api/v1/reports/:snapshotId/regenerate',
    description: 'report:generate — RS-1: version + 1; the original is untouched',
    expected: { SUPER_ADMIN: { inScope: 202, outOfScope: 202 } },
    coveredBy: 'reports.e2e.test.ts',
  },
  {
    method: 'GET',
    path: '/api/v1/reports/:snapshotId/tokens',
    description: 'report_access_token:mint — the minted links with their use counts',
    expected: { SUPER_ADMIN: { inScope: OK, outOfScope: OK } },
    coveredBy: 'reports.e2e.test.ts',
  },
  {
    method: 'POST',
    path: '/api/v1/reports/:snapshotId/tokens/:tokenId/revoke',
    description: 'report_access_token:revoke — AuditLog: report.token_revoked',
    expected: { SUPER_ADMIN: { inScope: OK, outOfScope: OK } },
    coveredBy: 'reports.e2e.test.ts',
  },

  // -------------------------------------- the public, signed-token surface (§10.4)
  /*
   * The role named here is `ZONE_LEADER`, and it is reached by a **link** rather than a
   * session: `SignedTokenGuard` resolves the token before the rest of the chain and
   * becomes the Zone Leader it was issued to. `PermissionGuard` and `ScopeGuard` then run
   * exactly as they do everywhere else — which is why these are not `public: true`, and
   * why the cells below are the real cells rather than a blanket exemption.
   *
   * `outOfScope` is 410, not 404, and it is the same 410 an invalid, revoked or expired
   * link gets: a link for another Unit's finding is simply a link this surface does not
   * recognise, and distinguishing the cases would make the surface enumerable (§10.4,
   * "no enumeration"). A bearer token on these routes is refused the same way.
   *
   * `coveredBy` because the generic sweep authenticates with a bearer token, which is
   * precisely what these routes do not accept. `report-tokens.e2e.test.ts` drives the
   * whole surface — a valid link, an expired one, a revoked one, one for another Unit.
   */
  {
    method: 'GET',
    path: '/api/v1/public/corrective-actions/:token',
    description: 'signed_token — one corrective action, no listing, no siblings (§8.8)',
    expected: { ZONE_LEADER: { inScope: OK, outOfScope: GONE } },
    coveredBy: 'report-tokens.e2e.test.ts',
  },
  {
    method: 'POST',
    path: '/api/v1/public/corrective-actions/:token/upload-intent',
    description: 'signed_token — the live-capture after-photo; isLiveCapture must be true',
    expected: { ZONE_LEADER: { inScope: CREATED, outOfScope: GONE } },
    coveredBy: 'report-tokens.e2e.test.ts',
  },
  {
    method: 'POST',
    path: '/api/v1/public/corrective-actions/:token/submissions',
    description: 'signed_token — the same domain service as the authenticated route (§8.8)',
    expected: { ZONE_LEADER: { inScope: CREATED, outOfScope: GONE } },
    coveredBy: 'report-tokens.e2e.test.ts',
  },

  // ----------------------------------------------------------- notifications
  {
    method: 'GET',
    path: '/api/v1/notifications',
    description: 'notification:read — the caller’s own centre, with the unread count',
    expected: {
      SUPER_ADMIN: { inScope: OK },
      CONSULTANT: { inScope: OK },
      COORDINATOR: { inScope: OK },
      ZONE_LEADER: { inScope: OK },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/notifications/read-all',
    description: 'notification:mark_read — the caller’s own, idempotent',
    expected: {
      SUPER_ADMIN: { inScope: OK },
      CONSULTANT: { inScope: OK },
      COORDINATOR: { inScope: OK },
      ZONE_LEADER: { inScope: OK },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/notifications/:notificationId/read',
    description: 'notification:mark_read — someone else’s notification reads as absent',
    expected: {
      SUPER_ADMIN: { inScope: OK, outOfScope: NOT_FOUND },
      CONSULTANT: { inScope: OK, outOfScope: NOT_FOUND },
      COORDINATOR: { inScope: OK, outOfScope: NOT_FOUND },
      ZONE_LEADER: { inScope: OK, outOfScope: NOT_FOUND },
    },
    coveredBy: 'notifications.e2e.test.ts',
  },
  {
    method: 'GET',
    path: '/api/v1/notification-preferences',
    description: 'notification_preference:update — the caller’s own grid, defaults filled in',
    expected: {
      SUPER_ADMIN: { inScope: OK },
      CONSULTANT: { inScope: OK },
      COORDINATOR: { inScope: OK },
      ZONE_LEADER: { inScope: OK },
    },
  },
  {
    method: 'PUT',
    path: '/api/v1/notification-preferences',
    description: 'notification_preference:update — IN_APP stays on whatever is sent (§5.9)',
    expected: {
      SUPER_ADMIN: { inScope: OK },
      CONSULTANT: { inScope: OK },
      COORDINATOR: { inScope: OK },
      ZONE_LEADER: { inScope: OK },
    },
    coveredBy: 'notifications.e2e.test.ts',
  },

  // ------------------------------------------------- the signed storage route (R-9)
  {
    method: 'PUT',
    path: '/api/v1/__local-object-storage/:encodedKey',
    description:
      'DECISIONS.md R-9 — the filesystem driver’s presigned PUT. Public by design: a ' +
      'presigned URL carries its own authority, which is the whole point of §5 having the ' +
      'device upload without an API session. Authorization is the HMAC and the expiry, ' +
      'verified before a byte is touched; with R2_ENDPOINT set this route answers 404',
    public: true,
    expected: {},
    coveredBy: 'evidence.e2e.test.ts',
  },
  {
    method: 'GET',
    path: '/api/v1/__local-object-storage/:encodedKey',
    description: 'R-9 — the filesystem driver’s presigned GET, signed and expiring (§12.6)',
    public: true,
    expected: {},
    coveredBy: 'evidence.e2e.test.ts',
  },

  // -------------------------------------------------------------------- sync
  {
    method: 'GET',
    path: '/api/v1/sync/catalogue',
    description: 'sync:pull — the offline bootstrap; device roles and a Super Admin (§8.11, R-18)',
    expected: {
      SUPER_ADMIN: { inScope: OK },
      CONSULTANT: { inScope: OK },
      ZONE_LEADER: { inScope: OK },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/sync/batch',
    description:
      'sync:push — the push path (§9.3). Answers 200 whatever happened inside: one ' +
      'malformed row produces a verdict, never a status that discards the other 99',
    expected: {
      SUPER_ADMIN: { inScope: OK },
      CONSULTANT: { inScope: OK },
      ZONE_LEADER: { inScope: OK },
    },
    coveredBy: 'sync.e2e.test.ts',
  },
  {
    method: 'GET',
    path: '/api/v1/sync/status',
    description: 'sync:pull — the server’s view of this device, so a field problem is diagnosable',
    expected: {
      SUPER_ADMIN: { inScope: OK },
      CONSULTANT: { inScope: OK },
      ZONE_LEADER: { inScope: OK },
    },
    coveredBy: 'sync.e2e.test.ts',
  },

  // ------------------------------------------------------------- sync conflicts
  {
    method: 'GET',
    path: '/api/v1/sync-conflicts',
    description: 'sync_conflict:read — the quarantine queue (§9.5 Layer 3); SUPER_ADMIN only',
    expected: { SUPER_ADMIN: { inScope: OK } },
  },
  {
    method: 'GET',
    path: '/api/v1/sync-conflicts/:conflictId',
    description: 'sync_conflict:read — one quarantined item, with its full incoming payload',
    expected: { SUPER_ADMIN: { inScope: OK, outOfScope: OK } },
    coveredBy: 'sync.e2e.test.ts',
  },
  {
    method: 'POST',
    path: '/api/v1/sync-conflicts/:conflictId/resolve',
    description:
      'sync_conflict:resolve — APPLY routes through the post-completion override so it is ' +
      'audit-logged; DISCARD marks it resolved and keeps the payload',
    expected: { SUPER_ADMIN: { inScope: OK, outOfScope: OK } },
    coveredBy: 'sync.e2e.test.ts',
  },

  // ----------------------------------------------------------------- devices
  {
    method: 'POST',
    path: '/api/v1/devices/register',
    description:
      'device:list — §8.11’s registration, idempotent on id. A device registers itself ' +
      'under whoever is signed in; there is no userId in the shape, so nobody registers ' +
      'a device for somebody else',
    expected: {
      SUPER_ADMIN: { inScope: OK },
      CONSULTANT: { inScope: OK },
      ZONE_LEADER: { inScope: OK },
    },
    coveredBy: 'sync.e2e.test.ts',
  },
  {
    method: 'GET',
    path: '/api/v1/devices',
    description: 'device:list — own_record for the field roles, organization for a Super Admin',
    expected: {
      SUPER_ADMIN: { inScope: OK },
      CONSULTANT: { inScope: OK },
      ZONE_LEADER: { inScope: OK },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/devices/:deviceId',
    description: 'device:list — a single device record',
    expected: {
      SUPER_ADMIN: { inScope: OK, outOfScope: OK },
      CONSULTANT: { inScope: NOT_FOUND, outOfScope: NOT_FOUND },
      ZONE_LEADER: { inScope: NOT_FOUND, outOfScope: NOT_FOUND },
    },
    coveredBy: 'sync.e2e.test.ts',
  },
  {
    method: 'POST',
    path: '/api/v1/devices/:deviceId/revoke',
    description:
      'device:revoke — revokes the device and its sessions. The audits it owns are released ' +
      'separately, because a credential decision is not an audit decision',
    expected: {
      SUPER_ADMIN: { inScope: OK, outOfScope: OK },
      CONSULTANT: { inScope: NOT_FOUND, outOfScope: NOT_FOUND },
      ZONE_LEADER: { inScope: NOT_FOUND, outOfScope: NOT_FOUND },
    },
    coveredBy: 'sync.e2e.test.ts',
  },

  // ------------------------------------------------------- roles/permissions
  {
    method: 'GET',
    path: '/api/v1/role-permissions',
    description: 'role_permission:read — SUPER_ADMIN only',
    expected: { SUPER_ADMIN: { inScope: OK } },
  },

  // ---------------------------------------------------------------- analytics
  {
    method: 'GET',
    path: '/api/v1/analytics/organization/overview',
    description: 'analytics:organization_dashboard — SUPER_ADMIN only',
    expected: { SUPER_ADMIN: { inScope: OK } },
  },
  ...[
    '/api/v1/analytics/units/:unitId/overview',
    '/api/v1/analytics/units/:unitId/trend',
    '/api/v1/analytics/units/:unitId/sections',
    '/api/v1/analytics/units/:unitId/zones/ranking',
    '/api/v1/analytics/units/:unitId/nonconformities/recurrent',
  ].map((path) => ({
    method: 'GET' as const,
    path,
    description: 'analytics:unit_dashboard — SUPER_ADMIN organization; COORDINATOR own_unit',
    expected: {
      SUPER_ADMIN: { inScope: OK, outOfScope: OK },
      COORDINATOR: { inScope: OK, outOfScope: NOT_FOUND },
    },
    coveredBy: 'analytics.e2e.test.ts',
  })),
  ...[
    '/api/v1/analytics/corrective-actions/closure',
    '/api/v1/analytics/activity/consultants',
    '/api/v1/analytics/activity/zone-leaders',
  ].map((path) => ({
    method: 'GET' as const,
    path,
    description: 'analytics:unit_dashboard — organization for SUPER_ADMIN, own_unit for COORDINATOR',
    expected: {
      SUPER_ADMIN: { inScope: OK },
      COORDINATOR: { inScope: OK },
    },
  })),
  {
    method: 'GET',
    path: '/api/v1/analytics/activity/me',
    description: 'analytics:own_activity — the actor’s own record',
    expected: {
      SUPER_ADMIN: { inScope: OK },
      CONSULTANT: { inScope: OK },
      COORDINATOR: { inScope: OK },
      ZONE_LEADER: { inScope: OK },
    },
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
