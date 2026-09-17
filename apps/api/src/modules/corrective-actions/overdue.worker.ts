import { Injectable, Logger } from '@nestjs/common';
import type { ScopeContext } from '@audit5s/domain';
import { DomainEvents } from '../../infrastructure/queue/domain-events';
import { CorrectiveActionsRepository } from './corrective-actions.repository';

const DAY = 86_400_000;

/**
 * Announces corrective actions that have passed their due date (§7.3).
 *
 * A due date nobody is told about is a suggestion. The dashboard showed slippage to
 * whoever opened the page, which is not the Zone Leader who owns the work — they are a
 * phone user, and often the last to hear that something of theirs is late.
 *
 * It rides the nightly per-Unit maintenance tick rather than carrying a schedule of its
 * own, exactly as the §16.4 integrity checks do: the tick already exists, and a second
 * schedule would be a second thing to keep in step with it for no gain.
 *
 * Announced once, not nightly. `overdue_notified_at` (0016) is the marker, and a reopen
 * clears it so a reopened action can fall overdue again. A reminder that repeats every
 * night is a reminder people filter.
 */
@Injectable()
export class OverdueActionsWorker {
  private readonly logger = new Logger(OverdueActionsWorker.name);

  constructor(
    private readonly repository: CorrectiveActionsRepository,
    private readonly events: DomainEvents,
  ) {}

  async sweep(scope: ScopeContext, unitId: string, now = new Date()): Promise<number> {
    const overdue = await this.repository.claimOverdue(scope, unitId, now);
    if (overdue.length === 0) return 0;

    for (const action of overdue) {
      const daysOverdue = action.dueAt
        ? Math.floor((now.getTime() - new Date(action.dueAt).getTime()) / DAY)
        : 0;

      /*
       * No transaction to join: the claim is already committed, so R-2's hazard — a job
       * for a write that rolled back — cannot arise here. This is `SYNC_FAILURE`'s case,
       * and `DATA_INTEGRITY_ALERT`'s.
       *
       * The actor is the system rather than a person. `emitCommitted` skips the actor as
       * "their own act", and a due date passing is nobody's act — least of all the Zone
       * Leader's, who is precisely the person who has to hear about it.
       */
      await this.events.emitCommitted({
        type: 'CORRECTIVE_ACTION_OVERDUE',
        actorUserId: null,
        unitId,
        resourceType: 'corrective_action',
        resourceId: action.id,
        userIds: action.assignedZoneLeaderUserId ? [action.assignedZoneLeaderUserId] : [],
        data: {
          zoneCode: action.zoneCode,
          zoneName: action.zoneName,
          questionNo: action.questionGlobalOrder,
          assigneeName: action.assignedZoneLeaderName,
          dueAt: action.dueAt ? new Date(action.dueAt).toISOString() : null,
          daysOverdue,
        },
      });
    }

    this.logger.log(`overdue sweep: announced ${overdue.length} action(s) in unit ${unitId}`);
    return overdue.length;
  }
}
