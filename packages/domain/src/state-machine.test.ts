import { describe, expect, it } from 'vitest';
import { AUDIT_STATUSES, AUDIT_ZONE_STATUSES, ROLES, type Role } from '@audit5s/contracts';
import {
  AUDIT_TRANSITIONS,
  AUDIT_ZONE_TRANSITIONS,
  InvalidStateTransition,
  assertTransition,
  canTransition,
  nextStatuses,
  transitionsFor,
  type StateMachineEntity,
  type TransitionGuard,
} from './state-machine';

/**
 * Every legal and illegal transition (PART 14, Phase 3 tests row).
 *
 * The illegal half is generated rather than listed: the cartesian product of the status
 * enum with itself, minus the table, must be refused. That is what makes "an absent edge is
 * a denial" a property of the system rather than of the cases someone remembered to write.
 */

const ALL_GUARDS: TransitionGuard[] = [
  'device_owns_audit',
  'all_zones_completed',
  'all_questions_answered',
  'has_evidence',
  'selfie_captured',
  'membership_active',
  'reason_given',
];

/** A context that satisfies every guard, so a case is testing the edge and not a guard. */
function asRole(role: Role | null) {
  return { role, satisfied: ALL_GUARDS };
}

describe('every edge in the table is legal for the actors it names', () => {
  for (const entity of ['audit', 'audit_zone', 'audit_assignment', 'corrective_action'] as const) {
    for (const edge of transitionsFor(entity)) {
      const actors = edge.actors.length > 0 ? edge.actors : [null];
      for (const actor of actors) {
        it(`${entity}: ${edge.from} → ${edge.to} as ${actor ?? 'the system'}`, () => {
          expect(canTransition(entity, edge.from, edge.to, asRole(actor))).toEqual({
            allowed: true,
          });
        });
      }
    }
  }
});

describe('every pair the table does not contain is refused', () => {
  const cases: Array<[StateMachineEntity, readonly string[]]> = [
    ['audit', AUDIT_STATUSES],
    ['audit_zone', AUDIT_ZONE_STATUSES],
  ];

  for (const [entity, statuses] of cases) {
    const edges = new Set(transitionsFor(entity).map((edge) => `${edge.from}→${edge.to}`));

    it(`${entity}: refuses all ${statuses.length * statuses.length - edges.size} non-edges`, () => {
      const wronglyAllowed: string[] = [];

      for (const from of statuses) {
        for (const to of statuses) {
          if (edges.has(`${from}→${to}`)) continue;
          for (const role of [...ROLES, null]) {
            const verdict = canTransition(entity, from, to, asRole(role));
            if (verdict.allowed) {
              wronglyAllowed.push(`${from} → ${to} as ${role ?? 'system'}`);
            }
          }
        }
      }

      expect(wronglyAllowed).toEqual([]);
    });
  }

  it('refuses a same-status move, which the idempotent endpoints handle before asking', () => {
    for (const status of AUDIT_STATUSES) {
      expect(canTransition('audit', status, status, asRole('SUPER_ADMIN')).allowed).toBe(false);
    }
  });

  it('refuses a status that is not in the enum at all', () => {
    expect(canTransition('audit', 'IN_PROGRESS', 'ARCHIVED', asRole('SUPER_ADMIN'))).toEqual({
      allowed: false,
      reason: 'NO_SUCH_EDGE',
    });
  });
});

describe('the actor is part of the edge', () => {
  it('lets a Super Admin cancel an in-progress audit and refuses the auditor holding it', () => {
    expect(canTransition('audit', 'IN_PROGRESS', 'CANCELLED', asRole('SUPER_ADMIN')).allowed).toBe(
      true,
    );

    const refused = canTransition('audit', 'IN_PROGRESS', 'CANCELLED', asRole('CONSULTANT'));
    expect(refused).toEqual({
      allowed: false,
      reason: 'ROLE_NOT_PERMITTED',
      allowedRoles: ['SUPER_ADMIN'],
    });
  });

  it('refuses a user on a system-only edge, however privileged', () => {
    for (const role of ROLES) {
      const verdict = canTransition('audit', 'COMPLETED', 'CLOSED', asRole(role));
      expect(verdict.allowed, `${role} must not close an audit by hand`).toBe(false);
    }
    expect(canTransition('audit', 'COMPLETED', 'CLOSED', asRole(null)).allowed).toBe(true);
  });

  it('permits a Coordinator nothing on an audit at all (PART 6)', () => {
    const reachable = AUDIT_STATUSES.flatMap((from) => nextStatuses('audit', from, 'COORDINATOR'));
    expect(reachable).toEqual([]);
  });
});

describe('guards', () => {
  it('blocks READY → IN_PROGRESS until the device owns the audit (D7)', () => {
    const verdict = canTransition('audit', 'READY', 'IN_PROGRESS', {
      role: 'CONSULTANT',
      satisfied: ['membership_active'],
    });
    expect(verdict).toEqual({ allowed: false, reason: 'GUARD_UNMET', guard: 'device_owns_audit' });
  });

  it('blocks IN_PROGRESS → COMPLETED until every Zone is complete', () => {
    expect(canTransition('audit', 'IN_PROGRESS', 'COMPLETED', { role: 'CONSULTANT' })).toEqual({
      allowed: false,
      reason: 'GUARD_UNMET',
      guard: 'all_zones_completed',
    });
  });

  it('blocks a Zone finishing before all fifty questions are answered (7.2)', () => {
    expect(
      canTransition('audit_zone', 'IN_PROGRESS', 'COMPLETED', { role: 'CONSULTANT' }),
    ).toEqual({ allowed: false, reason: 'GUARD_UNMET', guard: 'all_questions_answered' });
  });

  it('requires a reason to cancel', () => {
    expect(
      canTransition('audit', 'PAUSED', 'CANCELLED', { role: 'SUPER_ADMIN' }),
    ).toEqual({ allowed: false, reason: 'GUARD_UNMET', guard: 'reason_given' });
  });

  it('lets an abort through with no guard at all — N7 never blocks saving work', () => {
    expect(canTransition('audit', 'IN_PROGRESS', 'PAUSED', { role: 'CONSULTANT' })).toEqual({
      allowed: true,
    });
  });
});

describe('assertTransition', () => {
  it('raises InvalidStateTransition naming the entity, both statuses and the refusal', () => {
    let caught: unknown;
    try {
      assertTransition('audit', 'COMPLETED', 'IN_PROGRESS', asRole('CONSULTANT'));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InvalidStateTransition);
    const error = caught as InvalidStateTransition;
    expect(error.entity).toBe('audit');
    expect(error.from).toBe('COMPLETED');
    expect(error.to).toBe('IN_PROGRESS');
    expect(error.refusal.reason).toBe('NO_SUCH_EDGE');
    expect(error.message).toContain('audit COMPLETED → IN_PROGRESS');
  });

  it('says which guard blocked, not merely "conflict"', () => {
    expect(() =>
      assertTransition('audit', 'IN_PROGRESS', 'COMPLETED', { role: 'CONSULTANT' }),
    ).toThrow(/all_zones_completed/);
  });

  it('says which roles the edge does admit', () => {
    expect(() => assertTransition('audit', 'READY', 'CANCELLED', asRole('CONSULTANT'))).toThrow(
      /SUPER_ADMIN/,
    );
  });

  it('passes silently on a legal move', () => {
    expect(() => assertTransition('audit', 'IN_PROGRESS', 'PAUSED', asRole('CONSULTANT'))).not.toThrow();
  });
});

describe('the table matches the diagrams in PART 7', () => {
  it('has no edge that deletes an audit — CANCELLED is the strongest action (A-1, D8)', () => {
    expect(AUDIT_TRANSITIONS.every((edge) => AUDIT_STATUSES.includes(edge.to))).toBe(true);
    // Every pre-terminal status can be cancelled, and only by a Super Admin with a reason.
    for (const from of ['ASSIGNED', 'READY', 'IN_PROGRESS', 'PAUSED'] as const) {
      const edge = AUDIT_TRANSITIONS.find((e) => e.from === from && e.to === 'CANCELLED');
      expect(edge?.actors).toEqual(['SUPER_ADMIN']);
      expect(edge?.guards).toContain('reason_given');
    }
  });

  it('makes CANCELLED terminal', () => {
    expect(nextStatuses('audit', 'CANCELLED', 'SUPER_ADMIN')).toEqual([]);
    expect(nextStatuses('audit', 'CANCELLED', null)).toEqual([]);
  });

  it('lets a Super Admin reopen a completed Zone, and nobody else', () => {
    const edge = AUDIT_ZONE_TRANSITIONS.find(
      (e) => e.from === 'COMPLETED' && e.to === 'IN_PROGRESS',
    );
    expect(edge?.actors).toEqual(['SUPER_ADMIN']);
    expect(nextStatuses('audit_zone', 'COMPLETED', 'CONSULTANT')).toEqual([]);
  });

  it('offers the auditor exactly abort and finish while a Zone is in progress', () => {
    expect(nextStatuses('audit_zone', 'IN_PROGRESS', 'CONSULTANT')).toEqual(['COMPLETED']);
    expect(nextStatuses('audit', 'IN_PROGRESS', 'CONSULTANT').sort()).toEqual([
      'COMPLETED',
      'PAUSED',
    ]);
  });
});
