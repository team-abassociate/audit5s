import { Global, Module } from '@nestjs/common';
import { DomainEvents } from './domain-events';
import { QueueService } from './queue.service';

@Global()
@Module({ providers: [QueueService, DomainEvents], exports: [QueueService, DomainEvents] })
export class QueueModule {}
