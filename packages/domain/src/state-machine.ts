import type {
  AssignmentStatus,
  AuditStatus,
  AuditZoneStatus,
  CorrectiveActionStatus,
  Role,
} from '@audit5s/contracts';

/**
 * The state machines of ARCHITECTURE.md PART 7, as a **table**.
 *
 * PART 7's opening sentence is the requirement: transitions are declared as data, not as
 * scattered `if` statements, and `canTransition` is the only way a status changes anywhere
 * — API handler, sync handler, worker or Super Admin override. That is what makes "status
 * is not an arbitrary string" true in practice rather than in intent.
 *
 * Two properties fall out of the shape and are the reason for it:
 *
 *   - **An absent edge is a denial.** Adding a status to the enum does not silently make
 *     it reachable; someone has to write the row.
 *   - **The actor is part of the edge.** `IN_PROGRESS → CANCELLED` is legal for a Super
 *     Admin and illegal for the auditor holding the device, and the table says so rather
 *     than a handler remembering to check.
 *
 * Guards that need to read the database (is every Zone complete? does the device still own
 * the audit?) are *not* here — this package is pure. They are named on the edge as
 * `requires`, and the service checks them before calling; `InvalidStateTransition` carries
 * the unmet name so the failure is legible in a log rather than a bare 409.
 */

/** The entities that have a state machine. */
export type StateMachineEntity = 'audit' | 'audit_zone' | 'audit_assignment' | 'corrective_action';

/**
 * A precondition the pure layer cannot evaluate. The service resolves each into a boolean
 * and hands the result in; naming them here keeps the guard list next to the edge it
 * guards rather than in whichever handler happened to implement it.
 */
export type TransitionGuard =
  /** `owning_device_id` is free, or already this device (D7). */
  | 'device_owns_audit'
  /** Every `audit_zone` of the audit is COMPLETED, and there is at least one. */
  | 'all_zones_completed'
  /** Every question of the pinned checklist version has a response (7.2). */
  | 'all_questions_answered'
  /** At least one non-deleted evidence row — the WALK_BY minimum (7.2). */
  | 'has_evidence'
  /** A selfie evidence row exists, as `EXTERNAL_5S` / `CROSS_5S` / `WALK_BY` require. */
  | 'selfie_captured'
  /** The actor still holds an ACTIVE membership in the audit's Unit. */
  | 'membership_active'
  /** A free-text reason was supplied. Cancellation and rejection both demand one. */
  | 'reason_given';

export interface Transition<S extends string> {
  from: S;
  to: S;
  /** Roles that may make this move. Empty means the system makes it, never a user. */
  actors: readonly Role[];
  guards?: readonly TransitionGuard[];
  /** Why this edge exists, for the reader of the table. */
  note?: string;
}

/**
 * `audit` (7.1).
 *
 * `CANCELLED` is reachable from every pre-terminal status and only by a Super Admin, with
 * a reason. It is the strongest administrative action in the system and it still only sets
 * a status: invariant A-1 says no path deletes an audit, so there is no edge to `[*]`.
 */
export const AUDIT_TRANSITIONS: readonly Transition<AuditStatus>[] = [
  {
    from: 'ASSIGNED',
    to: 'READY',
    actors: ['CONSULTANT', 'ZONE_LEADER'],
    guards: ['selfie_captured'],
    note: 'Auditor opens the assignment; selfie and location are captured first',
  },
  {
    from: 'READY',
    to: 'IN_PROGRESS',
    actors: ['CONSULTANT', 'ZONE_LEADER'],
    guards: ['device_owns_audit', 'membership_active'],
    note: 'The device claims the single-writer lock (D7)',
  },
  {
    from: 'IN_PROGRESS',
    to: 'PAUSED',
    actors: ['CONSULTANT', 'ZONE_LEADER', 'SUPER_ADMIN'],
    note: 'Abort: save + pause + notify + resume (N7). Nothing is discarded',
  },
  {
    from: 'PAUSED',
    to: 'IN_PROGRESS',
    actors: ['CONSULTANT', 'ZONE_LEADER'],
    guards: ['device_owns_audit', 'membership_active'],
    note: 'Resume, from the persisted cursors',
  },
  {
    from: 'IN_PROGRESS',
    to: 'COMPLETED',
    actors: ['CONSULTANT', 'ZONE_LEADER'],
    guards: ['all_zones_completed'],
    note: 'Server recomputes every score on this edge (D5)',
  },
  {
    from: 'COMPLETED',
    to: 'CORRECTIVE_ACTION_OPEN',
    actors: [],
    note: 'System, on materialising the first nonconformity (Phase 6)',
  },
  {
    from: 'COMPLETED',
    to: 'CLOSED',
    actors: [],
    note: 'System, when a completed audit raised no nonconformity',
  },
  { from: 'CORRECTIVE_ACTION_OPEN', to: 'PARTIALLY_CLOSED', actors: [] },
  { from: 'CORRECTIVE_ACTION_OPEN', to: 'CLOSED', actors: [] },
  { from: 'PARTIALLY_CLOSED', to: 'CLOSED', actors: [] },
  { from: 'PARTIALLY_CLOSED', to: 'CORRECTIVE_ACTION_OPEN', actors: [] },
  {
    from: 'CLOSED',
    to: 'PARTIALLY_CLOSED',
    actors: ['SUPER_ADMIN'],
    note: 'A Super Admin reopens a corrective action after the fact',
  },
  ...(['ASSIGNED', 'READY', 'IN_PROGRESS', 'PAUSED'] as const).map((from) => ({
    from,
    to: 'CANCELLED' as const,
    actors: ['SUPER_ADMIN'] as const,
    guards: ['reason_given'] as const,
    note: 'Administrative voiding. Every row is retained (A-1)',
  })),
];

/**
 * `audit_zone` (7.2).
 *
 * `COMPLETED → IN_PROGRESS` exists for the Super Admin reopen, and only while the parent
 * audit is not itself COMPLETED — that condition is A-2's, enforced by the trigger in
 * migration 0006 and by the service, not expressible as an edge here.
 */
export const AUDIT_ZONE_TRANSITIONS: readonly Transition<AuditZoneStatus>[] = [
  {
    from: 'DRAFT',
    to: 'IN_PROGRESS',
    actors: ['CONSULTANT', 'ZONE_LEADER'],
    guards: ['device_owns_audit'],
    note: 'First response saved, or first photo captured on a walk-by',
  },
  {
    from: 'IN_PROGRESS',
    to: 'COMPLETED',
    actors: ['CONSULTANT', 'ZONE_LEADER'],
    guards: ['all_questions_answered'],
    note: 'Finish a scored Zone (EXTERNAL_5S, CROSS_5S). Section scores are written here',
  },
  {
    // §7.2's guard table gives this move two forms, by audit type: a scored Zone needs
    // every question answered, a walk-by needs "≥1 non-deleted evidence row" — the
    // "minimum one live photo per Zone" rule, which is the *whole* of a walk-by's
    // completion requirement because it has no questionnaire to answer (§2.7).
    //
    // Two edges rather than one edge with two guards, because the guards are alternatives
    // and not a conjunction: requiring both would make a walk-by uncompletable and a
    // scored Zone need a photograph it was never asked for. The service supplies whichever
    // guard the audit type makes applicable, so exactly one of these can ever be met.
    from: 'IN_PROGRESS',
    to: 'COMPLETED',
    actors: ['CONSULTANT', 'ZONE_LEADER'],
    guards: ['has_evidence'],
    note: 'Finish a WALK_BY Zone: at least one photograph (§7.2)',
  },
  {
    from: 'COMPLETED',
    to: 'IN_PROGRESS',
    actors: ['SUPER_ADMIN'],
    guards: ['reason_given'],
    note: 'Reopen; logged as audit.changed_after_completion (A-2)',
  },
];

/** `audit_assignment`. AA-1: revoking the membership cancels rather than deletes. */
export const ASSIGNMENT_TRANSITIONS: readonly Transition<AssignmentStatus>[] = [
  { from: 'ASSIGNED', to: 'ACCEPTED', actors: ['CONSULTANT', 'ZONE_LEADER'] },
  { from: 'ASSIGNED', to: 'IN_PROGRESS', actors: ['CONSULTANT', 'ZONE_LEADER'] },
  { from: 'ACCEPTED', to: 'IN_PROGRESS', actors: ['CONSULTANT', 'ZONE_LEADER'] },
  { from: 'IN_PROGRESS', to: 'COMPLETED', actors: ['CONSULTANT', 'ZONE_LEADER'] },
  {
    from: 'ASSIGNED',
    to: 'CANCELLED',
    actors: ['SUPER_ADMIN'],
    note: 'Also the system path when a membership is revoked (AA-1)',
  },
  { from: 'ACCEPTED', to: 'CANCELLED', actors: ['SUPER_ADMIN'] },
  { from: 'IN_PROGRESS', to: 'CANCELLED', actors: ['SUPER_ADMIN'] },
  { from: 'ASSIGNED', to: 'EXPIRED', actors: [], note: 'System, when due_at passes unstarted' },
  { from: 'ACCEPTED', to: 'EXPIRED', actors: [] },
];

/** `corrective_action` (7.3). Defined here in full; Phase 6 wires the endpoints to it. */
export const CORRECTIVE_ACTION_TRANSITIONS: readonly Transition<CorrectiveActionStatus>[] = [
  // R-23: an answer with an after-photo closes the item directly. The two edges into
  // ACTION_SUBMITTED stay so rows submitted before the change can still be reviewed.
  { from: 'OPEN', to: 'VERIFIED', actors: ['ZONE_LEADER'] },
  { from: 'REOPENED', to: 'VERIFIED', actors: ['ZONE_LEADER'] },
  { from: 'OPEN', to: 'ACTION_SUBMITTED', actors: ['ZONE_LEADER'] },
  { from: 'OPEN', to: 'NOT_POSSIBLE', actors: ['ZONE_LEADER'], guards: ['reason_given'] },
  { from: 'ACTION_SUBMITTED', to: 'VERIFIED', actors: ['SUPER_ADMIN'] },
  { from: 'ACTION_SUBMITTED', to: 'REOPENED', actors: ['SUPER_ADMIN'], guards: ['reason_given'] },
  { from: 'NOT_POSSIBLE', to: 'VERIFIED', actors: ['SUPER_ADMIN'] },
  { from: 'NOT_POSSIBLE', to: 'REOPENED', actors: ['SUPER_ADMIN'], guards: ['reason_given'] },
  { from: 'REOPENED', to: 'ACTION_SUBMITTED', actors: ['ZONE_LEADER'] },
  { from: 'REOPENED', to: 'NOT_POSSIBLE', actors: ['ZONE_LEADER'], guards: ['reason_given'] },
  { from: 'VERIFIED', to: 'REOPENED', actors: ['SUPER_ADMIN'], guards: ['reason_given'] },
];

const TABLES = {
  audit: AUDIT_TRANSITIONS,
  audit_zone: AUDIT_ZONE_TRANSITIONS,
  audit_assignment: ASSIGNMENT_TRANSITIONS,
  corrective_action: CORRECTIVE_ACTION_TRANSITIONS,
} as const satisfies Record<StateMachineEntity, readonly Transition<string>[]>;

/** What the caller knows that the table cannot: who is asking, and which guards hold. */
export interface TransitionContext {
  /**
   * `null` means the system is making the move — the audit rolling to
   * `CORRECTIVE_ACTION_OPEN`, an assignment expiring. Edges with an empty `actors` list are
   * exactly the system's, and a user may not take them however privileged.
   */
  role: Role | null;
  /** Guards the caller has already established. Anything unlisted is treated as unmet. */
  satisfied?: readonly TransitionGuard[];
}

export type TransitionRefusal =
  | { reason: 'NO_SUCH_EDGE' }
  | { reason: 'ROLE_NOT_PERMITTED'; allowedRoles: readonly Role[] }
  | { reason: 'GUARD_UNMET'; guard: TransitionGuard };

export type TransitionVerdict = { allowed: true } | ({ allowed: false } & TransitionRefusal);

/**
 * The one function every status change goes through.
 *
 * A same-status move (`COMPLETED → COMPLETED`) is **not** an edge and is refused here. The
 * endpoints that are idempotent — `complete`, `pause`, `start` — detect that case before
 * asking, and return the existing resource; letting it through the table instead would make
 * "already there" indistinguishable from "legally moved", which is precisely what the
 * audit-logged override path needs to tell apart.
 */
/**
 * Whether `role` may take `edge`. `null` is the system, which alone takes an edge with no
 * actors. R-18: a Super Admin takes any move a person may take.
 */
function admits(edge: Transition<string>, role: Role | null): boolean {
  if (role === null) return edge.actors.length === 0;
  if (edge.actors.length === 0) return false;
  return role === 'SUPER_ADMIN' || (edge.actors as readonly Role[]).includes(role);
}

export function canTransition(
  entity: StateMachineEntity,
  from: string,
  to: string,
  context: TransitionContext,
): TransitionVerdict {
  const edges = TABLES[entity].filter((edge) => edge.from === from && edge.to === to);
  if (edges.length === 0) {
    return { allowed: false, reason: 'NO_SUCH_EDGE' };
  }

  // A status pair may appear more than once only if a future table needs role-specific
  // guards on the same move; taking the first that admits the actor keeps that open.
  const permitted = edges.filter((edge) => admits(edge, context.role));

  if (permitted.length === 0) {
    const actors = [...new Set(edges.flatMap((edge) => edge.actors))];
    return { allowed: false, reason: 'ROLE_NOT_PERMITTED', allowedRoles: actors };
  }

  const satisfied = new Set(context.satisfied ?? []);
  let firstUnmet: TransitionGuard | null = null;

  for (const edge of permitted) {
    const unmet = (edge.guards ?? []).find((guard) => !satisfied.has(guard));
    if (!unmet) {
      return { allowed: true };
    }
    // The **first** edge's unmet guard, not the last. Where a move has alternative forms —
    // `audit_zone IN_PROGRESS → COMPLETED` has one for a scored Zone and one for a walk-by
    // — the refusal should name the guard of the canonical form, which is the one declared
    // first. Reporting whichever edge happened to be examined last makes the message
    // depend on table order rather than on what the caller was actually trying to do.
    firstUnmet ??= unmet;
  }

  return { allowed: false, reason: 'GUARD_UNMET', guard: firstUnmet! };
}

/**
 * Raised on an illegal transition. It carries the entity, both statuses and the refusal, so
 * the log line and the RFC 7807 detail both say *which* rule refused rather than "conflict".
 */
export class InvalidStateTransition extends Error {
  constructor(
    readonly entity: StateMachineEntity,
    readonly from: string,
    readonly to: string,
    readonly refusal: TransitionRefusal,
  ) {
    super(describeRefusal(entity, from, to, refusal));
    this.name = 'InvalidStateTransition';
  }
}

/** `canTransition`, but it raises. The service layer uses this; guards use the verdict. */
export function assertTransition(
  entity: StateMachineEntity,
  from: string,
  to: string,
  context: TransitionContext,
): void {
  const verdict = canTransition(entity, from, to, context);
  if (!verdict.allowed) {
    const { allowed: _allowed, ...refusal } = verdict;
    throw new InvalidStateTransition(entity, from, to, refusal as TransitionRefusal);
  }
}

function describeRefusal(
  entity: StateMachineEntity,
  from: string,
  to: string,
  refusal: TransitionRefusal,
): string {
  const move = `${entity} ${from} → ${to}`;
  switch (refusal.reason) {
    case 'NO_SUCH_EDGE':
      return `${move} is not a transition this state machine defines`;
    case 'ROLE_NOT_PERMITTED':
      return `${move} is not permitted for this role (allowed: ${
        refusal.allowedRoles.length > 0 ? refusal.allowedRoles.join(', ') : 'the system only'
      })`;
    case 'GUARD_UNMET':
      return `${move} is blocked: ${refusal.guard}`;
  }
}

/**
 * Every status reachable from `from` for this actor, ignoring guards. Drives UI affordances.
 *
 * De-duplicated, because a move may have more than one form: `audit_zone IN_PROGRESS →
 * COMPLETED` is declared twice, once for a scored Zone and once for a walk-by. They are
 * alternative routes to one destination, and a screen that rendered "Finish Zone" twice
 * would be showing the table's shape rather than the auditor's choices.
 */
export function nextStatuses(
  entity: StateMachineEntity,
  from: string,
  role: Role | null,
): string[] {
  const reachable = TABLES[entity]
    .filter(
      (edge) =>
        edge.from === from && admits(edge, role),
    )
    .map((edge) => edge.to);

  return [...new Set(reachable)];
}

/** The whole table for one entity, for tests and for the admin console's status legend. */
export function transitionsFor(entity: StateMachineEntity): readonly Transition<string>[] {
  return TABLES[entity];
}
