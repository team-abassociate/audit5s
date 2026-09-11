import { Inject, Injectable, Logger } from '@nestjs/common';
import type { NotificationStatus } from '@audit5s/contracts';
import {
  SMS_CHANNEL,
  WHATSAPP_CHANNEL,
  type MessageChannel,
} from '../../infrastructure/messaging/message-channel';
import { PushChannel } from '../../infrastructure/push/push-channel';
import type { DomainEventJob } from '../../infrastructure/queue/domain-events';
import { QUEUES, QueueService } from '../../infrastructure/queue/queue.service';
import { RECIPIENT_ROLES, firstExternalChannel, renderNotification } from './notification-policy';
import {
  NotificationsRepository,
  type DeliveryRow,
  type NotificationTarget,
} from './notifications.repository';

/** An SMS is retried this many times; WhatsApp is not retried — SMS *is* its retry. */
const MAX_SMS_ATTEMPTS = 3;

/**
 * The notifications consumer (§4.2), run by `worker-general` only.
 *
 * For each recipient: the notification and its deliveries are written first, as that
 * recipient; *then* the providers are called, outside any transaction (STACK.md §5: "no
 * external HTTP call inside a database transaction"). Every attempt is recorded, including
 * the ones that could not be made, so "was she told?" is a query rather than a guess.
 *
 * Idempotent on the event: pg-boss may redeliver, and a redelivery finds the rows the first
 * one wrote and only retries what failed.
 */
@Injectable()
export class NotificationWorker {
  private readonly logger = new Logger('notification.send');

  constructor(
    private readonly repository: NotificationsRepository,
    private readonly push: PushChannel,
    @Inject(WHATSAPP_CHANNEL) private readonly whatsapp: MessageChannel,
    @Inject(SMS_CHANNEL) private readonly sms: MessageChannel,
  ) {}

  async register(queue: QueueService): Promise<void> {
    await queue.work<DomainEventJob>(QUEUES.notificationSend, async (jobs) => {
      for (const job of jobs) {
        await this.handle(job.data);
      }
    });
  }

  async handle(event: DomainEventJob): Promise<void> {
    const targets = await this.repository.targets(
      event.type,
      event.unitId,
      RECIPIENT_ROLES[event.type],
      event.userIds ?? [],
    );
    const message = renderNotification(event);

    let failed = 0;
    for (const target of targets) {
      // Nobody is told about their own act.
      if (target.userId === event.actorUserId) continue;
      const record = await this.repository.recordForRecipient(
        target,
        event,
        message,
        firstExternalChannel(event.type, target),
      );
      failed += await this.deliver(target, record, event, message);
    }

    if (failed > 0) {
      // pg-boss retries the job; the next run re-attempts only the failed SMS.
      throw new Error(`${event.type} ${event.eventId}: ${failed} delivery attempt(s) failed`);
    }
  }

  private async deliver(
    target: NotificationTarget,
    record: { notificationId: string; phoneE164: string | null; deliveries: DeliveryRow[] },
    event: DomainEventJob,
    message: { title: string; body: string },
  ): Promise<number> {
    let failed = 0;
    const byChannel = new Map(record.deliveries.map((delivery) => [delivery.channel, delivery]));

    const inApp = byChannel.get('IN_APP');
    if (inApp?.status === 'PENDING') {
      // The row in the centre *is* the in-app delivery; the push is a courtesy on top, and
      // a push that fails is logged rather than allowed to undeliver it (Q1).
      await this.push
        .send({ userId: target.userId, eventType: event.type, ...message })
        .catch((error: unknown) => this.logger.warn({ err: error }, 'push failed'));
      await this.repository.recordAttempt(target, inApp.id, { status: 'DELIVERED', countsAsAttempt: true });
    }

    const whatsapp = byChannel.get('WHATSAPP');
    if (whatsapp) {
      const outcome =
        whatsapp.status === 'PENDING'
          ? await this.attempt(target, whatsapp, this.whatsapp, record.phoneE164, event, message)
          : whatsapp.status;
      // §5.9: SMS "only as a fallback after a WhatsApp failure" — recorded as its own row.
      if (outcome !== 'SENT' && outcome !== 'DELIVERED' && target.smsEnabled) {
        const fallback = await this.repository.ensureFallback(target, record.notificationId, whatsapp.id);
        byChannel.set('SMS', fallback);
      }
    }

    const sms = byChannel.get('SMS');
    if (sms && (sms.status === 'PENDING' || (sms.status === 'FAILED' && sms.attemptCount < MAX_SMS_ATTEMPTS))) {
      const outcome = await this.attempt(target, sms, this.sms, record.phoneE164, event, message);
      if (outcome === 'FAILED') failed += 1;
    }

    return failed;
  }

  private async attempt(
    target: NotificationTarget,
    delivery: DeliveryRow,
    channel: MessageChannel,
    phoneE164: string | null,
    event: DomainEventJob,
    message: { title: string; body: string },
  ): Promise<NotificationStatus> {
    if (!channel.configured || !phoneE164) {
      await this.repository.recordAttempt(target, delivery.id, {
        status: 'SKIPPED',
        lastError: channel.configured ? 'No phone number on the account' : 'No provider configured',
        countsAsAttempt: false,
      });
      return 'SKIPPED';
    }

    try {
      const sent = await channel.send({ toE164: phoneE164, eventType: event.type, ...message });
      await this.repository.recordAttempt(target, delivery.id, {
        status: 'SENT',
        providerMessageId: sent.providerMessageId,
        countsAsAttempt: true,
      });
      return 'SENT';
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Unknown provider error';
      await this.repository.recordAttempt(target, delivery.id, {
        status: 'FAILED',
        lastError: reason,
        countsAsAttempt: true,
      });
      this.logger.warn(`${delivery.channel} to ${target.userId} failed: ${reason}`);
      return 'FAILED';
    }
  }
}
