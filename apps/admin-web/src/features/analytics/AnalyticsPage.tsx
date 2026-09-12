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
import { BRAND_TOKENS, RATING_BANDS, bandFor } from '@audit5s/domain';
import { Button, Card, CardHeader, ErrorNotice, Field, Select, Spinner, Table, Td, Th } from '@/components/ui';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';

const SECTION_LABELS: Record<string, string> = {
  S1_SORT: 'Sort',
  S2_SET_IN_ORDER: 'Set in order',
  S3_SHINE: 'Shine',
  S4_STANDARDIZE: 'Standardize',
  S5_SUSTAIN: 'Sustain',
};
const OUTSTANDING = RATING_BANDS[0]!;
const ON_TRACK = RATING_BANDS[1]!;
const IMPROVING = RATING_BANDS[2]!;

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
                <Select value={selectedUnit} onChange={(event) => setUnitId(event.target.value)}>
                  {(units.data?.data ?? []).map((unit) => (
                    <option key={unit.id} value={unit.id}>{unit.name} ({unit.code})</option>
                  ))}
                </Select>
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
  const ranking = data.unitRanking.map((unit) => ({
    unit: `${unit.unitCode} · ${unit.unitName}`,
    rank: unit.rank ?? 'Suppressed',
    score: unit.score.scorePercentage,
    samples: unit.score.sampleCount,
  }));
  return (
    <section className="space-y-4" aria-labelledby="organization-heading">
      <h1 id="organization-heading" className="text-lg font-semibold">Organization overview</h1>
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
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis type="number" domain={[0, 100]} />
            <YAxis dataKey="unit" type="category" width={130} />
            <Tooltip />
            <Bar dataKey="score" name="Weighted score">
              {ranking.map((row) => <Cell key={row.unit} fill={bandFor(row.score)?.color ?? BRAND_TOKENS.tableBorder} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </DatasetCard>
    </section>
  );
}

function UnitDashboard({ unitId }: { unitId: string }) {
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
      <h1 id="unit-heading" className="text-lg font-semibold">Unit dashboard</h1>
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
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="period" /><YAxis domain={[0, 100]} /><Tooltip />
              <ReferenceLine y={90} stroke={OUTSTANDING.color} strokeDasharray="4 4" label={OUTSTANDING.label} />
              <Line type="monotone" dataKey="score" stroke={ON_TRACK.color} strokeWidth={3} dot={{ r: 4 }} />
            </LineChart>
          </ResponsiveContainer>
        </DatasetCard>

        <DatasetCard title="Current vs previous S" rows={radarRows} filename="section-radar.csv">
          <ResponsiveContainer width="100%" height={280}>
            <RadarChart data={radarRows}>
              <PolarGrid /><PolarAngleAxis dataKey="section" />
              <Radar name="Current" dataKey="current" stroke={BRAND_TOKENS.maroon} fill={BRAND_TOKENS.maroon} fillOpacity={0.25} />
              <Radar name="Previous" dataKey="previous" stroke={ON_TRACK.color} fill={ON_TRACK.color} fillOpacity={0.12} />
              <Legend /><Tooltip />
            </RadarChart>
          </ResponsiveContainer>
        </DatasetCard>

        <DatasetCard title="Zone ranking · worst first" rows={zoneRows} filename="zone-ranking.csv">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={zoneRows} layout="vertical" margin={{ left: 30 }}>
              <CartesianGrid strokeDasharray="3 3" /><XAxis type="number" domain={[0, 100]} />
              <YAxis dataKey="zone" type="category" width={125} /><Tooltip />
              <Bar dataKey="score" name="Weighted score">
                {zoneRows.map((row) => <Cell key={row.zone} fill={bandFor(row.score)?.color ?? BRAND_TOKENS.tableBorder} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </DatasetCard>

        <DatasetCard title="Corrective-action funnel" rows={funnel} filename="closure-funnel.csv">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={funnel}>
              <CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="stage" /><YAxis allowDecimals={false} /><Tooltip />
              <Bar dataKey="count">
                {funnel.map((row, index) => <Cell key={row.stage} fill={(RATING_BANDS[Math.min(index + 1, RATING_BANDS.length - 1)] ?? IMPROVING).color} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </DatasetCard>

        <DatasetCard title="S trend" rows={sectionTrend} filename="section-trend.csv">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={sectionTrend}>
              <CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="period" /><YAxis domain={[0, 100]} /><Tooltip />
              <Bar dataKey="score" fill={IMPROVING.color} />
            </BarChart>
          </ResponsiveContainer>
        </DatasetCard>

        <DatasetCard title="Recurrent nonconformities" rows={recurrentRows} filename="recurrent-nonconformities.csv" />
      </div>
    </section>
  );
}

function Kpis({ values }: { values: Array<[string, ReactNode]> }) {
  return <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">{values.map(([label, value]) => (
    <Card key={label} className="p-4"><p className="text-xs text-neutral-500">{label}</p><p className="mt-1 text-2xl font-semibold">{value}</p></Card>
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
      {rows.length === 0 ? <p className="p-4 text-sm text-neutral-500">No data in this period.</p> : null}
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
