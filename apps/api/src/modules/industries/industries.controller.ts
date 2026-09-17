import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  createIndustryRequestSchema,
  listIndustriesQuerySchema,
  updateIndustryRequestSchema,
  type CreateIndustryRequest,
  type Industry,
  type ListIndustriesQuery,
  type UpdateIndustryRequest,
} from '@audit5s/contracts';
import type { ScopeContext } from '@audit5s/domain';
import { RequirePermission, Scope } from '../../common/auth/decorators';
import { CurrentScope } from '../../common/auth/current-scope.decorator';
import { ZodValidationPipe } from '../auth/zod.pipe';
import { IndustriesService } from './industries.service';

/**
 * Industries (0018) — the sectors this product is sold into.
 *
 * Read is broad and write is a Super Admin's, exactly as the checklist catalogue is: a
 * sector list carries no Unit-identifying data, and every client caches it offline beside
 * the templates it labels.
 */
@Controller('industries')
export class IndustriesController {
  constructor(private readonly industries: IndustriesService) {}

  @RequirePermission('industry', 'read')
  @Scope({ intent: 'read' })
  @Get()
  list(
    @CurrentScope() scope: ScopeContext,
    @Query(new ZodValidationPipe(listIndustriesQuerySchema)) query: ListIndustriesQuery,
  ): Promise<Industry[]> {
    return this.industries.list(scope, query.includeArchived);
  }

  @RequirePermission('industry', 'create')
  @Scope({ intent: 'write' })
  @Post()
  create(
    @CurrentScope() scope: ScopeContext,
    @Body(new ZodValidationPipe(createIndustryRequestSchema)) body: CreateIndustryRequest,
  ): Promise<Industry> {
    return this.industries.create(scope, body);
  }

  @RequirePermission('industry', 'update')
  @Scope({ intent: 'write' })
  @Patch(':id')
  update(
    @CurrentScope() scope: ScopeContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateIndustryRequestSchema)) body: UpdateIndustryRequest,
  ): Promise<Industry> {
    return this.industries.update(scope, id, body);
  }

  /**
   * `DELETE` is the verb a client expects here, and archiving is what it does — nothing in
   * this schema is ever removed (D8). It answers with the archived row rather than 204, so
   * the caller can see the state it landed in.
   */
  @RequirePermission('industry', 'archive')
  @Scope({ intent: 'write' })
  @Delete(':id')
  archive(
    @CurrentScope() scope: ScopeContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Industry> {
    return this.industries.archive(scope, id);
  }
}
