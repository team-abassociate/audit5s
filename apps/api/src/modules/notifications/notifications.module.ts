import { Module } from '@nestjs/common';
import { NotificationPreferencesController, NotificationsController } from './notifications.controller';
import { NotificationsRepository } from './notifications.repository';
import { NotificationsService } from './notifications.service';
import { NotificationWorker } from './notification.worker';

/**
 * Notifications (§4.2, §5.9, §8.10).
 *
 * Imported by nothing: §4.1 forbids calling it from a domain service, so events reach it
 * only as pg-boss jobs. `NotificationWorker` is registered by `worker-general` alone.
 */
@Module({
  controllers: [NotificationsController, NotificationPreferencesController],
  providers: [NotificationsService, NotificationsRepository, NotificationWorker],
  exports: [NotificationWorker],
})
export class NotificationsModule {}
