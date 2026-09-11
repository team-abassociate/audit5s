import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import {
  listNotificationsQuerySchema,
  updateNotificationPreferencesRequestSchema,
  type ListNotificationsQuery,
  type Notification,
  type NotificationPage,
  type NotificationPreferences,
  type UpdateNotificationPreferencesRequest,
} from '@audit5s/contracts';
import type { ScopeContext } from '@audit5s/domain';
import { RequirePermission, Scope } from '../../common/auth/decorators';
import { CurrentScope } from '../../common/auth/current-scope.decorator';
import { ZodValidationPipe } from '../auth/zod.pipe';
import { NotificationsService } from './notifications.service';

/** The notification centre (§8.10). Every route is the caller's own (`own_record`). */
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @RequirePermission('notification', 'read')
  @Scope({ intent: 'read' })
  @Get()
  list(
    @CurrentScope() scope: ScopeContext,
    @Query(new ZodValidationPipe(listNotificationsQuerySchema)) query: ListNotificationsQuery,
  ): Promise<NotificationPage> {
    return this.notifications.list(scope, query);
  }

  @RequirePermission('notification', 'mark_read')
  @Scope({ intent: 'write' })
  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  markAllRead(@CurrentScope() scope: ScopeContext): Promise<{ updated: number }> {
    return this.notifications.markAllRead(scope);
  }

  @RequirePermission('notification', 'mark_read')
  @Scope({ param: 'notificationId', intent: 'read' })
  @Post(':notificationId/read')
  @HttpCode(HttpStatus.OK)
  markRead(
    @CurrentScope() scope: ScopeContext,
    @Param('notificationId', ParseUUIDPipe) notificationId: string,
  ): Promise<Notification> {
    return this.notifications.markRead(scope, notificationId);
  }
}

/**
 * `GET/PUT /notification-preferences` (§8.10). PART 6 lists one cell for this resource,
 * `update`, granted `own_record` to every role; reading one's own grid is the same grant.
 */
@Controller('notification-preferences')
export class NotificationPreferencesController {
  constructor(private readonly notifications: NotificationsService) {}

  @RequirePermission('notification_preference', 'update')
  @Scope({ intent: 'read' })
  @Get()
  get(@CurrentScope() scope: ScopeContext): Promise<NotificationPreferences> {
    return this.notifications.preferences(scope);
  }

  @RequirePermission('notification_preference', 'update')
  @Scope({ intent: 'write' })
  @Put()
  update(
    @CurrentScope() scope: ScopeContext,
    @Body(new ZodValidationPipe(updateNotificationPreferencesRequestSchema))
    body: UpdateNotificationPreferencesRequest,
  ): Promise<NotificationPreferences> {
    return this.notifications.updatePreferences(scope, body);
  }
}
