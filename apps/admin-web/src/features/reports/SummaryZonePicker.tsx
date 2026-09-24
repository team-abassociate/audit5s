import { useMemo, useState } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { isAuditCompleted, zoneDisplayLabel } from '@audit5s/domain';
import type { Audit, AuditScoreSummary, ReportSnapshot } from '@audit5s/contracts';
import { api, fetchAll } from '@/lib/api';
import { Badge, Button, ErrorNotice, Field, Select, Spinner } from '@/components/ui';

/**
 * The unit summary's selection, made one audited Zone at a time.
 *
 * A Unit is audited several times a month, and the summary a Super Admin wants is rarely
 * "the latest of every Zone": it is Zones 1 and 2 from the first audit and Zones 3, 4 and 5
 * from the second. So the choice is laid out the way the work happened — each finished
 * audit with its date and auditor, and under it the Zones that audit finished — and what is
 * sent is exactly the audited Zones ticked (`selectedAuditZoneIds`). The server stores that
 * list on the snapshot, so a regeneration is the same document.
 *
 * `auditIds` narrows the list to some audits of the Unit — one team audit's, for the
 * combined summary of several auditors' work.
 */
export function SummaryZonePicker({
  unitId,
  auditIds,
  onQueued,
}: {
  unitId: string;
  auditIds?: readonly string[];
  onQueued?: (snapshot: ReportSnapshot) => void;
}) {
  const queryClient = useQueryClient();
  const [month, setMonth] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const audits = useQuery({
    queryKey: ['audits', 'unit', unitId],
    queryFn: () => fetchAll<Audit>(`/audits?limit=200&unitId=${unitId}`),
  });

  // Finished audits only — a summary states scores, and an open audit's are still moving.
  // Newest first, because the audit someone wants to summarise is nearly always recent.
  const finished = useMemo(
    () =>
      (audits.data ?? [])
        .filter((audit) => audit.unitId === unitId && isAuditCompleted(audit.status) && audit.completedAt)
        .filter((audit) => !auditIds || auditIds.includes(audit.id))
        .sort((a, b) => b.completedAt!.localeCompare(a.completedAt!)),
    [audits.data, unitId, auditIds],
  );

  const months = useMemo(
    () => [...new Set(finished.map((audit) => monthKey(audit.completedAt!)))],
    [finished],
  );
  // The newest month by default: "five audits this month" is the case this is for, and a
  // year of audits on one screen buries it. A team audit is one day, so it shows whole.
  const shownMonth = auditIds ? 'ALL' : (month ?? months[0] ?? 'ALL');
  const shown = finished.filter(
    (audit) => shownMonth === 'ALL' || monthKey(audit.completedAt!) === shownMonth,
  );

  const summaries = useQueries({
    queries: shown.map((audit) => ({
      queryKey: ['audit', audit.id, 'summary'],
      queryFn: () => api.get<AuditScoreSummary>(`/audits/${audit.id}/summary`),
      staleTime: 60_000,
    })),
  });

  /** Each shown audit's finished Zones — only those can be summarised. */
  const zonesByAudit = new Map(
    shown.map((audit, index) => [
      audit.id,
      (summaries[index]?.data?.zones ?? []).filter(
        (zone) => zone.status === 'COMPLETED' && zone.auditZoneId,
      ),
    ]),
  );
  const shownZoneIds = [...zonesByAudit.values()].flat().map((zone) => zone.auditZoneId!);

  const toggle = (ids: string[], on: boolean) =>
    setChosen((current) =>
      on ? [...new Set([...current, ...ids])] : current.filter((id) => !ids.includes(id)),
    );

  const body = { kind: 'MULTI_ZONE_SUMMARY' as const, unitId, selectedAuditZoneIds: chosen };

  const generate = useMutation({
    mutationFn: () => api.post<ReportSnapshot>('/reports/generate', body),
    onSuccess: (snapshot) => {
      setNotice(
        `Summary of ${chosen.length} Zone${chosen.length === 1 ? '' : 's'} queued as version ` +
          `${snapshot.version}. It renders in the background; the history updates when it is ready.`,
      );
      void queryClient.invalidateQueries({ queryKey: ['reports'] });
      onQueued?.(snapshot);
    },
  });

  if (audits.isLoading) return <Spinner label="Loading audits…" />;
  if (audits.error) return <ErrorNotice error={audits.error} />;
  if (finished.length === 0) {
    return (
      <p className="text-sm text-ink-2">
        No finished audit here yet. A summary is made from Zones of finished audits.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        {!auditIds && months.length > 1 ? (
          <div className="w-56">
            <Field label="Audits finished in">
              <Select value={shownMonth} onChange={(event) => setMonth(event.target.value)}>
                {months.map((key) => (
                  <option key={key} value={key}>
                    {monthLabel(key)}
                  </option>
                ))}
                <option value="ALL">Any month</option>
              </Select>
            </Field>
          </div>
        ) : null}
        <span className="text-sm font-medium text-ink">
          {chosen.length} Zone{chosen.length === 1 ? '' : 's'} chosen
        </span>
        {shownZoneIds.length > 0 ? (
          <Button
            variant="secondary"
            onClick={() => toggle(shownZoneIds, !shownZoneIds.every((id) => chosen.includes(id)))}
          >
            {shownZoneIds.every((id) => chosen.includes(id)) ? 'Clear all shown' : 'Choose all shown'}
          </Button>
        ) : null}
        {chosen.length > 0 ? (
          <Button variant="secondary" onClick={() => setChosen([])}>
            Clear
          </Button>
        ) : null}
      </div>

      <div className="max-h-[28rem] overflow-y-auto border border-edge-soft">
        {shown.map((audit, index) => {
          const zones = zonesByAudit.get(audit.id) ?? [];
          const ids = zones.map((zone) => zone.auditZoneId!);
          const all = ids.length > 0 && ids.every((id) => chosen.includes(id));
          const some = ids.some((id) => chosen.includes(id));
          return (
            <section key={audit.id} className="border-b border-edge-soft last:border-b-0">
              <label className="flex flex-wrap items-center gap-2 bg-board px-3 py-2 text-sm">
                <input
                  type="checkbox"
                  checked={all}
                  ref={(input) => {
                    if (input) input.indeterminate = some && !all;
                  }}
                  disabled={ids.length === 0}
                  onChange={(event) => toggle(ids, event.target.checked)}
                  aria-label={`Every Zone of the audit finished ${formatDay(audit.completedAt!)}`}
                />
                <span className="font-medium text-ink">{formatDay(audit.completedAt!)}</span>
                <span className="text-ink-2">
                  {audit.auditorName} · {zones.length} Zone{zones.length === 1 ? '' : 's'}
                </span>
                {audit.scored && audit.totals.scorePercentage !== null ? (
                  <Badge>{audit.totals.scorePercentage.toFixed(1)}%</Badge>
                ) : null}
              </label>
              {summaries[index]?.isLoading ? (
                <p className="px-8 py-1.5 text-xs text-ink-2">Loading Zones…</p>
              ) : null}
              {summaries[index]?.error ? (
                <div className="px-8 py-1.5">
                  <ErrorNotice error={summaries[index].error} />
                </div>
              ) : null}
              {zones.map((zone) => (
                <label
                  key={zone.auditZoneId}
                  className="flex items-center gap-2 px-8 py-1 text-sm hover:bg-tile-2"
                >
                  <input
                    type="checkbox"
                    checked={chosen.includes(zone.auditZoneId!)}
                    onChange={(event) => toggle([zone.auditZoneId!], event.target.checked)}
                  />
                  <span className="text-ink">{zoneDisplayLabel(zone.zoneCode, zone.zoneName)}</span>
                  {zone.checklistTemplateName ? (
                    <span className="text-xs text-ink-2">{zone.checklistTemplateName}</span>
                  ) : null}
                  {zone.totals.scorePercentage !== null ? (
                    <span className="ml-auto gb-data text-xs text-ink-2">
                      {zone.totals.scorePercentage.toFixed(1)}%
                    </span>
                  ) : null}
                </label>
              ))}
            </section>
          );
        })}
      </div>

      <p className="text-xs text-ink-2">
        Every figure in the summary is computed over the Zones chosen here only. The same Zone
        may be taken from one audit and left out of another.
      </p>

      {generate.error ? <ErrorNotice error={generate.error} /> : null}
      {notice ? <p className="gb-slip">{notice}</p> : null}

      <div className="flex gap-2">
        <Button onClick={() => generate.mutate()} disabled={chosen.length === 0 || generate.isPending}>
          {generate.isPending
            ? 'Queuing…'
            : `Generate summary${chosen.length > 0 ? ` of ${chosen.length} Zone${chosen.length === 1 ? '' : 's'}` : ''}`}
        </Button>
        <PreviewButton disabled={chosen.length === 0} body={body} />
      </div>
    </div>
  );
}

/**
 * `POST /reports/preview` — the HTML, in a new tab, with no snapshot and no link minted.
 *
 * It goes through `fetch` rather than the JSON client because the response is a document
 * rather than a payload, and it is opened as a blob so the browser renders it without this
 * application having to host it.
 */
export function PreviewButton({ disabled, body }: { disabled: boolean; body: unknown }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function open() {
    setBusy(true);
    setError(null);
    try {
      const html = await api.postText('/reports/preview', body);
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      window.open(url, '_blank', 'noopener');
      // Revoked on a timer rather than immediately: the new tab has to fetch it first.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="secondary" onClick={open} disabled={disabled || busy}>
        {busy ? 'Rendering…' : 'Preview'}
      </Button>
      {error ? <ErrorNotice error={error} /> : null}
    </>
  );
}

/** `2026-09`, in the viewer's own calendar — the month an auditor would name. */
function monthKey(iso: string): string {
  const at = new Date(iso);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(key: string): string {
  const [year, month] = key.split('-').map(Number);
  return new Date(year!, month! - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}

function formatDay(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
