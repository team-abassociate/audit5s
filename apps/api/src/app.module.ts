import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AuditLogModule } from './common/audit-log/audit-log.module';
import { AuthorizationModule } from './common/auth/authorization.module';
import { JwtAuthGuard } from './common/auth/jwt-auth.guard';
import { PermissionGuard } from './common/auth/permission.guard';
import { ScopeGuard } from './common/auth/scope.guard';
import { ProblemDetailsFilter } from './common/filters/problem.filter';
import { IdempotencyInterceptor } from './common/idempotency/idempotency.interceptor';
import { RequestContextMiddleware } from './common/observability/request-context.middleware';
import { DatabaseModule } from './infrastructure/database/database.module';
import { QueueModule } from './infrastructure/queue/queue.module';
import { AuditLogsModule } from './modules/audit-logs/audit-logs.module';
import { AuthModule } from './modules/auth/auth.module';
import { HealthModule } from './modules/health/health.module';
import { PermissionsModule } from './modules/roles-permissions/permissions.module';
import { MembershipsModule } from './modules/unit-memberships/memberships.module';
import { UnitsModule } from './modules/units/units.module';
import { UsersModule } from './modules/users/users.module';
import { ZonesModule } from './modules/zones/zones.module';

/**
 * The guard chain is **global and composed**, in this order (ARCHITECTURE.md §6.1):
 *
 *   JwtAuthGuard → PermissionGuard → ScopeGuard
 *
 * Global is the point. An endpoint that forgets to declare a guard is not unguarded — it
 * is refused, because `PermissionGuard` rejects any route carrying neither
 * `@RequirePermission` nor `@Public`. An unguarded endpoint is a bug, not a shortcut
 * (STACK.md §1), and this is where that is made structurally true.
 */
@Module({
  imports: [
    DatabaseModule,
    QueueModule,
    AuthorizationModule,
    AuditLogModule,
    AuthModule,
    UsersModule,
    UnitsModule,
    ZonesModule,
    MembershipsModule,
    PermissionsModule,
    AuditLogsModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    { provide: APP_GUARD, useClass: ScopeGuard },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*path');
  }
}
