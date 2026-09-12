import { Injectable } from '@nestjs/common';
import type {
  CreateMembershipRequest,
  ListMembershipsQuery,
  MembershipDetail,
  Page,
  Role,
} from '@audit5s/contracts';
import type { ScopeContext } from '@audit5s/domain';
import { AppError } from '../../common/errors';
import { AssignmentsService } from '../audit-assignments/assignments.service';
import { isUniqueViolation } from '../../common/pg-errors';
import { AuditLogService } from '../../common/audit-log/audit-log.service';
import { DomainEvents } from '../../infrastructure/queue/domain-events';
import { UsersRepository } from '../users/users.repository';
import { AuthRepository } from '../auth/auth.repository';
import { MembershipsRepository } from './memberships.repository';

@Injectable()
export class MembershipsService {
  constructor(
    private readonly repository: MembershipsRepository,
    private readonly users: UsersRepository,
    private readonly auth: AuthRepository,
    private readonly assignments: AssignmentsService,
    private readonly auditLog: AuditLogService,
    private readonly events: DomainEvents,
  ) {}

  async assign(
    scope: ScopeContext,
    unitId: string,
    request: CreateMembershipRequest,
  ): Promise<MembershipDetail> {
    const user = await this.users.findById(scope, request.userId);
    if (!user) {
      throw AppError.notFound('No such user');
    }

    // The role is denormalised for fast predicates; a mismatch would corrupt every one of
    // them, so a supplied role that disagrees is refused rather than quietly overwritten.
    if (request.role && request.role !== user.role) {
      throw AppError.validation('Role does not match the user’s role', [
        { field: 'role', message: `This user is a ${user.role}` },
      ]);
    }

    if (user.role === 'SUPER_ADMIN') {
      throw AppError.conflict('CONFLICT', 'A Super Admin has organization scope, not a Unit');
    }

    try {
      const created = await this.repository.create(
        scope,
        { userId: user.id, unitId, role: user.role as Role },
        (tx) =>
          this.events.emit(tx, {
            type: 'UNIT_ASSIGNED',
            actorUserId: scope.actor.userId,
            unitId,
            resourceType: 'unit_membership',
            resourceId: null,
            userIds: [user.id],
            data: { role: user.role },
          }),
      );

      await this.auditLog.record({
        action: user.role === 'CONSULTANT' ? 'consultant.assigned' : 'coordinator.assigned',
        resourceType: 'unit_membership',
        resourceId: created.id,
        unitId,
        after: { userId: user.id, unitId, role: user.role },
      });

      const [detail] = await this.repository.list(scope, {
        limit: 1,
        userId: user.id,
        unitId,
        status: 'ACTIVE',
      } as ListMembershipsQuery);

      if (!detail) {
        throw AppError.internal('Membership created but could not be read back');
      }
      return toDetail(detail);
    } catch (error) {
      if (isUniqueViolation(error, 'unit_membership_one_active_admin')) {
        // Invariant M-1. `own_unit`'s LIMIT 1 is only deterministic because of this, so
        // the index refusing here is the invariant working, not an inconvenience.
        throw AppError.conflict(
          'MEMBERSHIP_LIMIT_EXCEEDED',
          `A ${user.role} may hold only one active Unit assignment. Revoke the existing one first.`,
        );
      }
      if (isUniqueViolation(error, 'unit_membership_active_pair_key')) {
        throw AppError.conflict('CONFLICT', 'This user is already assigned to this Unit');
      }
      throw error;
    }
  }

  /**
   * Revoking takes effect immediately, because scope is resolved from the database on
   * every request rather than carried in the access token (§12.3). The Consultant's next
   * call — including a sync push — no longer sees the Unit.
   */
  async revoke(scope: ScopeContext, membershipId: string): Promise<void> {
    const membership = await this.repository.findById(scope, membershipId);
    if (!membership) {
      throw AppError.notFound('No such membership');
    }

    const revoked = await this.repository.revoke(scope, membershipId, (tx) =>
      this.events.emit(tx, {
        type: 'UNIT_ACCESS_REVOKED',
        actorUserId: scope.actor.userId,
        unitId: membership.unitId,
        resourceType: 'unit_membership',
        resourceId: membershipId,
        userIds: [membership.userId],
        data: { role: membership.role },
      }),
    );
    if (!revoked) {
      throw AppError.conflict('CONFLICT', 'This membership is not active');
    }

    // Sessions are ended too: a revoked assignment should not leave a live token that can
    // still reach the rest of the application.
    await this.auth.revokeAllUserTokens(membership.userId);

    // Invariant AA-1: open assignments for this Unit are **cancelled**, never deleted, so
    // the record of what was asked for outlives the access to do it. The device drops them
    // on its next catalogue sync, because the catalogue carries only open ones.
    await this.assignments.cancelForRevokedMembership(scope, membership.userId, membership.unitId);

    await this.auditLog.record({
      action: membership.role === 'CONSULTANT' ? 'consultant.revoked' : 'coordinator.revoked',
      resourceType: 'unit_membership',
      resourceId: membershipId,
      unitId: membership.unitId,
      before: { status: 'ACTIVE' },
      after: { status: 'REVOKED', validTo: revoked.validTo?.toISOString() ?? null },
    });
  }

  async list(scope: ScopeContext, query: ListMembershipsQuery): Promise<Page<MembershipDetail>> {
    const rows = await this.repository.list(scope, query);
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    return {
      data: page.map(toDetail),
      nextCursor: hasMore ? (page.at(-1)?.membership.id ?? null) : null,
    };
  }
}

type Row = Awaited<ReturnType<MembershipsRepository['list']>>[number];

function toDetail(row: Row): MembershipDetail {
  return {
    id: row.membership.id,
    userId: row.membership.userId,
    unitId: row.membership.unitId,
    role: row.membership.role as Role,
    status: row.membership.status,
    validFrom: row.membership.validFrom.toISOString(),
    validTo: row.membership.validTo?.toISOString() ?? null,
    assignedByUserId: row.membership.assignedByUserId,
    createdAt: row.membership.createdAt.toISOString(),
    updatedAt: row.membership.updatedAt.toISOString(),
    userFullName: row.userFullName,
    userLoginId: row.userLoginId,
    unitCode: row.unitCode,
    unitName: row.unitName,
  };
}

