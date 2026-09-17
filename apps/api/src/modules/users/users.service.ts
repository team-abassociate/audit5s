import { Inject, Injectable } from '@nestjs/common';
import type {
  CreateUserRequest,
  CreateUserResponse,
  ListUsersQuery,
  Page,
  Role,
  UpdateUserRequest,
  User,
} from '@audit5s/contracts';
import { ADMIN_EDITABLE_USER_FIELDS, SELF_EDITABLE_USER_FIELDS } from '@audit5s/contracts';
import type { ScopeContext } from '@audit5s/domain';
import { CONFIG, type AppConfig } from '../../config/env';
import { AppError } from '../../common/errors';
import { isUniqueViolation } from '../../common/pg-errors';
import { AuditLogService } from '../../common/audit-log/audit-log.service';
import { PasswordService } from '../auth/password.service';
import { AuthRepository } from '../auth/auth.repository';
import { UsersRepository } from './users.repository';

@Injectable()
export class UsersService {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly repository: UsersRepository,
    private readonly passwords: PasswordService,
    private readonly auth: AuthRepository,
    private readonly auditLog: AuditLogService,
  ) {}

  /**
   * Creates a user and issues its bootstrap credential.
   *
   * CH-1 in full: the credential **is** the phone number, hashed with Argon2id like any
   * other password, flagged `must_reset_password` and expiring in 72 hours. It is never
   * returned by this endpoint, never logged, and never sent in plaintext — the response
   * carries the login ID and the expiry, and nothing else.
   */
  async create(scope: ScopeContext, request: CreateUserRequest): Promise<CreateUserResponse> {
    const actor = scope.actor;

    // A Coordinator may create Zone Leaders and only in their own Unit. The Unit comes
    // from their membership, never from the request body (AZ-2).
    let unitId = request.unitId ?? null;
    if (actor.role === 'COORDINATOR') {
      if (request.role !== 'ZONE_LEADER') {
        throw AppError.forbidden('FORBIDDEN', 'A Coordinator may only create Zone Leaders');
      }
      if (!actor.activeUnitId) {
        throw AppError.forbidden('FORBIDDEN', 'You have no active Unit');
      }
      unitId = actor.activeUnitId;
    }

    if (request.role !== 'SUPER_ADMIN' && !unitId) {
      // A scoped role with no Unit has no scope at all and could see nothing.
      throw AppError.validation('unitId is required for this role', [
        { field: 'unitId', message: 'Required for every role except SUPER_ADMIN' },
      ]);
    }

    if (request.role === 'SUPER_ADMIN' && actor.role !== 'SUPER_ADMIN') {
      throw AppError.forbidden('FORBIDDEN', 'Only a Super Admin may create a Super Admin');
    }

    const bootstrapExpiresAt = new Date(
      Date.now() + this.config.BOOTSTRAP_PASSWORD_TTL_HOURS * 60 * 60 * 1000,
    );

    const passwordHash = await this.passwords.hash(request.phone);
    const created = await this.repository
      .createWithLoginId({
        fullName: request.fullName,
        phoneE164: request.phone,
        email: request.email ?? null,
        role: request.role,
        passwordHash,
        bootstrapExpiresAt,
        createdByUserId: actor.userId,
        createdByRole: actor.role,
        unitId: request.role === 'SUPER_ADMIN' ? null : unitId,
        assignedByUserId: actor.userId,
      })
      .catch((error: unknown) => {
        // The phone number is the bootstrap credential, so two active accounts cannot share
        // one. This used to surface as a 500, which the app read as "cannot reach the server".
        if (isUniqueViolation(error, 'user_phone_active_key')) {
          throw AppError.validation('This phone number already belongs to another active user', [
            {
              field: 'phone',
              message: 'Already used by another active account. Each person needs their own number.',
            },
          ]);
        }
        throw error;
      });

    await this.auditLog.record({
      action: 'user.created',
      resourceType: 'user',
      resourceId: created.userId,
      unitId,
      after: {
        loginId: created.loginId,
        fullName: request.fullName,
        role: request.role,
        unitId,
      },
    });

    if (unitId && request.role !== 'SUPER_ADMIN') {
      await this.auditLog.recordSafely({
        action: request.role === 'CONSULTANT' ? 'consultant.assigned' : 'coordinator.assigned',
        resourceType: 'unit_membership',
        resourceId: created.userId,
        unitId,
        after: { userId: created.userId, unitId, role: request.role },
      });
    }

    const user = await this.repository.findById(scope, created.userId);
    if (!user) {
      throw AppError.internal('User was created but could not be read back');
    }

    return {
      user: toUser(user),
      loginId: created.loginId,
      bootstrapExpiresAt: bootstrapExpiresAt.toISOString(),
    };
  }

  async list(scope: ScopeContext, query: ListUsersQuery): Promise<Page<User>> {
    const rows = await this.repository.list(scope, query);
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    return {
      data: page.map(toUser),
      nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async get(scope: ScopeContext, userId: string): Promise<User> {
    const user = await this.repository.findById(scope, userId);
    // AZ-3: out of scope reads as absent, so IDs cannot be probed for existence.
    if (!user) {
      throw AppError.notFound('No such user');
    }
    return toUser(user);
  }

  async update(scope: ScopeContext, userId: string, request: UpdateUserRequest): Promise<User> {
    const actor = scope.actor;
    const isSelf = actor.userId === userId;

    // Field-level allow-list per role (§8.4). A Consultant or Zone Leader editing their
    // own record may change profile fields only.
    const allowed: readonly string[] =
      actor.role === 'SUPER_ADMIN' || actor.role === 'COORDINATOR'
        ? ADMIN_EDITABLE_USER_FIELDS
        : SELF_EDITABLE_USER_FIELDS;

    if (!isSelf && (actor.role === 'CONSULTANT' || actor.role === 'ZONE_LEADER')) {
      throw AppError.forbidden('FORBIDDEN', 'You may only edit your own record');
    }

    const rejected = Object.keys(request).filter((field) => !allowed.includes(field));
    if (rejected.length > 0) {
      throw AppError.fieldNotEditable(rejected);
    }

    const before = await this.repository.findById(scope, userId);
    if (!before) {
      throw AppError.notFound('No such user');
    }

    if (actor.role === 'COORDINATOR' && before.role !== 'ZONE_LEADER' && !isSelf) {
      throw AppError.forbidden('FORBIDDEN', 'A Coordinator may only edit Zone Leaders');
    }

    const updated = await this.repository.update(scope, userId, {
      ...(request.fullName !== undefined ? { fullName: request.fullName } : {}),
      ...(request.email !== undefined ? { email: request.email } : {}),
      ...(request.phone !== undefined ? { phoneE164: request.phone } : {}),
    });

    if (!updated) {
      throw AppError.notFound('No such user');
    }

    await this.auditLog.recordSafely({
      action: 'user.updated',
      resourceType: 'user',
      resourceId: userId,
      before: { fullName: before.fullName, email: before.email, phoneE164: before.phoneE164 },
      after: { fullName: updated.fullName, email: updated.email, phoneE164: updated.phoneE164 },
    });

    return toUser(updated);
  }

  async disable(scope: ScopeContext, userId: string): Promise<void> {
    const actor = scope.actor;
    const before = await this.repository.findById(scope, userId);
    if (!before) {
      throw AppError.notFound('No such user');
    }

    if (actor.role === 'COORDINATOR' && before.role !== 'ZONE_LEADER') {
      throw AppError.forbidden('FORBIDDEN', 'A Coordinator may only disable Zone Leaders');
    }
    if (actor.userId === userId) {
      throw AppError.conflict('CONFLICT', 'You cannot disable your own account');
    }

    const disabled = await this.repository.disable(scope, userId);
    if (!disabled) {
      throw AppError.notFound('No such user');
    }

    await this.auth.revokeUserAccess(userId);

    await this.auditLog.record({
      action: 'user.disabled',
      resourceType: 'user',
      resourceId: userId,
      before: { status: before.status },
      after: { status: 'DISABLED' },
    });
  }

  /**
   * "Remove from the system", as far as D8 allows (R-25).
   *
   * Nothing here is ever hard-deleted: every audit, photograph and log row names the person
   * who made it, and the database refuses to orphan them. So removal is archival — the
   * account is disabled, its sessions and devices are revoked, and it leaves every list and
   * every picker, while the record of what it did stays exactly as it was.
   */
  async archive(scope: ScopeContext, userId: string): Promise<void> {
    const before = await this.repository.findById(scope, userId);
    if (!before) {
      throw AppError.notFound('No such user');
    }
    if (scope.actor.userId === userId) {
      throw AppError.conflict('CONFLICT', 'You cannot remove your own account');
    }

    const archived = await this.repository.archive(scope, userId);
    if (!archived) {
      throw AppError.notFound('No such user');
    }

    await this.auth.revokeUserAccess(userId);

    await this.auditLog.record({
      action: 'user.archived',
      resourceType: 'user',
      resourceId: userId,
      before: { status: before.status, archivedAt: null },
      after: { status: 'DISABLED', archivedAt: new Date().toISOString() },
    });
  }

  /** Issues a fresh bootstrap credential. Like creation, it returns no credential. */
  async resetPassword(scope: ScopeContext, userId: string) {
    const actor = scope.actor;
    const user = await this.repository.findById(scope, userId);
    if (!user) {
      throw AppError.notFound('No such user');
    }

    if (actor.role === 'COORDINATOR' && user.role !== 'ZONE_LEADER' && actor.userId !== userId) {
      throw AppError.forbidden('FORBIDDEN', 'A Coordinator may only reset Zone Leaders');
    }

    const bootstrapExpiresAt = new Date(
      Date.now() + this.config.BOOTSTRAP_PASSWORD_TTL_HOURS * 60 * 60 * 1000,
    );

    await this.repository.setBootstrapCredential(
      scope,
      userId,
      await this.passwords.hash(user.phoneE164),
      bootstrapExpiresAt,
    );

    await this.auditLog.record({
      action: 'user.password_reset',
      resourceType: 'user',
      resourceId: userId,
    });

    return { loginId: user.loginId, bootstrapExpiresAt: bootstrapExpiresAt.toISOString() };
  }
}

type UserRow = Awaited<ReturnType<UsersRepository['findById']>>;

export function toUser(row: NonNullable<UserRow>): User {
  return {
    id: row.id,
    loginId: row.loginId,
    fullName: row.fullName,
    phoneE164: row.phoneE164,
    email: row.email,
    role: row.role as Role,
    status: row.status,
    mustResetPassword: row.mustResetPassword,
    bootstrapExpiresAt: row.bootstrapExpiresAt?.toISOString() ?? null,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdByUserId: row.createdByUserId,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
