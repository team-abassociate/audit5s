import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
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
  Unit,
  UnitSections,
  User,
} from '@audit5s/contracts';
import { bandLabel, bandOf } from '@/lib/bands';
import { useToken } from '@/lib/tokens';
import { Button, Card, CardHeader, ErrorNotice, Field, Select, Spinner, Table, Td, Th } from '@/components/ui';
import { BandLabel } from '@/components/Status';
import { api, fetchAll } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useUnitScope } from '@/lib/scope';
import { SECTION_SHORT_LABEL } from '@/lib/labels';
import { cn } from '@/lib/cn';
import { formatDate, formatDayMonth, formatScore } from '@audit5s/domain';
import { Trend } from '@/features/dashboard/DashboardPage';
import { TARGET } from '@/features/dashboard/board';

/** Score-band tokens, resolved from the document so both themes work (§8). */
const BAND_TOKEN = { ok: '--ok-band', warn: '--warn-band', crit: '--crit-band', none: '--edge-soft' } as const;

/** The server's analytics window when no range is sent (`toRange` in the API). */
const WINDOW = 'last 12 months';

/** A count as an Indian reader writes it: 1,284. */
const COUNT = new Intl.NumberFormat('en-IN');

/** Dev only: `?data=worst` swaps every read on this page for the worst-case fixture. */
function worst(): boolean {
  return import.meta.env.DEV && new URLSearchParams(window.location.search).get('data') === 'worst';
}
async function get<T>(path: string): Promise<T> {
  if (worst()) return (await import('./worst-case')).worstCase(path) as T;
  return api.get<T>(path);
}
async function all<T>(path: string): Promise<T[]> {
  if (worst()) return (await import('./worst-case')).worstCase(path) as T[];
  return fetchAll<T>(path);
}

/** An audit and its place in the Unit's own sequence — Audit 1 is the oldest one. */
interface NumberedAudit {
  audit: Audit;
  number: number;
}

export function AnalyticsPage() {
  const { can } = useSession();
  const organizationWide = can('analytics', 'organization_dashboard');
  const fixture = worst();
  const units = useQuery({
    queryKey: ['analytics', 'units', fixture],
    queryFn: () => all<Unit>('/units?limit=200'),
  });
  // The Unit is the portal's scope, chosen in the shell's topbar (lib/scope.ts).
  const scope = useUnitScope();
  const selectedUnit = fixture ? 'worst' : scope.unitId ?? '';

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
          title={scope.unit ? `Unit analytics · ${scope.unit.name}` : 'Unit analytics'}
          description="Change the Unit at the top of the page, then pick the audit. Every figure below is that audit's own, not an average of audits."
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
  const { can } = useSession();
  const canReadUsers = can('user', 'read');
  const fixture = worst();
  const audits = useQuery({
    queryKey: ['analytics', 'organization', 'audits', fixture],
    queryFn: () => all<Audit>('/audits?limit=200'),
  });
  const people = useQuery({
    queryKey: ['analytics', 'organization', 'people', fixture],
    queryFn: () => all<User>('/users?status=ACTIVE&limit=200'),
    enabled: canReadUsers,
  });
  const organization = useQuery({
    queryKey: ['analytics', 'organization', fixture],
    queryFn: () => get<OrganizationOverview>('/analytics/organization/overview'),
  });

  const done = (audits.data ?? []).filter((audit) => audit.completedAt !== null);
  const yearAgo = Date.now() - 365 * 86_400_000;
  const lastYear = done.filter((audit) => Date.parse(audit.completedAt!) >= yearAgo).length;
  const auditors = canReadUsers
    ? (people.data ?? []).filter((person) => person.role === 'CONSULTANT').length
    : organization.data?.activeAuditors ?? null;
  const coordinators = canReadUsers
    ? (people.data ?? []).filter((person) => person.role === 'COORDINATOR').length
    : null;
  const pending = loading || audits.isLoading || (canReadUsers && people.isLoading);

  const ranking = (organization.data?.unitRanking ?? []).map((unit) => ({
    unit: unit.unitName,
    rank: unit.rank ?? 'Not ranked',
    score: unit.score.scorePercentage,
    band: bandLabel(unit.score.scorePercentage),
    scoredAudits: unit.score.sampleCount,
  }));
  const bars = ranking.map((row) => ({ name: row.unit, score: row.score }));

  return (
    <section className="space-y-4" aria-labelledby="organization-heading">
      <div className="gb-head"><h2 id="organization-heading" className="gb-h1">Organization overview</h2></div>
      {pending ? <Spinner label="Counting…" /> : (
        <Kpis values={[
          { label: 'Active units', value: COUNT.format(units.length), context: 'Units you can see' },
          { label: 'Audits conducted', value: COUNT.format(done.length), context: `All time · ${COUNT.format(lastYear)} in the ${WINDOW}` },
          { label: 'Active auditors', value: auditors === null ? '—' : COUNT.format(auditors), context: 'Consultants who can sign in' },
          { label: 'Coordinators', value: coordinators === null ? '—' : COUNT.format(coordinators), context: 'Coordinators who can sign in' },
        ]} />
      )}
      {audits.error ? <ErrorNotice error={audits.error} /> : null}
      {organization.error ? <ErrorNotice error={organization.error} /> : null}
      {ranking.length > 0 ? (
        <DatasetCard
          title="Unit ranking"
          note={`Weighted score over the ${WINDOW}. A Unit needs 3 scored audits in that time to be ranked.`}
          rows={ranking}
          filename="unit-ranking.csv"
          alt={rankingAlt('Unit ranking', bars)}
        >
          <ScoreBars rows={bars} />
        </DatasetCard>
      ) : null}
    </section>
  );
}

// -------------------------------------------------------------------------------- unit

function UnitDashboard({ unitId }: { unitId: string }) {
  const audits = useQuery({
    queryKey: ['analytics', unitId, 'audits'],
    queryFn: () => all<Audit>(`/audits?unitId=${unitId}&limit=200`),
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

  /** `''` is the whole audit. A Zone code only means anything inside the audit that covered it. */
  const [zoneCode, setZoneCode] = useState('');

  /**
   * The chosen audit's Zones, read here so the Zone picker can sit beside the Audit picker
   * rather than halfway down the panel. `AuditPanel` issues the identical query, so this
   * costs one cache read rather than a second request.
   */
  const summary = useQuery({
    queryKey: ['audit', chosen?.audit.id ?? '', 'summary'],
    queryFn: () => get<AuditScoreSummary>(`/audits/${chosen!.audit.id}/summary`),
    enabled: chosen !== null,
  });
  const zones = useMemo(
    () => (summary.data?.zones ?? []).filter((zone) => zone.status === 'COMPLETED'),
    [summary.data],
  );

  if (audits.isLoading) return <Spinner label="Loading Unit dashboard…" />;
  if (audits.error) return <ErrorNotice error={audits.error} />;

  return (
    <section className="space-y-4" aria-labelledby="unit-heading">
      <div className="gb-head"><h2 id="unit-heading" className="gb-h1">Unit dashboard</h2></div>

      <Card>
        <CardHeader
          title={`Completed audits · ${COUNT.format(completed.length)}`}
          description={chosen ? `Showing ${auditLabel(chosen)}.` : 'No completed audit for this Unit yet.'}
        />
        {completed.length > 0 ? (
          // Fluid, wrapping pickers: fixed widths pushed the Zone picker off a phone (AN5).
          <div className="flex flex-wrap items-end gap-3 p-3.5">
            <div className="min-w-0 flex-[2_1_18rem]">
              <Field label="Audit">
                <Select
                  value={chosen?.audit.id ?? ''}
                  onChange={(event) => {
                    setAuditId(event.target.value);
                    // The code is only meaningful within the audit that showed it.
                    setZoneCode('');
                  }}
                >
                  {[...completed].reverse().map((row) => (
                    <option key={row.audit.id} value={row.audit.id}>{auditLabel(row)}</option>
                  ))}
                </Select>
              </Field>
            </div>
            {chosen && zones.length > 0 ? (
              <div className="min-w-0 flex-[1_1_14rem]">
                <Field label="Zone">
                  <Select value={zoneCode} onChange={(event) => setZoneCode(event.target.value)}>
                    <option value="">{`Whole audit · ${zones.length} zones`}</option>
                    {zones.map((zone) => (
                      <option key={zone.zoneCode} value={zone.zoneCode}>
                        {`${zone.zoneName} (${zone.zoneCode})`}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            ) : null}
          </div>
        ) : null}
      </Card>

      {chosen ? <AuditPanel key={chosen.audit.id} row={chosen} zoneCode={zoneCode} /> : null}

      <ScoreTrendCard audits={scored} />

      <UnitContext unitId={unitId} />
    </section>
  );
}

/**
 * One audit on its own terms: its score, how many Zones it covered, how many
 * nonconformities it raised, and how many of those are closed — as a count, because
 * "3/5" is what a Coordinator chases, not "60%".
 *
 * With `zoneCode` set, the same panel narrows to that one Zone of the same audit: its own
 * score, its own breakdown by S, and only the findings raised in it. Every figure is
 * still the server's — narrowing only picks a different number the server already sent.
 */
function AuditPanel({ row, zoneCode }: { row: NumberedAudit; zoneCode: string }) {
  const summary = useQuery({
    queryKey: ['audit', row.audit.id, 'summary'],
    queryFn: () => get<AuditScoreSummary>(`/audits/${row.audit.id}/summary`),
  });
  const actions = useQuery({
    queryKey: ['analytics', 'audit', row.audit.id, 'corrective-actions'],
    queryFn: () => all<CorrectiveAction>(`/corrective-actions?auditId=${row.audit.id}&limit=200`),
  });

  if (summary.isLoading || actions.isLoading) return <Spinner label="Loading the audit…" />;
  const error = summary.error ?? actions.error;
  if (error) return <ErrorNotice error={error} />;
  if (!summary.data) return null;

  const zones = summary.data.zones.filter((zone) => zone.status === 'COMPLETED');
  /** The chosen Zone, or `null` for the whole audit. An unknown code reads as the whole audit. */
  const zone = zones.find((candidate) => candidate.zoneCode === zoneCode) ?? null;

  const allRaised = actions.data ?? [];
  const raised = zone ? allRaised.filter((action) => action.zoneCode === zone.zoneCode) : allRaised;
  const closed = raised.filter((action) => action.status === 'VERIFIED').length;

  /** The ranking is the audit's whole point of comparison, so it is never narrowed — the
      chosen Zone is highlighted within it instead, which is what makes it a ranking. */
  const zoneRows = zones
    .map((candidate) => ({
      zone: candidate.zoneName,
      code: candidate.zoneCode,
      score: candidate.totals.scorePercentage,
      band: bandLabel(candidate.totals.scorePercentage),
      questionsScored: candidate.totals.applicableQuestions,
      notApplicable: candidate.totals.naQuestions,
    }))
    .sort((a, b) => (a.score ?? 101) - (b.score ?? 101));
  const zoneBars = zoneRows.map((candidate) => ({
    name: candidate.zone,
    score: candidate.score,
    highlighted: candidate.code === zone?.zoneCode,
  }));
  const sectionRows = (zone ?? summary.data.audit).sections.map((section) => ({
    section: SECTION_SHORT_LABEL[section.section] ?? section.section,
    score: section.pct,
    band: bandLabel(section.pct),
    points: section.raw,
    outOf: section.max,
    notApplicable: section.na,
  }));

  const scope = zone ? `${zone.zoneName} · audit ${row.number}` : `audit ${row.number}`;
  const total = (zone ?? summary.data.audit).totals.scorePercentage;

  return (
    <div className="space-y-4">
      <Kpis values={[
        summary.data.scored
          ? { label: zone ? 'Zone score' : 'Audit score', value: pct(total), score: total }
          : { label: 'Audit score', value: 'Walk-by', context: 'A walk-by is not scored' },
        zone
          ? { label: 'Questions scored', value: COUNT.format(zone.totals.applicableQuestions) }
          : { label: 'Zones audited', value: COUNT.format(zones.length) },
        { label: 'Nonconformities', value: COUNT.format(raised.length) },
        { label: 'Closed', value: `${COUNT.format(closed)}/${COUNT.format(raised.length)}`, context: 'Corrective actions closed' },
      ]} />

      <div className="grid gap-4 xl:grid-cols-2">
        <DatasetCard
          title={`Zones, lowest score first · audit ${row.number}`}
          rows={zoneRows}
          filename="zone-ranking.csv"
          alt={rankingAlt(`Zone scores in audit ${row.number}`, zoneBars)}
        >
          <ScoreBars rows={zoneBars} />
        </DatasetCard>

        <DatasetCard title={`Score by S · ${scope}`} rows={sectionRows} filename="section-scores.csv">
          {/* The board's section breakdown (§6 detail panel): an all-N/A section reads N/A
              on the hatch, never as an empty or zero bar. Plain HTML, so it needs no alt. */}
          <div className="gb-sections">
            {sectionRows.map((section) => (
              <div key={section.section} className={`gb-srow gb-${bandOf(section.score)}`}>
                <u>{section.section}</u>
                <div className={cn('gb-track', section.score === null && 'gb-na')}>
                  {section.score !== null ? <i style={{ width: `${section.score}%` }} /> : null}
                </div>
                <b>{pct(section.score, '')}</b>
              </div>
            ))}
          </div>
        </DatasetCard>
      </div>
    </div>
  );
}

/** The board's trend chart (GEMBA §6), for whichever of the Unit's audits the reader ticks. */
function ScoreTrendCard({ audits }: { audits: NumberedAudit[] }) {
  const [chosen, setChosen] = useState<string[]>([]);
  const everything = chosen.length === 0;
  const selected = everything ? audits : audits.filter((row) => chosen.includes(row.audit.id));
  const rows = selected.map((row) => ({
    audit: row.number,
    date: formatDate(row.audit.completedAt),
    score: row.audit.totals.scorePercentage,
    band: bandLabel(row.audit.totals.scorePercentage),
    auditor: row.audit.auditorName,
  }));
  const points = selected.map((row) => ({
    period: formatDayMonth(row.audit.completedAt),
    scorePercentage: row.audit.totals.scorePercentage,
  }));
  /** Unticking from "all" starts the selection at everything except the one unticked. */
  const toggle = (id: string) =>
    setChosen((current) => {
      if (current.length === 0) return audits.map((row) => row.audit.id).filter((value) => value !== id);
      return current.includes(id) ? current.filter((value) => value !== id) : [...current, id];
    });

  return (
    <DatasetCard
      title="Score trend · one point per audit"
      rows={rows}
      filename="score-trend.csv"
      tools={
        <details className="gb-tile p-2">
          <summary className="cursor-pointer select-none text-sm">
            {everything ? `All ${audits.length} audits` : `${chosen.length} of ${audits.length} audits`}
          </summary>
          <div className="mt-2 max-h-56 space-y-1 overflow-auto">
            {[...audits].reverse().map((row) => (
              <label key={row.audit.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={everything || chosen.includes(row.audit.id)}
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
      {points.some((point) => point.scorePercentage !== null) ? <Trend points={points} /> : null}
    </DatasetCard>
  );
}

/** The Unit's longer view: where it stands against its last audit, and how findings close. */
function UnitContext({ unitId }: { unitId: string }) {
  const token = useToken();
  const sections = useQuery({ queryKey: ['analytics', unitId, 'sections'], queryFn: () => get<UnitSections>(`/analytics/units/${unitId}/sections`) });
  const closure = useQuery({ queryKey: ['analytics', unitId, 'closure'], queryFn: () => get<ClosureAnalytics>(`/analytics/corrective-actions/closure?unitId=${unitId}`) });
  if ([sections, closure].some((query) => query.isLoading)) return <Spinner label="Loading Unit context…" />;
  const error = [sections, closure].find((query) => query.error)?.error;
  if (error) return <ErrorNotice error={error} />;
  if (!sections.data || !closure.data) return null;

  const pairs = sections.data.radar.map((row) => ({
    section: SECTION_SHORT_LABEL[row.section],
    latest: row.currentScorePercentage,
    previous: row.previousScorePercentage,
    zoneReadings: row.sampleCount,
  }));
  // A Unit audited once has nothing to compare against, so the second bar is not drawn and
  // the legend does not name an audit that never happened.
  const hasPrevious = pairs.some((row) => row.previous !== null);
  const stages = [
    { stage: 'Raised', count: closure.data.opened },
    { stage: 'Fix submitted', count: closure.data.submitted },
    // R-43: resolved is closed — a Zone Leader's closure counts whether or not anyone approved it.
    { stage: 'Closed', count: closure.data.resolved },
  ];
  const height = (bars: number) => bars * 30 + 40;

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <DatasetCard
        title={hasPrevious ? 'Score by S · latest vs previous audit' : 'Score by S · latest audit'}
        rows={hasPrevious ? pairs : pairs.map(({ section, latest, zoneReadings }) => ({ section, latest, zoneReadings }))}
        filename="section-scores-latest-previous.csv"
        alt={`Score by S, latest audit${hasPrevious ? ' against the previous one' : ''}: ${pairs
          .map((row) => `${row.section} ${pct(row.latest, '')}${hasPrevious ? ` (previous ${pct(row.previous, '')})` : ''}`)
          .join(', ')}.`}
      >
        {/* Paired bars, not a radar (AN4): both series in ink — a score series is not a band,
            so it takes no band colour — told apart by weight and by the legend. */}
        <div className="gb-legend">
          <span><i style={{ background: 'var(--ink)' }} /> Latest audit</span>
          {hasPrevious ? <span><i style={{ background: 'var(--ink-3)' }} /> Previous audit</span> : null}
        </div>
        <ResponsiveContainer width="100%" height={height(pairs.length * (hasPrevious ? 2 : 1))}>
          <BarChart data={pairs} layout="vertical" accessibilityLayer={false} margin={{ top: 18, right: 4, left: 4, bottom: 0 }}>
            <CartesianGrid horizontal={false} stroke={token('--edge-soft')} />
            <XAxis type="number" domain={[0, 100]} ticks={[0, 20, 40, 60, 80, 100]} stroke={token('--ink-3')} />
            <YAxis dataKey="section" type="category" width={110} interval={0} stroke={token('--ink-3')} />
            <Tooltip contentStyle={TOOLTIP} formatter={(value) => pct(asScore(value), '')} />
            <ReferenceLine x={TARGET} stroke={token('--crit-band')} strokeDasharray="4 4" label={targetLabel(token)} />
            {valueAxis(token, 84, (index) => {
              const row = pairs[index];
              return row ? (hasPrevious ? `${pct(row.latest, '')} · ${pct(row.previous, '')}` : pct(row.latest, '')) : '';
            })}
            <Bar isAnimationActive={false} dataKey="latest" name="Latest audit" fill={token('--ink')} barSize={12} />
            {hasPrevious ? <Bar isAnimationActive={false} dataKey="previous" name="Previous audit" fill={token('--ink-3')} barSize={12} /> : null}
          </BarChart>
        </ResponsiveContainer>
      </DatasetCard>

      <DatasetCard
        title="Corrective actions by stage"
        note={`Raised in the ${WINDOW}, across every audit of this Unit — so it can differ from the board, which counts its own period.`}
        rows={stages}
        filename="corrective-actions-by-stage.csv"
        alt={`Corrective actions by stage: ${stages.map((row) => `${row.stage} ${COUNT.format(row.count)}`).join(', ')}.`}
      >
        <ResponsiveContainer width="100%" height={height(stages.length)}>
          <BarChart data={stages} layout="vertical" accessibilityLayer={false} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
            <CartesianGrid horizontal={false} stroke={token('--edge-soft')} />
            <XAxis type="number" allowDecimals={false} stroke={token('--ink-3')} />
            <YAxis dataKey="stage" type="category" width={110} interval={0} stroke={token('--ink-3')} />
            <Tooltip contentStyle={TOOLTIP} />
            {valueAxis(token, 56, (index) => COUNT.format(stages[index]?.count ?? 0))}
            <Bar isAnimationActive={false} dataKey="count" name="Corrective actions" fill={token('--ink-3')} barSize={16} />
          </BarChart>
        </ResponsiveContainer>
      </DatasetCard>
    </div>
  );
}

// ---------------------------------------------------------------------------- plumbing

/**
 * Scores as horizontal bars, one per row, in the order given: the band colour (what the
 * colour means), the value in the right-hand column, the dashed Outstanding line, and the full name
 * on the axis — clipped there, whole in the tooltip and the table.
 */
function ScoreBars({ rows }: { rows: Array<{ name: string; score: number | null; highlighted?: boolean }> }) {
  const token = useToken();
  return (
    <ResponsiveContainer width="100%" height={rows.length * 30 + 56}>
      <BarChart data={rows} layout="vertical" accessibilityLayer={false} margin={{ top: 18, right: 4, left: 4, bottom: 0 }}>
        <CartesianGrid horizontal={false} stroke={token('--edge-soft')} />
        <XAxis type="number" domain={[0, 100]} ticks={[0, 20, 40, 60, 80, 100]} stroke={token('--ink-3')} />
        <YAxis dataKey="name" type="category" width={150} interval={0} tickFormatter={clip} stroke={token('--ink-3')} />
        {valueAxis(token, 48, (index) => pct(rows[index]?.score ?? null, ''))}
        <Tooltip contentStyle={TOOLTIP} formatter={(value) => [pct(asScore(value)), 'Score']} />
        <ReferenceLine x={TARGET} stroke={token('--crit-band')} strokeDasharray="4 4" label={targetLabel(token)} />
        <Bar isAnimationActive={false} dataKey="score" name="Score" barSize={16}>
          {/* A highlighted row keeps its band colour — the band is what the colour means —
              and is marked by an ink outline instead, so it reads without colour. */}
          {rows.map((row, index) => (
            <Cell
              key={index}
              fill={token(BAND_TOKEN[bandOf(row.score)])}
              stroke={row.highlighted ? token('--ink') : undefined}
              strokeWidth={row.highlighted ? 2 : 0}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/**
 * Each bar's value, in a column at the right edge (the board's label | track | value row).
 * A label at the bar's end vanishes for 0 and for N/A; an axis tick never does.
 */
function valueAxis(token: (name: string) => string, width: number, value: (index: number) => string) {
  return (
    <YAxis
      yAxisId="value"
      orientation="right"
      type="category"
      width={width}
      interval={0}
      axisLine={false}
      tickLine={false}
      tick={{ fill: token('--ink'), fontSize: 11.5 }}
      tickFormatter={(_, index) => value(index)}
    />
  );
}

/** The target's label sits above the plot, so its own dashed line never strikes it through. */
function targetLabel(token: (name: string) => string) {
  return { value: `OUTSTANDING ${TARGET}`, position: 'top' as const, fill: token('--ink-2'), fontSize: 10.5 };
}

/** One sentence a screen reader can use in place of a ranking chart (AN3). */
function rankingAlt(what: string, rows: Array<{ name: string; score: number | null }>): string {
  const scored = rows
    .filter((row): row is { name: string; score: number } => row.score !== null)
    .sort((a, b) => b.score - a.score);
  const top = scored[0];
  const low = scored.at(-1);
  if (!top || !low) return `${what}: no scores yet.`;
  const clear = scored.filter((row) => row.score >= TARGET).length;
  return `${what}, ${rows.length} bars. Highest ${top.name} at ${pct(top.score, '')}, lowest ${low.name} at ${pct(low.score, '')}. ${clear} of ${scored.length} at or above the Outstanding line of ${TARGET}.`;
}

/** A tooltip on the board is a small magnet: tile ground, hard ink edge, no radius. */
const TOOLTIP = {
  background: 'var(--tile)',
  border: '1.5px solid var(--edge)',
  borderRadius: 0,
  color: 'var(--ink)',
  fontSize: 12.5,
} as const;

function auditLabel({ audit, number }: NumberedAudit): string {
  return `Audit ${number} · ${formatDate(audit.completedAt)} · ${audit.auditorName}`;
}

interface Kpi {
  label: string;
  value: ReactNode;
  context?: ReactNode;
  /** A score figure: coloured by its band, with the band word and strip beneath (AN6). */
  score?: number | null;
}

function Kpis({ values }: { values: Kpi[] }) {
  return <div className="gb-kpis">{values.map(({ label, value, context, score }) => {
    const band = score === undefined ? null : bandOf(score);
    return (
      <div key={label} className={cn('gb-tile gb-kpi', band && `gb-${band}`)}>
        <span className="gb-label">{label}</span>
        <b className="gb-figure">{value}</b>
        {score !== undefined ? <BandLabel score={score} /> : context ? <small>{context}</small> : null}
        {band ? <div className={`gb-band gb-band--${band}`} /> : null}
      </div>
    );
  })}</div>;
}

function DatasetCard({ title, note, rows, filename, alt, tools, children }: {
  title: string;
  /** What the figures cover, when it isn't obvious (AN4). */
  note?: string;
  rows: Array<Record<string, unknown>>;
  filename: string;
  /** The chart's key values in words. Recharts SVGs carry no name of their own (AN3). */
  alt?: string;
  tools?: ReactNode;
  children?: ReactNode;
}) {
  const [table, setTable] = useState(!children);
  const headers = useMemo(() => Object.keys(rows[0] ?? {}), [rows]);
  useEffect(() => { if (!children) setTable(true); }, [children]);
  return (
    <Card>
      <CardHeader title={title} description={note} action={<div className="flex flex-wrap items-start justify-end gap-2">
        {tools}
        {children ? <Button variant="secondary" onClick={() => setTable((value) => !value)}>{table ? 'Show chart' : 'Show table'}</Button> : null}
        <Button variant="secondary" disabled={rows.length === 0} onClick={() => downloadCsv(filename, rows)}>Export CSV</Button>
      </div>} />
      {table ? <Table><thead><tr>{headers.map((header) => <Th key={header}>{label(header)}</Th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{headers.map((header) => <Td key={header}>{display(row[header])}</Td>)}</tr>)}</tbody></Table>
        : <div className="p-3" role={alt ? 'img' : undefined} aria-label={alt}>{children}</div>}
      {rows.length === 0 ? <p className="p-4 text-sm text-ink-3">No data in this period.</p> : null}
    </Card>
  );
}

/** One decimal in tiles and charts (GEMBA §3); `null` is N/A, never 0. */
function pct(value: number | null, unit = '%'): string { return value === null ? 'N/A' : `${formatScore(value)}${unit}`; }
function asScore(value: unknown): number | null { return typeof value === 'number' ? value : null; }
function clip(name: string): string { return name.length > 22 ? `${name.slice(0, 21)}…` : name; }
function display(value: unknown): string { return value === null || value === undefined ? '—' : typeof value === 'number' ? Number.isInteger(value) ? String(value) : value.toFixed(2) : String(value); }
function label(value: string): string { return value.replace(/([a-z])([A-Z])/g, (_, a: string, b: string) => `${a} ${b.toLowerCase()}`).replace(/^./, (char) => char.toUpperCase()); }

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
