import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, sql, type SQL } from 'drizzle-orm';
import {
  auditAssignments,
  unitMemberships,
  units,
  users,
  type Database,
  type Transaction,
} from '@audit5s/db';
import type { ScopeContext } from '@audit5s/domain';
import type {
  CreateAuditAssignmentRequest,
  ListAuditAssignmentsQuery,
} from '@audit5s/contracts';
import { BaseRepository } from '../../common/repository/base.repository';
import { ScopeResolverRegistry } from '../../common/auth/resolvers';
import { DATABASE } from '../../infrastructure/database/database.module';
import { setActorContext } from '../users/users.repository';

/** Statuses a device still has to act on — what `?open=true` and the catalogue mean. */
export const OPEN_ASSIGNMENT_STATUSES = ['ASSIGNED', 'ACCEPTED', 'IN_PROGRESS'] as const;

const assignmentColumns = {
  id: auditAssignments.id,
  unitId: auditAssignments.unitId,
  unitName: units.name,
  auditorUserId: auditAssignments.auditorUserId,
  auditorName: users.fullName,
  auditType: auditAssignments.auditType,
  status: auditAssignments.status,
  dueAt: auditAssignments.dueAt,
  instructions: auditAssignments.instructions,
  suggestedZoneIds: auditAssignments.suggestedZoneIds,
  createdByUserId: auditAssignments.createdByUserId,
  cancelledAt: auditAssignments.cancelledAt,
  cancelReason: auditAssignments.cancelReason,
  createdAt: auditAssignments.createdAt,
  updatedAt: auditAssignments.updatedAt,
};

@Injectable()
export class AssignmentsRepository extends BaseRepository {
  constructor(@Inject(DATABASE) db: Database, resolvers: ScopeResolverRegistry) {
    super(db, resolvers);
  }

  /**
   * The scope columns for an assignment.
   *
   * PART 6 gives a Consultant `own_record` on `audit_assignment:read` — "assignee only" —
   * so `recordUserId` is the assignee, not the creator. A Coordinator and a Zone Leader
   * read their Unit's, so `unitId` is offered too.
   */
  private static columns() {
    return {
      unitId: auditAssignments.unitId,
      recordUserId: auditAssignments.auditorUserId,
      ownerUserId: auditAssignments.auditorUserId,
    };
  }

  async create(
    scope: ScopeContext,
    request: CreateAuditAssignmentRequest,
    afterWrite?: (tx: Transaction, id: string) => Promise<void>,
  ): Promise<string> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .insert(auditAssignments)
        .values({
          unitId: request.unitId,
          auditorUserId: request.auditorUserId,
          auditType: request.auditType,
          dueAt: request.dueAt ? new Date(request.dueAt) : null,
          instructions: request.instructions ?? null,
          suggestedZoneIds: request.suggestedZoneIds ?? null,
          createdByUserId: scope.actor.userId,
        })
        .returning({ id: auditAssignments.id });
      await afterWrite?.(tx as Transaction, row!.id);
      return row!.id;
    });
  }

  async findById(scope: ScopeContext, assignmentId: string) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .select(assignmentColumns)
        .from(auditAssignments)
        .innerJoin(units, eq(units.id, auditAssignments.unitId))
        .innerJoin(users, eq(users.id, auditAssignments.auditorUserId))
        .where(
          and(eq(auditAssignments.id, assignmentId), this.scoped(scope, AssignmentsRepository.columns())),
        )
        .limit(1);
      return row ?? null;
    });
  }

  async list(scope: ScopeContext, query: ListAuditAssignmentsQuery) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);

      const filters: Array<SQL | undefined> = [
        query.unitId ? eq(auditAssignments.unitId, query.unitId) : undefined,
        query.auditorUserId ? eq(auditAssignments.auditorUserId, query.auditorUserId) : undefined,
        query.status ? eq(auditAssignments.status, query.status) : undefined,
        query.open ? inArray(auditAssignments.status, [...OPEN_ASSIGNMENT_STATUSES]) : undefined,
        query.cursor ? gt(auditAssignments.id, query.cursor) : undefined,
      ];

      return tx
        .select(assignmentColumns)
        .from(auditAssignments)
        .innerJoin(units, eq(units.id, auditAssignments.unitId))
        .innerJoin(users, eq(users.id, auditAssignments.auditorUserId))
        .where(this.scoped(scope, AssignmentsRepository.columns(), ...filters))
        .orderBy(asc(auditAssignments.id))
        .limit(query.limit + 1);
    });
  }

  /** Every open assignment of one auditor — the device catalogue's slice. */
  async listOpenForAuditor(scope: ScopeContext, auditorUserId: string) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      return tx
        .select(assignmentColumns)
        .from(auditAssignments)
        .innerJoin(units, eq(units.id, auditAssignments.unitId))
        .innerJoin(users, eq(users.id, auditAssignments.auditorUserId))
        .where(
          this.scoped(
            scope,
            AssignmentsRepository.columns(),
            eq(auditAssignments.auditorUserId, auditorUserId),
            inArray(auditAssignments.status, [...OPEN_ASSIGNMENT_STATUSES]),
          ),
        )
        .orderBy(desc(auditAssignments.dueAt));
    });
  }

  async setStatus(
    scope: ScopeContext,
    assignmentId: string,
    status: 'ASSIGNED' | 'ACCEPTED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' | 'EXPIRED',
    options: { cancelReason?: string } = {},
  ): Promise<string | null> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .update(auditAssignments)
        .set({
          status,
          ...(status === 'CANCELLED'
            ? { cancelledAt: sql`now()`, cancelReason: options.cancelReason ?? null }
            : {}),
        })
        .where(
          and(eq(auditAssignments.id, assignmentId), this.scoped(scope, AssignmentsRepository.columns())),
        )
        .returning({ id: auditAssignments.id });
      return row?.id ?? null;
    });
  }

  /**
   * Whether this auditor holds an open assignment for this Unit — the matrix condition on
   * `audit:create_external` ("an active assignment must exist").
   */
  async findOpenForUnit(
    scope: ScopeContext,
    auditorUserId: string,
    unitId: string,
    auditType: 'EXTERNAL_5S' | 'CROSS_5S' | 'WALK_BY',
  ) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .select({ id: auditAssignments.id, status: auditAssignments.status })
        .from(auditAssignments)
        .where(
          and(
            eq(auditAssignments.auditorUserId, auditorUserId),
            eq(auditAssignments.unitId, unitId),
            eq(auditAssignments.auditType, auditType),
            inArray(auditAssignments.status, [...OPEN_ASSIGNMENT_STATUSES]),
          ),
        )
        .orderBy(asc(auditAssignments.dueAt))
        .limit(1);
      return row ?? null;
    });
  }

  /**
   * AA-1: revoking a membership **cancels** the auditor's open assignments for that Unit
   * rather than deleting them, so the record of what was asked for survives.
   *
   * Called from the membership-revoke path, which has no assignment scope of its own, so
   * it runs under the organization predicate the Super Admin doing the revoke already
   * holds. It is deliberately not a `DELETE`.
   */
  async cancelOpenForMembership(
    scope: ScopeContext,
    auditorUserId: string,
    unitId: string,
    reason: string,
  ): Promise<string[]> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const rows = await tx
        .update(auditAssignments)
        .set({ status: 'CANCELLED', cancelledAt: sql`now()`, cancelReason: reason })
        .where(
          and(
            eq(auditAssignments.auditorUserId, auditorUserId),
            eq(auditAssignments.unitId, unitId),
            inArray(auditAssignments.status, [...OPEN_ASSIGNMENT_STATUSES]),
          ),
        )
        .returning({ id: auditAssignments.id });
      return rows.map((row) => row.id);
    });
  }

  /** Whether the assignee holds an ACTIVE membership in the Unit — invariant AA-1. */
  async isActiveMember(scope: ScopeContext, userId: string, unitId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .select({ id: unitMemberships.id })
        .from(unitMemberships)
        .where(
          and(
            eq(unitMemberships.userId, userId),
            eq(unitMemberships.unitId, unitId),
            eq(unitMemberships.status, 'ACTIVE'),
          ),
        )
        .limit(1);
      return row !== undefined;
    });
  }
}

export type AssignmentRow = NonNullable<Awaited<ReturnType<AssignmentsRepository['findById']>>>;
