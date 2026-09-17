import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../../config/env';
import {
  EMAIL_CHANNEL,
  EmailChannel,
  HttpEmailChannel,
  UnwiredEmailChannel,
} from './email-channel';

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
    {
      /*
       * Email is the one channel that can be wired from configuration alone, because it
       * needs no template registration — a WhatsApp BSP wants approved templates and an
       * Indian SMS gateway wants DLT registration, which is why those two stay unwired
       * until someone has actually done that paperwork.
       *
       * All three settings together or none. Two out of three is a deployment that thinks
       * it can send mail and cannot, and it would find out when somebody needed a
       * password reset.
       */
      provide: EMAIL_CHANNEL,
      inject: [CONFIG],
      useFactory: (config: AppConfig): EmailChannel => {
        const logger = new Logger('EmailChannel');
        if (config.EMAIL_API_URL && config.EMAIL_API_KEY && config.EMAIL_FROM) {
          logger.log(`email enabled — sending as ${config.EMAIL_FROM}`);
          return new HttpEmailChannel(
            config.EMAIL_API_URL,
            config.EMAIL_API_KEY,
            config.EMAIL_FROM,
          );
        }
        logger.warn(
          'EMAIL_API_URL, EMAIL_API_KEY and EMAIL_FROM are not all set — password-reset ' +
            'emails cannot be sent. Reset links will be refused rather than silently dropped.',
        );
        return new UnwiredEmailChannel();
      },
    },
  ],
  exports: [WHATSAPP_CHANNEL, SMS_CHANNEL, EMAIL_CHANNEL],
})
export class MessagingModule {}
