import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { Audit, AuditDetail, AuditZoneStatus } from '@audit5s/contracts';
import { bandTextClass } from '@/lib/bands';
import { cn } from '@/lib/cn';
import { api } from '@/lib/api';
import { Badge, Button, ErrorNotice, Spinner } from '@/components/ui';
import { useSession } from '@/lib/session';
import { SummaryZonePicker } from '@/features/reports/SummaryZonePicker';

const ZONE_STATUS_LABEL: Record<AuditZoneStatus, string> = {
  DRAFT: 'Not started',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
  WITHDRAWN: 'Withdrawn',
};

const ZONE_STATUS_TONE: Record<AuditZoneStatus, 'neutral' | 'warn' | 'good'> = {
  DRAFT: 'neutral',
  IN_PROGRESS: 'warn',
  COMPLETED: 'good',
  WITHDRAWN: 'neutral',
};

/**
 * One audit's progress, Zone by Zone — what a row of the audit board expands into.
 *
 * Reads `GET /audits/{id}`, the same scope-checked read the detail panel uses, so it shows
 * nothing the actor could not already open. Keyed like the panel, so opening one warms the
 * other.
 */
export function AuditProgress({ auditId, compact = false }: { auditId: string; compact?: boolean }) {
  const detail = useQuery({
    queryKey: ['audit-detail', auditId],
    queryFn: () => api.get<AuditDetail>(`/audits/${auditId}`),
    // Progress is the reason to look: keep it moving while the audit is open on a phone.
    refetchInterval: (query) =>
      query.state.data && ['IN_PROGRESS', 'PAUSED', 'READY', 'ASSIGNED'].includes(query.state.data.status)
        ? 30_000
        : false,
  });

  if (detail.isLoading) return <Spinner label="Loading progress…" />;
  if (detail.error) return <ErrorNotice error={detail.error} />;
  const audit = detail.data!;
  const zones = [...audit.zones].sort((a, b) => a.sequenceNo - b.sequenceNo);
  // A Zone the auditor withdrew is listed, but it is not part of the audit's progress.
  const live = zones.filter((zone) => zone.status !== 'WITHDRAWN');
  const done = live.filter((zone) => zone.status === 'COMPLETED').length;
  const going = live.filter((zone) => zone.status === 'IN_PROGRESS').length;

  return (
    <div className="space-y-2">
      <p className="gb-progress-line">
        <b>{audit.auditorName}</b>
        {zones.length === 0
          ? ' has not opened a Zone yet.'
          : ` · ${done} of ${live.length} Zone${live.length === 1 ? '' : 's'} completed` +
            (going > 0 ? ` · ${going} in progress` : '') +
            (live.length < zones.length ? ` · ${zones.length - live.length} withdrawn` : '')}
        {audit.startedAt ? ` · started ${new Date(audit.startedAt).toLocaleString()}` : ''}
      </p>
      {zones.length > 0 && (
        <>
          <div className="gb-meter" aria-hidden>
            <i style={{ width: `${live.length ? (done / live.length) * 100 : 0}%` }} />
            <i className="gb-meter--going" style={{ width: `${live.length ? (going / live.length) * 100 : 0}%` }} />
          </div>
          <ul className={cn('gb-zonelist', compact && 'gb-zonelist--compact')}>
            {zones.map((zone) => (
              <li key={zone.id}>
                <span className="gb-data">{zone.zoneCodeSnapshot}</span>
                <span className="min-w-0 flex-1 truncate">
                  {zone.zoneNameSnapshot}
                  {zone.zoneLeaderNameSnapshot ? (
                    <span className="text-ink-3"> · {zone.zoneLeaderNameSnapshot}</span>
                  ) : null}
                </span>
                <Badge tone={ZONE_STATUS_TONE[zone.status]}>{ZONE_STATUS_LABEL[zone.status]}</Badge>
                <span className={cn('gb-data w-16 text-right', bandTextClass(zone.totals.scorePercentage))}>
                  {!audit.scored || zone.status === 'WITHDRAWN' || zone.totals.maxScore === 0
                    ? '—'
                    : zone.totals.scorePercentage === null
                      ? 'N/A'
                      : `${zone.totals.scorePercentage.toFixed(1)}%`}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * One Unit audit shared by several auditors: each auditor's share, then the combined
 * summary report the group exists for.
 *
 * `audits` are the group's audits the caller already holds; an auditor with no audit yet
 * is named from `pending` so the team is shown whole, not only the half that has started.
 */
export function TeamProgress({
  unitId,
  audits,
  pending,
}: {
  unitId: string;
  audits: Audit[];
  pending: string[];
}) {
  return (
    <div className="space-y-4">
      {audits.map((audit) => (
        <AuditProgress key={audit.id} auditId={audit.id} compact />
      ))}
      {pending.map((name) => (
        <p key={name} className="gb-progress-line">
          <b>{name}</b> · not started on the device yet
        </p>
      ))}
      <CombinedSummaryButton unitId={unitId} auditIds={audits.map((audit) => audit.id)} />
    </div>
  );
}

/**
 * The combined unit summary of one team audit. It opens the same picker the Reports page
 * uses, narrowed to this team's audits, so the Super Admin chooses which of the Zones the
 * team finished go into it rather than being handed all of them.
 */
export function CombinedSummaryButton({
  unitId,
  auditIds,
}: {
  unitId: string;
  auditIds: readonly string[];
}) {
  const { can } = useSession();
  const [open, setOpen] = useState(false);

  if (!can('report', 'generate')) return null;

  return (
    <div className="space-y-3 border-t border-edge-soft pt-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant={open ? 'secondary' : 'primary'}
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
        >
          {open ? 'Close combined summary' : 'Generate combined unit summary'}
        </Button>
        <span className="text-xs text-ink-2">
          One report of this audit: choose from the Zones the team finished, whichever auditor
          did them.
        </span>
      </div>
      {open ? <SummaryZonePicker unitId={unitId} auditIds={auditIds} /> : null}
    </div>
  );
}
