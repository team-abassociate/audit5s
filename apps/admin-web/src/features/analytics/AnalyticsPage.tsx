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
  Audit,
  AuditScoreSummary,
  ClosureAnalytics,
  CorrectiveAction,
  OrganizationOverview,
  Page,
  RecurrentNonconformity,
  Unit,
  UnitSections,
  User,
} from '@audit5s/contracts';
import { bandOf } from '@/lib/bands';
import { useToken } from '@/lib/tokens';
import { Button, Card, CardHeader, Combobox, ErrorNotice, Field, Select, Spinner, Table, Td, Th } from '@/components/ui';
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

/** An audit and its place in the Unit's own sequence — Audit 1 is the oldest one. */
interface NumberedAudit {
  audit: Audit;
  number: number;
}

export function AnalyticsPage() {
  const { can } = useSession();
  const organizationWide = can('analytics', 'organization_dashboard');
  const units = useQuery({
    queryKey: ['analytics', 'units'],
    queryFn: () => fetchAll<Unit>('/units?limit=200'),
  });
  const [unitId, setUnitId] = useState('');
  const selectedUnit = unitId || units.data?.[0]?.id || '';

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Analytics"
          description="The organization at a glance, then one Unit and one audit at a time."
        />
      </Card>

      {organizationWide ? <OrganizationSection units={units.data ?? []} loading={units.isLoading} /> : null}
      {units.error ? <ErrorNotice error={units.error} /> : null}

      <Card>
        <CardHeader
          title="Unit analytics"
          description="Pick the Unit, then the audit. Every figure below is that audit's own, not an average of audits."
          action={
            <div className="w-64">
              <Field label="Unit">
                <Combobox
                  value={selectedUnit}
                  onChange={setUnitId}
                  options={(units.data ?? []).map((unit) => ({ id: unit.id, label: unit.name }))}
                  placeholder="Search Units…"
                />
              </Field>
            </div>
          }
        />
      </Card>

      {selectedUnit ? <UnitDashboard key={selectedUnit} unitId={selectedUnit} /> : null}
    </div>
  );
}

// ------------------------------------------------------------------------ organization

/**
 * The four counts that answer "how big is this, and who runs it": active Units, audits
 * actually conducted, active auditors, Coordinators. Counted from the live lists rather
 * than the daily rollups, so a Unit audited this morning is already in the number.
 */
function OrganizationSection({ units, loading }: { units: Unit[]; loading: boolean }) {
  const token = useToken();
  const { can } = useSession();
  const canReadUsers = can('user', 'read');
  const audits = useQuery({
    queryKey: ['analytics', 'organization', 'audits'],
    queryFn: () => fetchAll<Audit>('/audits?limit=200'),
  });
  const people = useQuery({
    queryKey: ['analytics', 'organization', 'people'],
    queryFn: () => fetchAll<User>('/users?status=ACTIVE&limit=200'),
    enabled: canReadUsers,
  });
  const organization = useQuery({
    queryKey: ['analytics', 'organization'],
    queryFn: () => api.get<OrganizationOverview>('/analytics/organization/overview'),
  });

  const conducted = (audits.data ?? []).filter((audit) => audit.completedAt !== null).length;
  const auditors = canReadUsers
    ? (people.data ?? []).filter((person) => person.role === 'CONSULTANT').length
    : organization.data?.activeAuditors ?? null;
  const coordinators = canReadUsers
    ? (people.data ?? []).filter((person) => person.role === 'COORDINATOR').length
    : null;
  const pending = loading || audits.isLoading || (canReadUsers && people.isLoading);

  const ranking = (organization.data?.unitRanking ?? []).map((unit) => ({
    unit: unit.unitName,
    rank: unit.rank ?? 'Suppressed',
    score: unit.score.scorePercentage,
    samples: unit.score.sampleCount,
  }));

  return (
    <section className="space-y-4" aria-labelledby="organization-heading">
      <div className="gb-head"><h2 id="organization-heading" className="gb-h1">Organization overview</h2></div>
      {pending ? <Spinner label="Counting…" /> : (
        <Kpis values={[
          ['Active units', units.length],
          ['Audits conducted', conducted],
          ['Active auditors', auditors ?? '—'],
          ['Coordinators', coordinators ?? '—'],
        ]} />
      )}
      {audits.error ? <ErrorNotice error={audits.error} /> : null}
      {ranking.length > 0 ? (
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
      ) : null}
    </section>
  );
}

// -------------------------------------------------------------------------------- unit

function UnitDashboard({ unitId }: { unitId: string }) {
  const audits = useQuery({
    queryKey: ['analytics', unitId, 'audits'],
    queryFn: () => fetchAll<Audit>(`/audits?unitId=${unitId}&limit=200`),
  });

  /** Audit 1 is the Unit's first completed audit; the picker lists the newest first. */
  const completed = useMemo<NumberedAudit[]>(
    () =>
      (audits.data ?? [])
        .filter((audit) => audit.completedAt !== null)
        .sort((a, b) => a.completedAt!.localeCompare(b.completedAt!))
        .map((audit, index) => ({ audit, number: index + 1 })),
    [audits.data],
  );
  const scored = useMemo(() => completed.filter((row) => row.audit.scored), [completed]);

  const [auditId, setAuditId] = useState('');
  const chosen = completed.find((row) => row.audit.id === auditId) ?? completed[completed.length - 1] ?? null;

  if (audits.isLoading) return <Spinner label="Loading Unit dashboard…" />;
  if (audits.error) return <ErrorNotice error={audits.error} />;

  return (
    <section className="space-y-4" aria-labelledby="unit-heading">
      <div className="gb-head"><h2 id="unit-heading" className="gb-h1">Unit dashboard</h2></div>

      <Card>
        <CardHeader
          title="Completed audits"
          description={chosen ? `Showing ${auditLabel(chosen)}.` : 'No completed audit for this Unit yet.'}
          action={
            <div className="flex items-end gap-3">
              <div className="gb-tile gb-kpi"><span className="gb-label">Completed audits</span><b className="gb-figure">{completed.length}</b></div>
              {completed.length > 0 ? (
                <div className="w-72">
                  <Field label="Audit">
                    <Select value={chosen?.audit.id ?? ''} onChange={(event) => setAuditId(event.target.value)}>
                      {[...completed].reverse().map((row) => (
                        <option key={row.audit.id} value={row.audit.id}>{auditLabel(row)}</option>
                      ))}
                    </Select>
                  </Field>
                </div>
              ) : null}
            </div>
          }
        />
      </Card>

      {chosen ? <AuditPanel key={chosen.audit.id} row={chosen} /> : null}

      <ScoreTrendCard audits={scored} />

      <UnitContext unitId={unitId} />
    </section>
  );
}

/**
 * One audit on its own terms: its score, how many Zones it covered, how many
 * nonconformities it raised, and how many of those are closed — as a count, because
 * "3/5" is what a Coordinator chases, not "60%".
 */
function AuditPanel({ row }: { row: NumberedAudit }) {
  const token = useToken();
  const summary = useQuery({
    queryKey: ['audit', row.audit.id, 'summary'],
    queryFn: () => api.get<AuditScoreSummary>(`/audits/${row.audit.id}/summary`),
  });
  const actions = useQuery({
    queryKey: ['analytics', 'audit', row.audit.id, 'corrective-actions'],
    queryFn: () => fetchAll<CorrectiveAction>(`/corrective-actions?auditId=${row.audit.id}&limit=200`),
  });

  if (summary.isLoading || actions.isLoading) return <Spinner label="Loading the audit…" />;
  const error = summary.error ?? actions.error;
  if (error) return <ErrorNotice error={error} />;
  if (!summary.data) return null;

  const zones = summary.data.zones.filter((zone) => zone.status === 'COMPLETED');
  const raised = actions.data ?? [];
  const closed = raised.filter((action) => action.status === 'VERIFIED').length;

  const zoneRows = zones
    .map((zone) => ({
      zone: zone.zoneCode,
      name: zone.zoneName,
      score: zone.totals.scorePercentage,
      applicable: zone.totals.applicableQuestions,
      na: zone.totals.naQuestions,
    }))
    .sort((a, b) => (a.score ?? 101) - (b.score ?? 101));
  const sectionRows = summary.data.audit.sections.map((section) => ({
    section: SECTION_LABELS[section.section] ?? section.section,
    score: section.pct,
    raw: section.raw,
    max: section.max,
    na: section.na,
  }));

  return (
    <div className="space-y-4">
      <Kpis values={[
        ['Audit score', summary.data.scored ? pct(summary.data.audit.totals.scorePercentage) : 'Walk-by'],
        ['Zones audited', zones.length],
        ['Nonconformities', raised.length],
        ['Closure', `${closed}/${raised.length}`],
      ]} />

      <div className="grid gap-4 lg:grid-cols-2">
        <DatasetCard title={`Zone ranking · audit ${row.number}`} rows={zoneRows} filename="zone-ranking.csv">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={zoneRows} margin={{ bottom: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={token('--edge-soft')} />
              <XAxis dataKey="zone" stroke={token('--ink-3')} interval={0} />
              <YAxis domain={[0, 100]} stroke={token('--ink-3')} />
              <Tooltip contentStyle={TOOLTIP} />
              <Bar dataKey="score" name="Score %">
                {zoneRows.map((zone) => <Cell key={zone.zone} fill={token(BAND_TOKEN[bandOf(zone.score)])} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </DatasetCard>

        <DatasetCard title={`S-wise score · audit ${row.number}`} rows={sectionRows} filename="section-scores.csv">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={sectionRows} margin={{ bottom: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={token('--edge-soft')} />
              <XAxis dataKey="section" stroke={token('--ink-3')} interval={0} />
              <YAxis domain={[0, 100]} stroke={token('--ink-3')} />
              <Tooltip contentStyle={TOOLTIP} />
              <Bar dataKey="score" name="Score %">
                {sectionRows.map((section) => <Cell key={section.section} fill={token(BAND_TOKEN[bandOf(section.score)])} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </DatasetCard>
      </div>
    </div>
  );
}

/** Score against audit number, for whichever audits the reader ticks. */
function ScoreTrendCard({ audits }: { audits: NumberedAudit[] }) {
  const token = useToken();
  const [chosen, setChosen] = useState<string[]>([]);
  const all = chosen.length === 0;
  const selected = all ? audits : audits.filter((row) => chosen.includes(row.audit.id));
  const rows = selected.map((row) => ({
    audit: `Audit ${row.number}`,
    score: row.audit.totals.scorePercentage,
    date: formatDate(row.audit.completedAt),
    auditor: row.audit.auditorName,
  }));
  /** Unticking from "all" starts the selection at everything except the one unticked. */
  const toggle = (id: string) =>
    setChosen((current) => {
      if (current.length === 0) return audits.map((row) => row.audit.id).filter((value) => value !== id);
      return current.includes(id) ? current.filter((value) => value !== id) : [...current, id];
    });

  return (
    <DatasetCard
      title="Score trend · audit-wise"
      rows={rows}
      filename="score-trend.csv"
      tools={
        <details className="gb-tile p-2">
          <summary className="cursor-pointer select-none text-sm">
            {all ? `All ${audits.length} audits` : `${chosen.length} of ${audits.length} audits`}
          </summary>
          <div className="mt-2 max-h-56 space-y-1 overflow-auto">
            {[...audits].reverse().map((row) => (
              <label key={row.audit.id} className="flex items-center gap-2 whitespace-nowrap text-sm">
                <input
                  type="checkbox"
                  checked={all || chosen.includes(row.audit.id)}
                  onChange={() => toggle(row.audit.id)}
                />
                {auditLabel(row)}
              </label>
            ))}
            <Button variant="secondary" className="mt-1" onClick={() => setChosen([])}>Select all</Button>
          </div>
        </details>
      }
    >
      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={rows}>
          <CartesianGrid strokeDasharray="3 3" stroke={token('--edge-soft')} />
          <XAxis dataKey="audit" stroke={token('--ink-3')} />
          <YAxis domain={[0, 100]} stroke={token('--ink-3')} />
          <Tooltip contentStyle={TOOLTIP} />
          <ReferenceLine y={90} stroke={token('--crit-band')} strokeDasharray="4 4" label="Outstanding 90" />
          <Line type="monotone" dataKey="score" name="Score %" stroke={token('--ok-band')} strokeWidth={3} dot={{ r: 4 }} />
        </LineChart>
      </ResponsiveContainer>
    </DatasetCard>
  );
}

/** The Unit's longer view: where it stands against its last cycle, and what keeps failing. */
function UnitContext({ unitId }: { unitId: string }) {
  const token = useToken();
  const sections = useQuery({ queryKey: ['analytics', unitId, 'sections'], queryFn: () => api.get<UnitSections>(`/analytics/units/${unitId}/sections`) });
  const recurrence = useQuery({ queryKey: ['analytics', unitId, 'recurrence'], queryFn: () => api.get<RecurrentNonconformity[]>(`/analytics/units/${unitId}/nonconformities/recurrent`) });
  const closure = useQuery({ queryKey: ['analytics', unitId, 'closure'], queryFn: () => api.get<ClosureAnalytics>(`/analytics/corrective-actions/closure?unitId=${unitId}`) });
  if ([sections, recurrence, closure].some((query) => query.isLoading)) return <Spinner label="Loading Unit context…" />;
  const error = [sections, recurrence, closure].find((query) => query.error)?.error;
  if (error) return <ErrorNotice error={error} />;
  if (!sections.data || !recurrence.data || !closure.data) return null;

  const radarRows = sections.data.radar.map((row) => ({ section: SECTION_LABELS[row.section], current: row.currentScorePercentage, previous: row.previousScorePercentage, samples: row.sampleCount }));
  const funnel = [
    { stage: 'Open', count: closure.data.opened },
    { stage: 'Submitted', count: closure.data.submitted },
    { stage: 'Verified', count: closure.data.resolved },
  ];
  const recurrentRows = recurrence.data.map((row) => ({ zone: `${row.zoneCode} · ${row.zoneName}`, section: SECTION_LABELS[row.section], question: row.questionText, failures: row.failureCount, lastSeen: new Date(row.lastSeenAt).toLocaleDateString() }));

  return (
    <div className="grid gap-4 lg:grid-cols-2">
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

      <DatasetCard title="Corrective-action funnel · all audits" rows={funnel} filename="closure-funnel.csv">
        <ResponsiveContainer width="100%" height={280}>
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

      <DatasetCard title="Recurrent nonconformities" rows={recurrentRows} filename="recurrent-nonconformities.csv" />
    </div>
  );
}

// ---------------------------------------------------------------------------- plumbing

/** A tooltip on the board is a small magnet: tile ground, hard ink edge, no radius. */
const TOOLTIP = {
  background: 'var(--tile)',
  border: '1.5px solid var(--edge)',
  borderRadius: 0,
  color: 'var(--ink)',
  fontSize: 12.5,
} as const;

/** Every page of a list, so a count on this screen is the whole count, not the first 200. */
async function fetchAll<T>(path: string): Promise<T[]> {
  const rows: T[] = [];
  let cursor: string | null = null;
  do {
    const page: Page<T> = await api.get<Page<T>>(cursor ? `${path}&cursor=${encodeURIComponent(cursor)}` : path);
    rows.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor && rows.length < 5000);
  return rows;
}

function auditLabel({ audit, number }: NumberedAudit): string {
  return `Audit ${number} · ${formatDate(audit.completedAt)} · ${audit.auditorName}`;
}

function formatDate(value: string | null): string {
  return value === null ? '—' : new Date(value).toLocaleDateString();
}

function Kpis({ values }: { values: Array<[string, ReactNode]> }) {
  return <div className="gb-kpis">{values.map(([label, value]) => (
    <div key={label} className="gb-tile gb-kpi"><span className="gb-label">{label}</span><b className="gb-figure">{value}</b></div>
  ))}</div>;
}

function DatasetCard({ title, rows, filename, tools, children }: { title: string; rows: Array<Record<string, unknown>>; filename: string; tools?: ReactNode; children?: ReactNode }) {
  const [table, setTable] = useState(!children);
  const headers = useMemo(() => Object.keys(rows[0] ?? {}), [rows]);
  useEffect(() => { if (!children) setTable(true); }, [children]);
  return (
    <Card>
      <CardHeader title={title} action={<div className="flex items-start gap-2">
        {tools}
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
