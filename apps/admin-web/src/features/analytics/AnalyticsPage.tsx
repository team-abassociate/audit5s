import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  PolarAngleAxis,
  PolarGrid,
  Radar,
  RadarChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type {
  ClosureAnalytics,
  OrganizationOverview,
  Page,
  RecurrentNonconformity,
  Unit,
  UnitOverview,
  UnitSections,
  UnitTrend,
  ZoneRankingItem,
} from '@audit5s/contracts';
import { bandOf } from '@/lib/bands';
import { useToken } from '@/lib/tokens';
import { Button, Card, CardHeader, Combobox, ErrorNotice, Field, Spinner, Table, Td, Th } from '@/components/ui';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';

const SECTION_LABELS: Record<string, string> = {
  S1_SORT: 'Sort',
  S2_SET_IN_ORDER: 'Set in order',
  S3_SHINE: 'Shine',
  S4_STANDARDIZE: 'Standardize',
  S5_SUSTAIN: 'Sustain',
};
/** Score-band tokens, resolved from the document so both themes work (§8). */
const BAND_TOKEN = { ok: '--ok-band', warn: '--warn-band', crit: '--crit-band', none: '--edge-soft' } as const;

export function AnalyticsPage() {
  const { can } = useSession();
  const organizationWide = can('analytics', 'organization_dashboard');
  const units = useQuery({
    queryKey: ['units'],
    queryFn: () => api.get<Page<Unit>>('/units?limit=200'),
  });
  const [unitId, setUnitId] = useState('');
  const selectedUnit = unitId || units.data?.data[0]?.id || '';

  const organization = useQuery({
    queryKey: ['analytics', 'organization'],
    queryFn: () => api.get<OrganizationOverview>('/analytics/organization/overview'),
    enabled: organizationWide,
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Analytics"
          description="Completed work, weighted scores, closure, recurrence and field activity. Rankings need at least three scored audits."
          action={
            <div className="w-64">
              <Field label="Unit">
                <Combobox
                  value={selectedUnit}
                  onChange={setUnitId}
                  options={(units.data?.data ?? []).map((unit) => ({ id: unit.id, label: unit.name }))}
                  placeholder="Search Units…"
                />
              </Field>
            </div>
          }
        />
      </Card>

      {organizationWide ? (
        organization.isLoading ? <Spinner /> : organization.error ? <ErrorNotice error={organization.error} /> : organization.data ? <OrganizationDashboard data={organization.data} /> : null
      ) : null}
      {selectedUnit ? <UnitDashboard unitId={selectedUnit} /> : null}
    </div>
  );
}

function OrganizationDashboard({ data }: { data: OrganizationOverview }) {
  const token = useToken();
  const ranking = data.unitRanking.map((unit) => ({
    unit: unit.unitName,
    rank: unit.rank ?? 'Suppressed',
    score: unit.score.scorePercentage,
    samples: unit.score.sampleCount,
  }));
  return (
    <section className="space-y-4" aria-labelledby="organization-heading">
      <div className="gb-head"><h2 id="organization-heading" className="gb-h1">Organization overview</h2></div>
      <Kpis values={[
        ['Completed audits', data.completedCount],
        ['Weighted score', pct(data.score.scorePercentage)],
        ['Open nonconformities', data.openNonconformities],
        ['Closure rate', pct(data.closureRatePercentage)],
        ['Active auditors', data.activeAuditors],
        ['Sync attention', data.syncHealth.devicesWithUnsyncedData],
      ]} />
      <DatasetCard title="Unit ranking" rows={ranking} filename="unit-ranking.csv">
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={ranking} layout="vertical" margin={{ left: 30 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={token('--edge-soft')} />
            <XAxis type="number" domain={[0, 100]} stroke={token('--ink-3')} />
            <YAxis dataKey="unit" type="category" width={130} stroke={token('--ink-3')} />
            <Tooltip contentStyle={TOOLTIP} />
            <Bar dataKey="score" name="Weighted score">
              {ranking.map((row) => <Cell key={row.unit} fill={token(BAND_TOKEN[bandOf(row.score)])} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </DatasetCard>
    </section>
  );
}

function UnitDashboard({ unitId }: { unitId: string }) {
  const token = useToken();
  const overview = useQuery({ queryKey: ['analytics', unitId, 'overview'], queryFn: () => api.get<UnitOverview>(`/analytics/units/${unitId}/overview`) });
  const trend = useQuery({ queryKey: ['analytics', unitId, 'trend'], queryFn: () => api.get<UnitTrend>(`/analytics/units/${unitId}/trend`) });
  const sections = useQuery({ queryKey: ['analytics', unitId, 'sections'], queryFn: () => api.get<UnitSections>(`/analytics/units/${unitId}/sections`) });
  const ranking = useQuery({ queryKey: ['analytics', unitId, 'ranking'], queryFn: () => api.get<ZoneRankingItem[]>(`/analytics/units/${unitId}/zones/ranking?order=worst`) });
  const recurrence = useQuery({ queryKey: ['analytics', unitId, 'recurrence'], queryFn: () => api.get<RecurrentNonconformity[]>(`/analytics/units/${unitId}/nonconformities/recurrent`) });
  const closure = useQuery({ queryKey: ['analytics', unitId, 'closure'], queryFn: () => api.get<ClosureAnalytics>(`/analytics/corrective-actions/closure?unitId=${unitId}`) });
  const pending = [overview, trend, sections, ranking, recurrence, closure].some((query) => query.isLoading);
  const error = [overview, trend, sections, ranking, recurrence, closure].find((query) => query.error)?.error;
  if (pending) return <Spinner label="Loading Unit dashboard…" />;
  if (error) return <ErrorNotice error={error} />;
  if (!overview.data || !trend.data || !sections.data || !ranking.data || !recurrence.data || !closure.data) return null;

  const trendRows = trend.data.points.map((point) => ({ period: point.period, score: point.scorePercentage, audits: point.auditCount }));
  const zoneRows = ranking.data.map((zone) => ({
    zone: `${zone.zoneCode} · ${zone.zoneName}`,
    rank: zone.rank ?? 'Suppressed',
    score: zone.score.scorePercentage,
    samples: zone.score.sampleCount,
    delta: zone.improvement,
    openNonconformities: zone.openNonconformities,
    weakSection: zone.dominantWeakSection ? SECTION_LABELS[zone.dominantWeakSection] : '—',
  }));
  const radarRows = sections.data.radar.map((row) => ({ section: SECTION_LABELS[row.section], current: row.currentScorePercentage, previous: row.previousScorePercentage, samples: row.sampleCount }));
  const sectionTrend = sections.data.trend.map((row) => ({ period: row.period, section: SECTION_LABELS[row.section], score: row.scorePercentage, samples: row.sampleCount }));
  const funnel = [
    { stage: 'Open', count: closure.data.opened },
    { stage: 'Submitted', count: closure.data.submitted },
    { stage: 'Verified', count: closure.data.resolved },
  ];
  const recurrentRows = recurrence.data.map((row) => ({ zone: `${row.zoneCode} · ${row.zoneName}`, section: SECTION_LABELS[row.section], question: row.questionText, failures: row.failureCount, lastSeen: new Date(row.lastSeenAt).toLocaleDateString() }));

  return (
    <section className="space-y-4" aria-labelledby="unit-heading">
      <div className="gb-head"><h2 id="unit-heading" className="gb-h1">Unit dashboard</h2></div>
      <Kpis values={[
        ['Completed audits', overview.data.completedCount],
        ['Weighted score', pct(overview.data.score.scorePercentage)],
        ['Zones', overview.data.zoneCount],
        ['Open nonconformities', overview.data.openNonconformities],
        ['Closure rate', pct(overview.data.closureRatePercentage)],
        ['Avg closure', overview.data.averageClosureHours === null ? '—' : `${overview.data.averageClosureHours.toFixed(1)} h`],
      ]} />

      <div className="grid gap-4 lg:grid-cols-2">
        <DatasetCard title="Unit score trend" rows={trendRows} filename="unit-score-trend.csv">
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={trendRows}>
              <CartesianGrid strokeDasharray="3 3" stroke={token('--edge-soft')} />
              <XAxis dataKey="period" stroke={token('--ink-3')} />
              <YAxis domain={[0, 100]} stroke={token('--ink-3')} />
              <Tooltip contentStyle={TOOLTIP} />
              <ReferenceLine y={90} stroke={token('--crit-band')} strokeDasharray="4 4" label="Outstanding 90" />
              <Line type="monotone" dataKey="score" stroke={token('--ok-band')} strokeWidth={3} dot={{ r: 4 }} />
            </LineChart>
          </ResponsiveContainer>
        </DatasetCard>

        <DatasetCard title="Current vs previous S" rows={radarRows} filename="section-radar.csv">
          <ResponsiveContainer width="100%" height={280}>
            <RadarChart data={radarRows}>
              <PolarGrid stroke={token('--edge-soft')} />
              <PolarAngleAxis dataKey="section" stroke={token('--ink-3')} />
              {/* Current is the score colour; the previous cycle is neutral ink, not a
                  second hue — the accent is never a chart fill (non-negotiable 6). */}
              <Radar name="Current" dataKey="current" stroke={token('--ok-band')} fill={token('--ok-band')} fillOpacity={0.25} />
              <Radar name="Previous" dataKey="previous" stroke={token('--ink-3')} fill={token('--ink-3')} fillOpacity={0.12} />
              <Legend /><Tooltip contentStyle={TOOLTIP} />
            </RadarChart>
          </ResponsiveContainer>
        </DatasetCard>

        <DatasetCard title="Zone ranking · worst first" rows={zoneRows} filename="zone-ranking.csv">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={zoneRows} layout="vertical" margin={{ left: 30 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={token('--edge-soft')} />
              <XAxis type="number" domain={[0, 100]} stroke={token('--ink-3')} />
              <YAxis dataKey="zone" type="category" width={125} stroke={token('--ink-3')} />
              <Tooltip contentStyle={TOOLTIP} />
              <Bar dataKey="score" name="Weighted score">
                {zoneRows.map((row) => <Cell key={row.zone} fill={token(BAND_TOKEN[bandOf(row.score)])} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </DatasetCard>

        <DatasetCard title="Corrective-action funnel" rows={funnel} filename="closure-funnel.csv">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={funnel}>
              <CartesianGrid strokeDasharray="3 3" stroke={token('--edge-soft')} />
              <XAxis dataKey="stage" stroke={token('--ink-3')} />
              <YAxis allowDecimals={false} stroke={token('--ink-3')} />
              <Tooltip contentStyle={TOOLTIP} />
              <Bar dataKey="count">
                {funnel.map((row) => <Cell key={row.stage} fill={token('--ink-3')} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </DatasetCard>

        <DatasetCard title="S trend" rows={sectionTrend} filename="section-trend.csv">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={sectionTrend}>
              <CartesianGrid strokeDasharray="3 3" stroke={token('--edge-soft')} />
              <XAxis dataKey="period" stroke={token('--ink-3')} />
              <YAxis domain={[0, 100]} stroke={token('--ink-3')} />
              <Tooltip contentStyle={TOOLTIP} />
              <Bar dataKey="score" fill={token('--warn-band')} />
            </BarChart>
          </ResponsiveContainer>
        </DatasetCard>

        <DatasetCard title="Recurrent nonconformities" rows={recurrentRows} filename="recurrent-nonconformities.csv" />
      </div>
    </section>
  );
}

/** A tooltip on the board is a small magnet: tile ground, hard ink edge, no radius. */
const TOOLTIP = {
  background: 'var(--tile)',
  border: '1.5px solid var(--edge)',
  borderRadius: 0,
  color: 'var(--ink)',
  fontSize: 12.5,
} as const;

function Kpis({ values }: { values: Array<[string, ReactNode]> }) {
  return <div className="gb-kpis">{values.map(([label, value]) => (
    <div key={label} className="gb-tile gb-kpi"><span className="gb-label">{label}</span><b className="gb-figure">{value}</b></div>
  ))}</div>;
}

function DatasetCard({ title, rows, filename, children }: { title: string; rows: Array<Record<string, unknown>>; filename: string; children?: ReactNode }) {
  const [table, setTable] = useState(!children);
  const headers = useMemo(() => Object.keys(rows[0] ?? {}), [rows]);
  useEffect(() => { if (!children) setTable(true); }, [children]);
  return (
    <Card>
      <CardHeader title={title} action={<div className="flex gap-2">
        {children ? <Button variant="secondary" onClick={() => setTable((value) => !value)}>{table ? 'Show chart' : 'Show table'}</Button> : null}
        <Button variant="secondary" disabled={rows.length === 0} onClick={() => downloadCsv(filename, rows)}>Export CSV</Button>
      </div>} />
      {table ? <Table><thead><tr>{headers.map((header) => <Th key={header}>{label(header)}</Th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{headers.map((header) => <Td key={header}>{display(row[header])}</Td>)}</tr>)}</tbody></Table> : <div className="p-3">{children}</div>}
      {rows.length === 0 ? <p className="p-4 text-sm text-ink-3">No data in this period.</p> : null}
    </Card>
  );
}

function pct(value: number | null): string { return value === null ? 'N/A' : `${value.toFixed(1)}%`; }
function display(value: unknown): string { return value === null || value === undefined ? '—' : typeof value === 'number' ? Number.isInteger(value) ? String(value) : value.toFixed(2) : String(value); }
function label(value: string): string { return value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (char) => char.toUpperCase()); }

function downloadCsv(filename: string, rows: Array<Record<string, unknown>>): void {
  const headers = Object.keys(rows[0] ?? {});
  const escape = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const csv = [headers.map(escape).join(','), ...rows.map((row) => headers.map((header) => escape(row[header])).join(','))].join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
