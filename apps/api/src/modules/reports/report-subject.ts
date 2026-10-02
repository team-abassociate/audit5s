import type { ReportPayload, ReportSubject } from '@audit5s/contracts';
import { zoneDisplayLabel } from '@audit5s/domain';

/**
 * What a report is about, read from its frozen payload (the history's Subject column).
 *
 * From the payload rather than the live Unit and Zone rows, for the reason the payload
 * exists: a Zone renamed in December must not relabel the report issued in March. Read
 * defensively — a payload frozen under an earlier schema may lack a field added since, and
 * the list must still render it.
 */
export function reportSubject(payload: ReportPayload): ReportSubject {
  const zones = payload.zones ?? [];
  const zone = payload.kind === 'MULTI_ZONE_SUMMARY' ? undefined : zones[0];

  const auditorNames =
    payload.auditorNames && payload.auditorNames.length > 0
      ? payload.auditorNames
      : [...new Set(zones.map((each) => each.auditorName).filter(Boolean))];

  // A Zone report is one audit, finished at one moment; only a summary covers a span.
  const range = zone ? null : payload.auditDateRange;
  const finished = payload.audit?.completedAt ?? zone?.auditDate ?? zones[0]?.auditDate ?? null;

  return {
    unitName: payload.unit?.name ?? '',
    zoneLabel: zone ? zoneDisplayLabel(zone.zoneCode, zone.zoneName) : null,
    zoneCount: zones.length,
    auditorNames,
    auditedFrom: range?.from ?? finished,
    auditedTo: range?.to ?? finished,
  };
}
