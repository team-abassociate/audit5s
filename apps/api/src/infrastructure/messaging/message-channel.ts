import { Global, Injectable, Module } from '@nestjs/common';

/**
 * The WhatsApp / SMS port (STACK.md §2: "`NotificationChannel` interface; not wired at MVP").
 *
 * No provider is wired, so the default reports itself unconfigured and every delivery on
 * it is recorded as SKIPPED — visibly, in `notification_delivery`, rather than disguised
 * as a send. A BSP or SMS gateway is one class bound below; nothing that notifies changes.
 */
export interface OutboundMessage {
  toE164: string;
  eventType: string;
  title: string;
  body: string;
}

export abstract class MessageChannel {
  abstract readonly configured: boolean;
  /** Resolves with the provider's id, or throws; the caller records either outcome. */
  abstract send(message: OutboundMessage): Promise<{ providerMessageId: string | null }>;
}

export const WHATSAPP_CHANNEL = Symbol('WHATSAPP_CHANNEL');
export const SMS_CHANNEL = Symbol('SMS_CHANNEL');

@Injectable()
export class UnwiredMessageChannel extends MessageChannel {
  readonly configured = false;

  send(): Promise<{ providerMessageId: string | null }> {
    return Promise.reject(new Error('No provider is configured for this channel'));
  }
}

@Global()
@Module({
  providers: [
    { provide: WHATSAPP_CHANNEL, useClass: UnwiredMessageChannel },
    { provide: SMS_CHANNEL, useClass: UnwiredMessageChannel },
  ],
  exports: [WHATSAPP_CHANNEL, SMS_CHANNEL],
})
export class MessagingModule {}
