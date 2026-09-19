import { Injectable } from '@nestjs/common';
import type {
  AuditAssignment,
  CancelAuditAssignmentRequest,
  CreateAuditAssignmentRequest,
  ListAuditAssignmentsQuery,
  Page,
} from '@audit5s/contracts';
import { assertTransition, InvalidStateTransition, type ScopeContext } from '@audit5s/domain';
import { AppError } from '../../common/errors';
import { AuditLogService } from '../../common/audit-log/audit-log.service';
import { DomainEvents } from '../../infrastructure/queue/domain-events';
import { UnitsRepository } from '../units/units.repository';
import { AssignmentsRepository, type AssignmentRow } from './assignments.repository';

/**
 * Audit assignments (§5.5, PART 6 `audit_assignment:*`).
 *
 * Only a Super Admin creates or cancels one. For a Consultant, an open assignment is also
 * the temporary Unit-access grant. Zone Leaders remain tied to their permanent Unit.
 */
@Injectable()
export class AssignmentsService {
  constructor(
    private readonly repository: AssignmentsRepository,
    private readonly units: UnitsRepository,
    private readonly auditLog: AuditLogService,
    private readonly events: DomainEvents,
  ) {}

  async create(
    scope: ScopeContext,
    request: CreateAuditAssignmentRequest,
  ): Promise<AuditAssignment> {
    const unit = await this.units.findById(scope, request.unitId);
    if (!unit) {
      throw AppError.notFound('No such Unit');
    }

    const auditor = await this.repository.findActiveAuditor(scope, request.auditorUserId);
    if (!auditor) {
      throw AppError.validation('The assignee is not an active auditor', [
        { field: 'auditorUserId', message: 'Choose an active Consultant or Zone Leader' },
      ]);
    }

    // Consultants are independent of Units: this assignment itself grants temporary
    // access. Zone Leaders remain permanent Unit roles and may only audit their own Unit.
    if (
      auditor.role === 'ZONE_LEADER' &&
      !(await this.repository.isActiveMember(scope, request.auditorUserId, request.unitId))
    ) {
      throw AppError.validation('The Zone Leader is not an active member of this Unit', [
        { field: 'auditorUserId', message: 'Choose a Zone Leader from this Unit' },
      ]);
    }

    const id = await this.repository.create(scope, request, (tx, assignmentId) =>
      this.events.emit(tx, {
        type: 'AUDIT_ASSIGNED',
        actorUserId: scope.actor.userId,
        unitId: request.unitId,
        resourceType: 'audit_assignment',
        resourceId: assignmentId,
        userIds: [request.auditorUserId],
        data: {
          unitName: unit.name,
          auditType: request.auditType,
          dueAt: request.dueAt ?? null,
        },
      }),
    );
    const created = await this.mustFind(scope, id);

    await this.auditLog.record({
      action: 'audit_assignment.created',
      resourceType: 'audit_assignment',
      resourceId: id,
      unitId: request.unitId,
      after: {
        auditorUserId: created.auditorUserId,
        auditType: created.auditType,
        dueAt: created.dueAt?.toISOString() ?? null,
      },
    });

    return toAssignment(created);
  }

  async list(scope: ScopeContext, query: ListAuditAssignmentsQuery): Promise<Page<AuditAssignment>> {
    const rows = await this.repository.list(scope, query);
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    return { data: page.map(toAssignment), nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null };
  }

  async get(scope: ScopeContext, assignmentId: string): Promise<AuditAssignment> {
    return toAssignment(await this.mustFind(scope, assignmentId));
  }

  async cancel(
    scope: ScopeContext,
    assignmentId: string,
    request: CancelAuditAssignmentRequest,
  ): Promise<AuditAssignment> {
    const before = await this.mustFind(scope, assignmentId);

    // Idempotent: cancelling an already-cancelled assignment returns it unchanged rather
    // than raising, because a retried request is not an error.
    if (before.status === 'CANCELLED') {
      return toAssignment(before);
    }

    try {
      assertTransition('audit_assignment', before.status, 'CANCELLED', {
        role: scope.actor.role,
        satisfied: ['reason_given'],
      });
    } catch (error) {
      throw asAppError(error);
    }

    await this.repository.setStatus(scope, assignmentId, 'CANCELLED', {
      cancelReason: request.reason,
    });

    await this.auditLog.record({
      action: 'audit_assignment.cancelled',
      resourceType: 'audit_assignment',
      resourceId: assignmentId,
      unitId: before.unitId,
      before: { status: before.status },
      after: { status: 'CANCELLED', reason: request.reason },
    });

    return toAssignment(await this.mustFind(scope, assignmentId));
  }

  /**
   * AA-1's revocation path. Called by the membership module, never by a route.
   *
   * Cancels rather than deletes, so "this Consultant was asked to audit Nashik in March"
   * stays answerable after their access ends.
   */
  async cancelForRevokedMembership(
    scope: ScopeContext,
    auditorUserId: string,
    unitId: string,
  ): Promise<number> {
    const cancelled = await this.repository.cancelOpenForMembership(
      scope,
      auditorUserId,
      unitId,
      'Unit access revoked',
    );

    for (const id of cancelled) {
      await this.auditLog.recordSafely({
        action: 'audit_assignment.cancelled',
        resourceType: 'audit_assignment',
        resourceId: id,
        unitId,
        after: { status: 'CANCELLED', reason: 'Unit access revoked' },
      });
    }

    return cancelled.length;
  }

  private async mustFind(scope: ScopeContext, assignmentId: string): Promise<AssignmentRow> {
    const row = await this.repository.findById(scope, assignmentId);
    if (!row) {
      // AZ-3: out of scope reads as absent.
      throw AppError.notFound('No such assignment');
    }
    return row;
  }
}

/** An illegal transition is a 409 carrying the machine's own reason, never a bare conflict. */
export function asAppError(error: unknown): unknown {
  if (error instanceof InvalidStateTransition) {
    return AppError.conflict('INVALID_STATE_TRANSITION', error.message);
  }
  return error;
}

export function toAssignment(row: AssignmentRow): AuditAssignment {
  return {
    id: row.id,
    unitId: row.unitId,
    unitName: row.unitName,
    auditorUserId: row.auditorUserId,
    auditorName: row.auditorName,
    auditType: row.auditType,
    status: row.status,
    dueAt: row.dueAt?.toISOString() ?? null,
    instructions: row.instructions,
    suggestedZoneIds: row.suggestedZoneIds ?? [],
    createdByUserId: row.createdByUserId,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    cancelReason: row.cancelReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
