import { sql } from 'drizzle-orm';
import type { AuditDetail, Evidence } from '@audit5s/contracts';
import type { LocalDatabase } from './local-database';
import {
  audits,
  localAuditZoneAuditees,
  localAuditZonePreviousNcs,
  localAuditZones,
  localEvidence,
  localQuestionResponses,
  localZoneActionSuggestions,
} from './schema';

/**
 * R-92: an open audit follows its auditor's account to this device.
 *
 * The server moved the lock here (`POST /audits/{id}/take-over`); this writes what the server
 * holds into SQLite, so the questionnaire picks up exactly where the other device left it
 * and every later save goes through the outbox as usual.
 *
 * Every row is written as `SYNCED`: it came from the server, so there is nothing to push and
 * the media queue must not try to upload a photo whose file is on another phone. The server
 * wins for each row it has. A row this device holds that the server never heard of is left
 * alone, because its outbox item is still waiting to deliver it.
 *
 * Photos are the server's objects. `photoFiles` maps an evidence id to a copy downloaded to
 * this device, when there is one; a photo without one shows as a placeholder until opened.
 */
export async function adoptServerAudit(
  database: LocalDatabase,
  detail: AuditDetail,
  evidence: readonly Evidence[],
  photoFiles: ReadonlyMap<string, string> = new Map(),
): Promise<void> {
  const auditRow = {
    id: detail.id,
    assignmentId: detail.assignmentId,
    unitId: detail.unitId,
    auditType: detail.auditType,
    status: detail.status,
    checklistVersionId: detail.checklistVersionId,
    selfieEvidenceId: detail.selfieEvidenceId,
    startedAt: detail.startedAt,
    completedAt: detail.completedAt,
    pausedAt: detail.pausedAt,
    pauseReason: detail.pauseReason,
    restartCount: detail.restartCount,
    resumeAuditZoneId: detail.resumeAuditZoneId,
    startLatitude: detail.startLatitude,
    startLongitude: detail.startLongitude,
    startAccuracyM: detail.startAccuracyM,
    startLocationProvider: detail.startLocationProvider,
    startLocationIsMocked: detail.startLocationIsMocked === null ? null : detail.startLocationIsMocked ? 1 : 0,
    clientCreatedAt: detail.clientCreatedAt,
    clientUpdatedAt: detail.clientUpdatedAt,
    syncState: 'SYNCED',
  };
  await database.insert(audits).values(auditRow).onConflictDoUpdate({ target: audits.id, set: auditRow });

  for (const zone of detail.zones) {
    const zoneRow = {
      id: zone.id,
      auditId: zone.auditId,
      zoneId: zone.zoneId,
      sequenceNo: zone.sequenceNo,
      status: zone.status,
      zoneCodeSnapshot: zone.zoneCodeSnapshot,
      zoneNameSnapshot: zone.zoneNameSnapshot,
      zoneDescriptionSnapshot: zone.zoneDescriptionSnapshot,
      zoneLeaderUserIdSnapshot: zone.zoneLeaderUserIdSnapshot,
      zoneLeaderNameSnapshot: zone.zoneLeaderNameSnapshot,
      checklistVersionId: zone.checklistVersionId,
      checklistTemplateNameSnapshot: zone.checklistTemplateNameSnapshot,
      zoneRemark: zone.zoneRemark,
      resumeQuestionId: zone.resumeQuestionId,
      startedAt: zone.startedAt,
      completedAt: zone.completedAt,
      clientUpdatedAt: zone.clientUpdatedAt,
      syncState: 'SYNCED',
    };
    await database
      .insert(localAuditZones)
      .values(zoneRow)
      .onConflictDoUpdate({ target: localAuditZones.id, set: zoneRow });

    const auditee = { auditZoneId: zone.id, auditeeName: zone.auditeeName ?? null };
    await database
      .insert(localAuditZoneAuditees)
      .values(auditee)
      .onConflictDoUpdate({ target: localAuditZoneAuditees.auditZoneId, set: auditee });

    const previous = { auditZoneId: zone.id, answer: zone.previousNcsAnswer ?? null };
    await database
      .insert(localAuditZonePreviousNcs)
      .values(previous)
      .onConflictDoUpdate({ target: localAuditZonePreviousNcs.auditZoneId, set: previous });

    const suggestions = {
      auditZoneId: zone.id,
      suggestions: JSON.stringify(zone.overallActionSuggestions ?? []),
    };
    await database
      .insert(localZoneActionSuggestions)
      .values(suggestions)
      .onConflictDoUpdate({ target: localZoneActionSuggestions.auditZoneId, set: suggestions });

    for (const response of zone.responses) {
      const responseRow = {
        id: response.id,
        auditZoneId: response.auditZoneId,
        auditId: response.auditId,
        checklistQuestionId: response.checklistQuestionId,
        section: response.section,
        globalOrder: response.globalOrder,
        value: response.value,
        numericScore: response.numericScore,
        remark: response.remark,
        answeredAt: response.answeredAt,
        clientUpdatedAt: response.clientUpdatedAt,
        syncState: 'SYNCED',
      };
      await database
        .insert(localQuestionResponses)
        .values(responseRow)
        .onConflictDoUpdate({ target: localQuestionResponses.id, set: responseRow });
    }
  }

  for (const photo of evidence) {
    // The audit's own photographs. A corrective action's after-photo is not part of it.
    if (photo.auditId !== detail.id || photo.correctiveActionId) continue;
    const evidenceRow = {
      id: photo.id,
      kind: photo.kind,
      auditId: photo.auditId,
      auditZoneId: photo.auditZoneId,
      questionResponseId: photo.questionResponseId,
      localFileUri: photoFiles.get(photo.id) ?? null,
      objectKey: photo.objectKey,
      contentType: photo.contentType,
      byteSize: photo.byteSize,
      width: photo.width,
      height: photo.height,
      checksumSha256: photo.checksumSha256,
      scoreAtCapture: photo.scoreAtCapture,
      classification: photo.classification,
      remark: photo.remark,
      isSummaryFlagged: photo.isSummaryFlagged ? 1 : 0,
      isLiveCapture: photo.isLiveCapture ? 1 : 0,
      latitude: photo.latitude,
      longitude: photo.longitude,
      accuracyM: photo.accuracyM,
      locationProvider: photo.locationProvider,
      capturedAt: photo.capturedAt,
      uploadedAt: photo.uploadedAt ?? photo.capturedAt,
      deletedAt: photo.deletedAt,
      clientUpdatedAt: photo.uploadedAt ?? photo.capturedAt,
      syncState: 'SYNCED',
    };
    await database
      .insert(localEvidence)
      .values(evidenceRow)
      .onConflictDoUpdate({
        target: localEvidence.id,
        // A file this phone already holds stays: a placeholder must not replace a real photo.
        set: { ...evidenceRow, localFileUri: sql`coalesce(excluded.local_file_uri, ${localEvidence.localFileUri})` },
      });
  }
}

