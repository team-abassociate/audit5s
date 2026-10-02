import type { ReportPayload } from '@audit5s/contracts';
import { zoneDisplayLabel } from '@audit5s/domain';
import { formatDate } from './templates/components';

/**
 * The name a report's PDF is saved under — `Nashik Plant - Zone 2 - Press - Initial -
 * 02 Oct 2026 - v3.pdf` — instead of the storage key's `v3.pdf`.
 *
 * A consultant forwards these files to a client, and a folder of `v1.pdf`, `v2.pdf` says
 * nothing about which plant, Zone or visit each one is. Everything here comes from the
 * frozen payload, so a report saved in December is named for what was issued in March, and
 * the date is the one the report itself prints (`formatDate`, UTC), never the day it was
 * downloaded.
 *
 * Plain hyphens rather than the em dash `zoneDisplayLabel` writes, and no character a
 * Windows or macOS file system or a mail client refuses: the name has to survive being
 * attached, saved and attached again.
 */
export function reportFileName(payload: ReportPayload): string {
  const parts = [payload.unit.name];

  if (payload.kind === 'MULTI_ZONE_SUMMARY') {
    parts.push('Unit summary', `${payload.zones.length} ${payload.zones.length === 1 ? 'Zone' : 'Zones'}`);
  } else {
    const zone = payload.zones[0];
    if (zone) parts.push(zoneDisplayLabel(zone.zoneCode, zone.zoneName));
    parts.push(payload.kind === 'AFTER_EVIDENCE_ZONE' ? 'After-evidence' : 'Initial');
  }

  parts.push(dateOf(payload), `v${payload.version}`);
  return `${sanitize(parts.join(' - '))}.pdf`;
}

/** The audit's own date; a summary over several audits names the span it covers. */
function dateOf(payload: ReportPayload): string {
  const range = payload.auditDateRange;
  if (range) {
    const from = formatDate(range.from);
    const to = formatDate(range.to);
    return from === to ? from : `${from} to ${to}`;
  }
  const audited =
    payload.audit?.completedAt ?? payload.zones[0]?.auditDate ?? payload.generatedAt;
  return formatDate(audited);
}

/** The longest a name may be before `.pdf`; several file systems stop at 255 bytes. */
const MAX_NAME_LENGTH = 150;

function sanitize(name: string): string {
  const cleaned = name
    .replace(/[–—]/g, '-')
    // Reserved on Windows or macOS, plus control characters.
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Windows refuses a name ending in a dot or a space.
    .replace(/[. ]+$/, '');
  return (cleaned.length > MAX_NAME_LENGTH ? cleaned.slice(0, MAX_NAME_LENGTH).trimEnd() : cleaned) || 'report';
}
