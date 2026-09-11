import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  listDevicesQuerySchema,
  registerDeviceRequestSchema,
  type Device,
  type ListDevicesQuery,
  type Page,
  type RegisterDeviceRequest,
} from '@audit5s/contracts';
import type { ScopeContext } from '@audit5s/domain';
import { RequirePermission, Scope } from '../../common/auth/decorators';
import { CurrentScope } from '../../common/auth/current-scope.decorator';
import { ZodValidationPipe } from '../auth/zod.pipe';
import { DevicesService } from './devices.service';

/** `/devices` (§8.11). `:deviceId` is the name for this parameter position. */
@Controller('devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  /**
   * §8.11's `POST /devices/register`, idempotent on `id`.
   *
   * Phase 1 upserted a device as a side effect of login, which is how the row has existed
   * all along; this is the explicit route §8.11 names, and it is what lets a device
   * refresh its push token or its app version without signing in again.
   */
  @RequirePermission('device', 'list')
  @Scope({ intent: 'write' })
  @Post('register')
  @HttpCode(HttpStatus.OK)
  register(
    @CurrentScope() scope: ScopeContext,
    @Body(new ZodValidationPipe(registerDeviceRequestSchema)) body: RegisterDeviceRequest,
  ): Promise<Device> {
    return this.devices.register(scope, body);
  }

  @RequirePermission('device', 'list')
  @Scope({ intent: 'read' })
  @Get()
  list(
    @CurrentScope() scope: ScopeContext,
    @Query(new ZodValidationPipe(listDevicesQuerySchema)) query: ListDevicesQuery,
  ): Promise<Page<Device>> {
    return this.devices.list(scope, query);
  }

  @RequirePermission('device', 'list')
  @Scope({ param: 'deviceId', intent: 'read' })
  @Get(':deviceId')
  get(
    @CurrentScope() scope: ScopeContext,
    @Param('deviceId', ParseUUIDPipe) deviceId: string,
  ): Promise<Device> {
    return this.devices.get(scope, deviceId);
  }

  /** Revokes the device and its sessions. The audits it owns are released separately. */
  @RequirePermission('device', 'revoke')
  @Scope({ param: 'deviceId', intent: 'write' })
  @Post(':deviceId/revoke')
  @HttpCode(HttpStatus.OK)
  revoke(
    @CurrentScope() scope: ScopeContext,
    @Param('deviceId', ParseUUIDPipe) deviceId: string,
  ): Promise<Device> {
    return this.devices.revoke(scope, deviceId);
  }
}
