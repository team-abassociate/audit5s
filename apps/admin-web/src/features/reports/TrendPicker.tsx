import { useMemo, useState } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDate, formatDateTime, formatScore, isAuditCompleted, zoneDisplayLabel } from '@audit5s/domain';
import type { Audit, AuditDetail, Page, ReportSnapshot, Zone } from '@audit5s/contracts';
import { api, fetchAll } from '@/lib/api';
import { Badge, Button, ErrorNotice, Field, Select, Spinner } from '@/components/ui';
import { PreviewButton } from './SummaryZonePicker';

/**
 * R-75: the summary of summaries' selection — any number of finished audits of one Zone
 * (zone-wise), or any number of issued Summary reports of the Unit (unit-wise). There is no
 * cap: how many to compare is the Super Admin's call, and the PDF lays out as many as are
 * ticked.
 */
export function TrendPicker({
  unitId,
  onQueued,
}: {
  unitId: string;
  onQueued?: (snapshot: ReportSnapshot) => void;
}) {
  const [scope, setScope] = useState<'ZONE' | 'UNIT'>('ZONE');

  return (
    <div className="space-y-3">
      <fieldset>
        <legend className="gb-label mb-2">Compare</legend>
        <div className="gb-choice">
          <label>
            <input type="radio" name="trend-scope" checked={scope === 'ZONE'} onChange={() => setScope('ZONE')} />
            <b>Zone-wise</b>
            <span>Audits of one Zone, side by side.</span>
          </label>
          <label>
            <input type="radio" name="trend-scope" checked={scope === 'UNIT'} onChange={() => setScope('UNIT')} />
            <b>Unit-wise</b>
            <span>Summary reports already issued for the Unit, side by side.</span>
          </label>
        </div>
      </fieldset>
      {scope === 'ZONE' ? (
        <ZoneAuditsPicker unitId={unitId} onQueued={onQueued} />
      ) : (
        <SummariesPicker unitId={unitId} onQueued={onQueued} />
      )}
    </div>
  );
}

function ZoneAuditsPicker({ unitId, onQueued }: { unitId: string; onQueued?: (snapshot: ReportSnapshot) => void }) {
  const [zoneId, setZoneId] = useState('');

  const zones = useQuery({
    queryKey: ['units', unitId, 'zones', 'all'],
    queryFn: () => api.get<Page<Zone>>(`/units/${unitId}/zones?limit=200`),
  });
  const audits = useQuery({
    queryKey: ['audits', 'unit', unitId],
    queryFn: () => fetchAll<Audit>(`/audits?limit=200&unitId=${unitId}`),
  });

  // Finished, scored audits that covered the Zone — a walk-by has no score to compare.
  const ofZone = useMemo(
    () =>
      (audits.data ?? [])
        .filter(
          (audit) =>
            audit.unitId === unitId &&
            audit.scored &&
            isAuditCompleted(audit.status) &&
            audit.completedAt &&
            audit.zoneIds?.includes(zoneId),
        )
        .sort((a, b) => b.completedAt!.localeCompare(a.completedAt!)),
    [audits.data, unitId, zoneId],
  );

  // The audit's Zones come with the audit (`GET /audits/{id}`), each with its live `zoneId`.
  const details = useQueries({
    queries: ofZone.map((audit) => ({
      queryKey: ['audit-detail', audit.id],
      queryFn: () => api.get<AuditDetail>(`/audits/${audit.id}`),
      staleTime: 60_000,
    })),
  });
  const rows = ofZone.flatMap((audit, index) => {
    const zone = details[index]?.data?.zones.find(
      (each) => each.zoneId === zoneId && each.status === 'COMPLETED',
    );
    return zone ? [{ audit, auditZoneId: zone.id, pct: zone.totals.scorePercentage }] : [];
  });
  const loading = details.some((query) => query.isLoading);

  return (
    <>
      <Field label="Zone">
        <Select value={zoneId} onChange={(event) => setZoneId(event.target.value)} disabled={zones.isLoading}>
          <option value="">{zones.isLoading ? 'Loading Zones…' : 'Choose a Zone…'}</option>
          {(zones.data?.data ?? []).map((zone) => (
            <option key={zone.id} value={zone.id}>
              {zoneDisplayLabel(zone.code, zone.name)}
            </option>
          ))}
        </Select>
      </Field>
      {zones.error ? <ErrorNotice error={zones.error} /> : null}
      {audits.error ? <ErrorNotice error={audits.error} /> : null}
      {!zoneId ? null : audits.isLoading || loading ? (
        <Spinner label="Loading audits…" />
      ) : (
        <Checklist
          key={zoneId}
          items={rows.map((row) => ({
            id: row.auditZoneId,
            label: formatDateTime(row.audit.completedAt!),
            detail: row.audit.auditorName,
            pct: row.pct,
          }))}
          empty="No finished, scored audit of this Zone yet."
          noun={['audit', 'audits']}
          body={(ids) => ({ kind: 'TREND_SUMMARY' as const, unitId, selectedAuditZoneIds: ids })}
          onQueued={onQueued}
        />
      )}
    </>
  );
}

function SummariesPicker({ unitId, onQueued }: { unitId: string; onQueued?: (snapshot: ReportSnapshot) => void }) {
  const reports = useQuery({
    queryKey: ['reports', 'summaries', unitId],
    queryFn: () => fetchAll<ReportSnapshot>(`/reports?limit=200&unitId=${unitId}&kind=MULTI_ZONE_SUMMARY`),
  });
  // Issued summaries only: a queued or failed one has printed nothing to compare.
  const issued = (reports.data ?? [])
    .filter((report) => report.status === 'READY')
    .sort((a, b) => (b.subject.auditedTo ?? b.generatedAt).localeCompare(a.subject.auditedTo ?? a.generatedAt));

  if (reports.isLoading) return <Spinner label="Loading Summary reports…" />;
  if (reports.error) return <ErrorNotice error={reports.error} />;
  return (
    <Checklist
      items={issued.map((report) => {
        const from = formatDate(report.subject.auditedFrom);
        const to = formatDate(report.subject.auditedTo);
        return {
          id: report.id,
          label: from === to ? from : `${from} – ${to}`,
          detail: `${report.subject.zoneCount} Zone${report.subject.zoneCount === 1 ? '' : 's'} · v${report.version}`,
          pct: null,
        };
      })}
      empty="No Summary report has been issued for this Unit yet. Issue one from Unit summary first."
      noun={['summary', 'summaries']}
      body={(ids) => ({ kind: 'TREND_SUMMARY' as const, unitId, selectedSnapshotIds: ids })}
      onQueued={onQueued}
    />
  );
}

/** A tickable list, "Choose all", Preview and Generate — the same for both scopes. */
function Checklist({
  items,
  empty,
  noun,
  body,
  onQueued,
}: {
  items: { id: string; label: string; detail: string; pct: number | null }[];
  empty: string;
  noun: [string, string];
  body: (ids: string[]) => unknown;
  onQueued?: (snapshot: ReportSnapshot) => void;
}) {
  const queryClient = useQueryClient();
  const [chosen, setChosen] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const count = `${chosen.length} ${chosen.length === 1 ? noun[0] : noun[1]}`;

  const generate = useMutation({
    mutationFn: () => api.post<ReportSnapshot>('/reports/generate', body(chosen)),
    onSuccess: (snapshot) => {
      setNotice(
        `Summary of summaries over ${count} queued as version ${snapshot.version}. It renders in ` +
          'the background; the history updates when it is ready.',
      );
      void queryClient.invalidateQueries({ queryKey: ['reports'] });
      onQueued?.(snapshot);
    },
  });

  if (items.length === 0) return <p className="text-sm text-ink-2">{empty}</p>;
  const all = items.every((item) => chosen.includes(item.id));

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium text-ink">{count} chosen</span>
        <Button variant="secondary" onClick={() => setChosen(all ? [] : items.map((item) => item.id))}>
          {all ? 'Clear all' : `Choose all ${items.length}`}
        </Button>
      </div>
      <div className="max-h-[28rem] overflow-y-auto border border-edge-soft">
        {items.map((item) => (
          <label key={item.id} className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-tile-2">
            <input
              type="checkbox"
              checked={chosen.includes(item.id)}
              onChange={(event) =>
                setChosen((current) =>
                  event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id),
                )
              }
            />
            <span className="font-medium text-ink">{item.label}</span>
            <span className="text-ink-2">{item.detail}</span>
            {item.pct !== null ? <Badge>{formatScore(item.pct)}%</Badge> : null}
          </label>
        ))}
      </div>
      {generate.error ? <ErrorNotice error={generate.error} /> : null}
      {notice ? <p className="gb-slip">{notice}</p> : null}
      <div className="gb-picker-actions flex gap-2">
        <PreviewButton disabled={chosen.length === 0} body={body(chosen)} />
        <Button onClick={() => generate.mutate()} disabled={chosen.length === 0 || generate.isPending}>
          {generate.isPending ? 'Queuing…' : `Generate summary of summaries${chosen.length > 0 ? ` (${count})` : ''}`}
        </Button>
      </div>
    </>
  );
}
