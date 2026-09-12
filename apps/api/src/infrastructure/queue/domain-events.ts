import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import type { NotificationEventType } from '@audit5s/contracts';
import type { Transaction } from '@audit5s/db';
import { QUEUES, QueueService } from './queue.service';

/**
 * A domain event of ARCHITECTURE.md §4.2, as it travels to its consumer.
 *
 * It carries identity and facts, never authority or text: the notifications worker decides
 * who is told and how, so a source never needs to know that notifications exist — which is
 * §4.1's "Notifications must not be called synchronously from any domain service".
 */
export interface DomainEvent {
  type: NotificationEventType;
  /** Who caused it. Never notified of their own act; null for the system. */
  actorUserId: string | null;
  unitId: string | null;
  resourceType: string;
  resourceId: string | null;
  /** People the source already knows are concerned: an assignee, a submitter. */
  userIds?: string[];
  data: Record<string, string | number | boolean | null>;
}

export interface DomainEventJob extends DomainEvent {
  /** With a recipient, the notification's dedupe key — pg-boss may deliver twice. */
  eventId: string;
  occurredAt: string;
}

/**
 * The one way a domain write raises an event: **inside its own transaction** (R-2).
 *
 * pg-boss stores the job in the same database, so an event exists exactly when the change
 * that caused it committed. There is no `emit` without a transaction to take.
 */
@Injectable()
export class DomainEvents {
  constructor(private readonly queue: QueueService) {}

  async emit(tx: Transaction, event: DomainEvent): Promise<void> {
    await this.queue.sendInTransaction(tx, QUEUES.notificationSend, toJob(event), RETRIES);
  }

  /**
   * For the one event with no transaction to join: `SYNC_FAILURE`, which reports quarantine
   * rows a hundred independent item writes have already committed (§9.3). The R-2 hazard —
   * a job for a write that rolled back — cannot arise, because nothing is left to roll back.
   */
  async emitCommitted(event: DomainEvent): Promise<void> {
    await this.queue.send(QUEUES.notificationSend, toJob(event), RETRIES);
  }
}

// Retries cover a failed SMS fallback; the handler is idempotent on `eventId`.
const RETRIES = { retryLimit: 3, retryDelay: 30, retryBackoff: true };

function toJob(event: DomainEvent): DomainEventJob {
  return { ...event, eventId: uuidv7(), occurredAt: new Date().toISOString() };
}
