import { Injectable, Logger } from '@nestjs/common';
import { PushChannel, type PushMessage } from './push-channel';

/**
 * Q1's stated default: "a `PushChannel` adapter with a console/log implementation".
 *
 * It logs at `warn` rather than `debug` on purpose. A notification that nobody receives is
 * an operational gap, and a gap that is only visible at debug level is a gap nobody finds.
 */
@Injectable()
export class ConsolePushChannel extends PushChannel {
  private readonly logger = new Logger('PushChannel');

  send(message: PushMessage): Promise<void> {
    this.logger.warn(
      `[not delivered — no FCM project configured (Q1)] ${message.eventType} → user ` +
        `${message.userId}: ${message.title} — ${message.body}`,
    );
    return Promise.resolve();
  }

  describe(): string {
    return 'console (Q1: no Firebase project configured)';
  }
}
