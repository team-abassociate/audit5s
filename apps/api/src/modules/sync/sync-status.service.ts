import { Injectable } from '@nestjs/common';
import type { SyncStatus } from '@audit5s/contracts';
import type { ScopeContext } from '@audit5s/domain';
import { AppError } from '../../common/errors';
import { EvidenceRepository } from '../evidence/evidence.repository';
import { SyncRepository } from './sync.repository';

/**
 * `GET /sync/status` (§8.11).
 *
 * It exists so a field problem is diagnosable *from the device*. An auditor who has been
 * pushing into a quarantine for two days can see that, and so can whoever they phone —
 * without which the only symptom is "the report is missing a Zone" a week later.
 *
 * The three counts are chosen to answer the three questions a stuck device raises: is the
 * server still waiting for photographs I think I sent (`awaitingUploadCount`), is my work
 * sitting in a queue somebody has to review (`unresolvedConflictCount`), and am I still
 * holding a lock I thought I released (`ownedAudits`).
 */
@Injectable()
export class SyncStatusService {
  constructor(
    private readonly repository: SyncRepository,
    private readonly evidence: EvidenceRepository,
  ) {}

  async forCurrentDevice(scope: ScopeContext): Promise<SyncStatus> {
    const deviceId = scope.actor.deviceId;
    if (!deviceId) {
      // There is no device-agnostic answer to "what does the server think of my device".
      throw AppError.validation('This request must identify the device', [
        { field: 'deviceId', message: 'Send the X-Device-Id header' },
      ]);
    }

    const [status, awaitingUploadCount] = await Promise.all([
      this.repository.statusFor(scope, deviceId),
      this.evidence.countAwaitingUpload(scope, deviceId),
    ]);

    return {
      deviceId,
      serverTime: new Date().toISOString(),
      lastBatchAt: status.lastBatchAt?.toISOString() ?? null,
      lastBatchStatus: status.lastBatchStatus,
      ownedAudits: status.owned.map((audit) => ({
        auditId: audit.auditId,
        status: audit.status,
        unitId: audit.unitId,
        startedAt: audit.startedAt?.toISOString() ?? null,
      })),
      awaitingUploadCount,
      unresolvedConflictCount: status.unresolvedConflictCount,
      batchesLast24h: status.batchesLast24h,
    };
  }
}
