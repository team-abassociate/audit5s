import { useQuery } from '@tanstack/react-query';
import type { AuditDetail, AuditType, Evidence, EvidenceViewUrl, SyncBatchResponse, SyncCatalogue } from '@audit5s/contracts';
import { uuidv7 } from '@audit5s/domain';
import { api, type DeviceApi } from '@/lib/api';

/**
 * What the web's audit screens share (R-51). The browser conducts an audit through the same
 * REST doors the phone's sync reaches, as a registered device: reads are plain, every write
 * carries `X-Device-Id` (`useWebDevice`). The catalogue is the phone's own bootstrap, read
 * live, so the Units, Zones and departments offered are exactly the phone's.
 */

export const AUDIT_TYPE_LABEL: Record<AuditType, string> = {
  EXTERNAL_5S: '5S audit',
  WALK_BY: 'Walk-by',
  CROSS_5S: 'Cross audit',
};

/** The types this person may start, from the server's grants (PART 6, R-18). */
export function startableTypes(can: (resource: string, action: string) => boolean): AuditType[] {
  const types: AuditType[] = [];
  if (can('audit', 'create_external')) types.push('EXTERNAL_5S');
  if (can('audit', 'create_walk_by')) types.push('WALK_BY');
  if (can('audit', 'create_cross')) types.push('CROSS_5S');
  return types;
}

export function useCatalogue() {
  return useQuery({
    queryKey: ['sync-catalogue'],
    queryFn: () => api.get<SyncCatalogue>('/sync/catalogue?overallActions=true'),
    staleTime: 5 * 60_000,
  });
}

/** The departments a Unit is offered (0042): a template ticked for no industry is offered everywhere. */
export function versionsForUnit(catalogue: SyncCatalogue, unitId: string) {
  const unit = catalogue.units.find((u) => u.id === unitId);
  const industries = new Map(catalogue.checklistTemplates.map((t) => [t.id, t.industries.map((i) => i.id)]));
  return catalogue.checklistVersions
    .filter((version) => {
      const ticked = industries.get(version.templateId) ?? [];
      return !unit?.industryId || ticked.length === 0 || ticked.includes(unit.industryId);
    })
    .sort((a, b) => a.templateName.localeCompare(b.templateName));
}

export function useAuditDetail(auditId: string) {
  return useQuery({
    queryKey: ['conduct', 'audit', auditId],
    queryFn: () => api.get<AuditDetail>(`/audits/${auditId}`),
  });
}

export function useZoneEvidence(auditZoneId: string) {
  return useQuery({
    queryKey: ['conduct', 'evidence', auditZoneId],
    queryFn: async () => (await api.get<{ data: Evidence[] }>(`/audit-zones/${auditZoneId}/evidence?limit=200`)).data,
  });
}

/** The phone's per-Zone cap (`photo-limit.ts`): question photos and walk-by photos count. */
export const ZONE_PHOTO_LIMIT = 25;
export const isZoneAuditPhoto = (kind: string) => kind === 'QUESTION_EVIDENCE' || kind === 'WALK_BY_PHOTO';

/** A short-lived thumbnail (§12.6), re-minted when it would expire. */
export function EvidenceThumb({ evidence, onOpen }: { evidence: Pick<Evidence, 'id'>; onOpen?: () => void }) {
  const view = useQuery({
    queryKey: ['evidence-view-url', evidence.id],
    queryFn: () => api.get<EvidenceViewUrl>(`/evidence/${evidence.id}/view-url`),
    staleTime: 240_000,
  });
  return (
    <button type="button" className="gb-conduct-thumb" onClick={onOpen} aria-label="Open photograph">
      {view.data ? <img src={view.data.url} alt="" referrerPolicy="no-referrer" /> : null}
    </button>
  );
}

/**
 * A Zone withdrawn from its audit. The one move the REST surface does not carry (it rides
 * the sync batch as `audit_zone:withdraw`), so the browser sends it the phone's way: a
 * one-item batch from this device.
 */
export async function withdrawZone(client: DeviceApi, deviceId: string, auditId: string, auditZoneId: string) {
  const outboxId = uuidv7();
  const response = await client.post<SyncBatchResponse>('/sync/batch', {
    batchId: uuidv7(),
    deviceId,
    appVersion: 'web',
    items: [
      { outboxId, entityType: 'audit_zone', entityId: auditZoneId, operation: 'withdraw', payload: { auditId, reason: 'Aborted by auditor' } },
    ],
  });
  const verdict = response.results.find((result) => result.outboxId === outboxId);
  if (verdict?.status !== 'ACCEPTED' && verdict?.status !== 'DUPLICATE') {
    throw new Error(verdict?.errors?.join(' ') || `The Zone could not be aborted (${verdict?.reason ?? verdict?.status ?? 'no answer'}).`);
  }
}
