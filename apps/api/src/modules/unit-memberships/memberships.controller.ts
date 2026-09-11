import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  createMembershipRequestSchema,
  listMembershipsQuerySchema,
  type CreateMembershipRequest,
  type MembershipDetail,
  type Page,
} from '@audit5s/contracts';
import type { ScopeContext } from '@audit5s/domain';
import { RequirePermission, Scope } from '../../common/auth/decorators';
import { CurrentScope } from '../../common/auth/current-scope.decorator';
import { ZodValidationPipe } from '../auth/zod.pipe';
import { MembershipsService } from './memberships.service';

@Controller()
export class MembershipsController {
  constructor(private readonly memberships: MembershipsService) {}

  @RequirePermission('unit_membership', 'create')
  @Scope({ intent: 'write' })
  @Post('units/:id/memberships')
  assign(
    @CurrentScope() scope: ScopeContext,
    @Param('id', ParseUUIDPipe) unitId: string,
    @Body(new ZodValidationPipe(createMembershipRequestSchema)) body: CreateMembershipRequest,
  ): Promise<MembershipDetail> {
    return this.memberships.assign(scope, unitId, body);
  }

  @RequirePermission('unit_membership', 'revoke')
  @Scope({ param: 'membershipId', intent: 'write' })
  @Delete('units/:id/memberships/:membershipId')
  @HttpCode(HttpStatus.NO_CONTENT)
  revoke(
    @CurrentScope() scope: ScopeContext,
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
  ): Promise<void> {
    return this.memberships.revoke(scope, membershipId);
  }

  @RequirePermission('unit_membership', 'read')
  @Scope({ intent: 'read' })
  @Get('memberships')
  list(
    @CurrentScope() scope: ScopeContext,
    @Query(new ZodValidationPipe(listMembershipsQuerySchema))
    query: ReturnType<typeof listMembershipsQuerySchema.parse>,
  ): Promise<Page<MembershipDetail>> {
    return this.memberships.list(scope, query);
  }
}
