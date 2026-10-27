import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
// The type augmentation that puts `request.file()` on FastifyRequest.
import '@fastify/multipart';
import {
  createUserRequestSchema,
  listUsersQuerySchema,
  updateUserRequestSchema,
  type CreateUserRequest,
  type CreateUserResponse,
  type Page,
  type ResetUserPasswordResponse,
  type UpdateUserRequest,
  type User,
  type AuditorListImportResult,
} from '@audit5s/contracts';
import type { ScopeContext } from '@audit5s/domain';
import { RequirePermission, Scope } from '../../common/auth/decorators';
import { CurrentScope } from '../../common/auth/current-scope.decorator';
import { AppError } from '../../common/errors';
import { ZodValidationPipe } from '../auth/zod.pipe';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @RequirePermission('user', 'create')
  @Scope({ intent: 'write' })
  @Post()
  create(
    @CurrentScope() scope: ScopeContext,
    @Body(new ZodValidationPipe(createUserRequestSchema)) body: CreateUserRequest,
  ): Promise<CreateUserResponse> {
    return this.users.create(scope, body);
  }

  @RequirePermission('user', 'read')
  @Scope({ intent: 'read' })
  @Get()
  list(
    @CurrentScope() scope: ScopeContext,
    @Query(new ZodValidationPipe(listUsersQuerySchema)) query: ReturnType<typeof listUsersQuerySchema.parse>,
  ): Promise<Page<User>> {
    return this.users.list(scope, query);
  }

  @RequirePermission('user', 'read')
  @Scope({ param: 'id', intent: 'read' })
  @Get(':id')
  get(@CurrentScope() scope: ScopeContext, @Param('id', ParseUUIDPipe) id: string): Promise<User> {
    return this.users.get(scope, id);
  }

  @RequirePermission('user', 'update')
  @Scope({ param: 'id', intent: 'write' })
  @Patch(':id')
  update(
    @CurrentScope() scope: ScopeContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateUserRequestSchema)) body: UpdateUserRequest,
  ): Promise<User> {
    return this.users.update(scope, id, body);
  }

  @RequirePermission('user', 'disable')
  @Scope({ param: 'id', intent: 'write' })
  @Post(':id/disable')
  @HttpCode(HttpStatus.NO_CONTENT)
  disable(@CurrentScope() scope: ScopeContext, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.users.disable(scope, id);
  }

  /** Undoes `disable`, under the same permission: whoever may revoke access may restore it. */
  @RequirePermission('user', 'disable')
  @Scope({ param: 'id', intent: 'write' })
  @Post(':id/enable')
  @HttpCode(HttpStatus.NO_CONTENT)
  enable(@CurrentScope() scope: ScopeContext, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.users.enable(scope, id);
  }

  @RequirePermission('user', 'archive')
  @Scope({ param: 'id', intent: 'write' })
  @Post(':id/archive')
  @HttpCode(HttpStatus.NO_CONTENT)
  archive(@CurrentScope() scope: ScopeContext, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.users.archive(scope, id);
  }

  @RequirePermission('user', 'reset_password')
  @Scope({ param: 'id', intent: 'write' })
  @Post(':id/reset-password')
  @HttpCode(HttpStatus.OK)
  resetPassword(
    @CurrentScope() scope: ScopeContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ResetUserPasswordResponse> {
    return this.users.resetPassword(scope, id);
  }
}

/**
 * R-64: the Unit's Auditor list from an Excel file, as a multipart field `file` — the
 * accounts of its Zone Leaders and ad hoc auditors. Whoever may create a Zone Leader may
 * import it: a Super Admin, or a Coordinator for their own Unit.
 */
@Controller()
export class AuditorListImportController {
  constructor(private readonly users: UsersService) {}

  @RequirePermission('user', 'create')
  @Scope({ intent: 'write' })
  @Post('units/:id/auditors/import')
  @HttpCode(HttpStatus.OK)
  async importList(
    @CurrentScope() scope: ScopeContext,
    @Param('id', ParseUUIDPipe) unitId: string,
    @Req() request: FastifyRequest,
  ): Promise<AuditorListImportResult> {
    const file = await request.file();
    if (!file) {
      throw AppError.validation('Send the Auditor list as a multipart file field named `file`');
    }
    return this.users.importAuditorList(scope, unitId, await file.toBuffer());
  }
}
