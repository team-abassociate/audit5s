import { Controller, Get } from '@nestjs/common';
import { PERMISSION_MATRIX } from '@audit5s/domain';
import type { ScopeContext } from '@audit5s/domain';
import type { Role } from '@audit5s/contracts';
import { RequirePermission, Scope } from '../../common/auth/decorators';
import { CurrentScope } from '../../common/auth/current-scope.decorator';
import { PermissionsRepository } from './permissions.repository';

export interface RolePermissionView {
  key: string;
  resource: string;
  action: string;
  description: string;
  grants: Array<{ role: Role; scopeRule: string; condition: string | null }>;
}

/**
 * Exposes the matrix the runtime actually enforces, rather than what the document says it
 * should. The authorization suite asserts the two are equal; this is where a human can
 * check the same thing without reading the seed.
 */
@Controller('role-permissions')
export class PermissionsController {
  constructor(private readonly repository: PermissionsRepository) {}

  @RequirePermission('role_permission', 'read')
  @Scope({ intent: 'read' })
  @Get()
  async list(
    @CurrentScope() scope: ScopeContext,
  ): Promise<{ data: RolePermissionView[]; matrixSize: number; seededSize: number }> {
    const rows = await this.repository.listWithGrants(scope.actor.userId, scope.actor.role);

    const byKey = new Map<string, RolePermissionView>();
    for (const row of rows) {
      const key = `${row.resource}:${row.action}`;
      const view = byKey.get(key) ?? {
        key,
        resource: row.resource,
        action: row.action,
        description: row.description,
        grants: [],
      };
      if (row.role) {
        view.grants.push({
          role: row.role as Role,
          scopeRule: row.scopeRule ?? '',
          condition: row.condition ?? null,
        });
      }
      byKey.set(key, view);
    }

    return {
      data: [...byKey.values()],
      matrixSize: PERMISSION_MATRIX.length,
      seededSize: byKey.size,
    };
  }
}
