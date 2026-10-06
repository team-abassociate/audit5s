import { Injectable, Logger } from '@nestjs/common';
import type { OverdueBundleData } from '@audit5s/contracts';
import type { Transaction } from '@audit5s/db';
import type { ScopeContext } from '@audit5s/domain';
import { DomainEvents } from '../../infrastructure/queue/domain-events';
import { CorrectiveActionsRepository, type CorrectiveActionRow } from './corrective-actions.repository';

const DAY = 86_400_000;

/**
 * Announces corrective actions that have passed their due date (§7.3).
 *
 * A due date nobody is told about is a suggestion. The dashboard showed slippage to
 * whoever opened the page, which is not the Zone Leader who owns the work — they are a
 * phone user, and often the last to hear that something of theirs is late.
 *
 * It rides the nightly per-Unit maintenance tick rather than carrying a schedule of its
 * own: the tick already exists, and a second schedule would be a second thing to keep in
 * step with it for no gain.
 *
 * Bundled per Zone and leader (D10), and announced once, not nightly. `overdue_notified_at`
 * (0016) is the marker, and a reopen clears it so a reopened action can fall overdue again.
 * A reminder that repeats every night is a reminder people filter.
 */
@Injectable()
export class OverdueActionsWorker {
  private readonly logger = new Logger(OverdueActionsWorker.name);

  constructor(
    private readonly repository: CorrectiveActionsRepository,
    private readonly events: DomainEvents,
  ) {}

  async sweep(scope: ScopeContext, unitId: string, now = new Date()): Promise<number> {
    return this.repository.claimOverdue(scope, unitId, now, (tx, overdue) =>
      this.announce(tx, unitId, now, overdue),
    );
  }

  /** On the claim's transaction: the notices commit with the marker, or neither does. */
  private async announce(
    tx: Transaction,
    unitId: string,
    now: Date,
    overdue: CorrectiveActionRow[],
  ): Promise<void> {
    /*
     * D10: one notification per Zone and leader, not one per item — sixty-one "Overdue: …"
     * rows drowned the alerts that matter. Per leader as well as per Zone because a Zone
     * Leader may read only the actions assigned to them (`assigned_actions`), so a bundle
     * never shows anyone an item that is not theirs. The Coordinator and the Super Admin
     * get every bundle of the Units they hold, as they got every item before.
     */
    const bundles = new Map<string, CorrectiveActionRow[]>();
    for (const action of overdue) {
      const key = [action.zoneId, action.assignedZoneLeaderUserId, action.assignedZoneLeaderName].join('|');
      bundles.set(key, [...(bundles.get(key) ?? []), action]);
    }

    for (const actions of bundles.values()) {
      const first = actions[0]!;
      const data: OverdueBundleData = {
        zoneId: first.zoneId,
        zoneCode: first.zoneCode,
        zoneName: first.zoneName,
        assigneeName: first.assignedZoneLeaderName,
        items: actions.map((action) => ({
          actionId: action.id,
          questionNo: action.questionGlobalOrder,
          suggestionNo: action.suggestionNo,
          daysOverdue: action.dueAt
            ? Math.max(0, Math.floor((now.getTime() - new Date(action.dueAt).getTime()) / DAY))
            : 0,
        })),
      };

      /*
       * The actor is the system rather than a person. An event skips its actor as "their
       * own act", and a due date passing is nobody's act — least of all the Zone Leader's,
       * who is precisely the person who has to hear about it.
       */
      await this.events.emit(tx, {
        type: 'CORRECTIVE_ACTION_OVERDUE',
        actorUserId: null,
        unitId,
        // One item still opens that item; a bundle opens the overdue list.
        resourceType: actions.length === 1 ? 'corrective_action' : 'zone',
        resourceId: actions.length === 1 ? first.id : first.zoneId,
        userIds: first.assignedZoneLeaderUserId ? [first.assignedZoneLeaderUserId] : [],
        data,
      });
    }

    this.logger.log(
      `overdue sweep: announced ${overdue.length} action(s) in ${bundles.size} bundle(s) in unit ${unitId}`,
    );
  }
}
