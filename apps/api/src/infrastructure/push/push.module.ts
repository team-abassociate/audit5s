import { Global, Module } from '@nestjs/common';
import { ConsolePushChannel } from './console-push-channel';
import { PushChannel } from './push-channel';

/**
 * The push adapter, chosen in one place.
 *
 * There is one implementation today (Q1). When the Firebase credentials arrive, an
 * `FcmPushChannel` is added here and nothing that sends a message changes.
 */
@Global()
@Module({
  providers: [{ provide: PushChannel, useClass: ConsolePushChannel }],
  exports: [PushChannel],
})
export class PushModule {}
