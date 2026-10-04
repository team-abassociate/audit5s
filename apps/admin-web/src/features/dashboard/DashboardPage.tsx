import { useMemo, useRef, useState, type Ref } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import type {
  Audit,
  AuditScoreSummary,
  CorrectiveAction,
  Page,
  SectionScorePayload,
  Unit,
  UnitOverview,
  Zone,
  ZoneRankingItem,
} from '@audit5s/contracts';
import { S_SECTIONS } from '@audit5s/contracts';
import { Link } from '@tanstack/react-router';
import { TopbarTools } from '@/components/AppShell';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { BandLabel } from '@/components/Status';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useUnitScope } from '@/lib/scope';
import { AUDIT_STATUS_LABEL, AUDIT_TYPE_LABEL, SECTION_SHORT_LABEL } from '@/lib/labels';
import { daysBetween, formatDate, formatDateTime, formatDayMonth, formatTime } from '@audit5s/domain';
import {
  TARGET,
  awaitingRollup,
  bandLabel,
  bandOf,
  count,
  delta1,
  groupFindings,
  mergeBoard,
  score1,
  score2,
  trendGeometry,
  worstIndex,
  type Band,
  type BoardZone,
  type LatestZoneAudit,
} from './board';

/** Dev only: `?data=worst` swaps every read on this page for the worst-case fixture. */
function worst(): boolean {
  return import.meta.env.DEV && new URLSearchParams(window.location.search).get('data') === 'worst';
}

/** The board's one door to the server, so the fixture swaps in at the data boundary. */
async function get<T>(path: string): Promise<T> {
  if (worst()) return (await import('./worst-case')).worstCase(path) as T;
  return api.get<T>(path);
}

/** Below this the detail panel sits under the tiles, out of sight (GEMBA §5). */
const STACKED = '(max-width: 1180px)';

/** The rollup's clock: "Synced 2:05 PM", in IST like every time in the portal (R-45(b)). */
function lastSync(at: number | undefined): string {
  return at ? formatTime(at) : '—';
}

const PERIODS = [
  { months: 3, label: 'Last 3 months' },
  { months: 6, label: 'Last 6 months' },
  { months: 12, label: 'Last 12 months' },
] as const;

/** The matrix key: a score from each band, and the range it stands for (R-6b). */
const BAND_KEY: Array<[number | null, string]> = [
  [90, '≥ 90'],
  [75, '75–89.9'],
  [60, '60–74.9'],
  [0, 'under 60'],
  [null, 'all not applicable'],
];

/** The number of recent audits the section breakdown and the matrix are read from. */
const RECENT = 5;
/** Rows of the board's corrective-action register; the full list is a link away (B9). */
const SHOWN = 12;
const DAY = 86_400_000;

/**
 * The Zone board (GEMBA-BOARD.md §1): every Zone in the Unit, its score, and the one thing
 * someone must act on.
 *
 * Every figure on it is the server's — the client filters and lays out, it never scores
 * (§3, ARCHITECTURE.md §8.6), and a Zone with nothing applicable reads `N/A` on a hatch
 * rather than `0` (D4).
 */
export function DashboardPage() {
  const { can } = useSession();
  // The Unit is the portal's scope, chosen in the shell's topbar (lib/scope.ts).
  const { unitId } = useUnitScope();
  const [months, setMonths] = useState<number>(12);
  /**
   * What the Unit score tile reports: the period's weighted score, or one audit's own.
   *
   * The weighted figure answers "how is this Unit doing" — `Σraw / Σmax` across the period,
   * never a mean of percentages (R-15a) — and a single audit answers "how did that one go".
   * Both are the server's; picking between them is the one thing this control does.
   */
  const [scoreAuditId, setScoreAuditId] = useState('');
  /**
   * Which Zone of the chosen audit the score tile reports, `''` meaning the audit as a
   * whole. Only ever set while an audit is chosen — "Zone A of the weighted period" is not
   * a figure the server computes and not one this page may invent, so picking an audit is
   * what makes the Zone control appear at all.
   */
  const [scoreZoneCode, setScoreZoneCode] = useState('');

  const units = useQuery({
    queryKey: worst() ? ['units', 'worst'] : ['units'],
    queryFn: () => get<Page<Unit>>('/units?limit=200'),
  });
  const unit = (worst() ? units.data?.data[0]?.id : unitId) ?? '';
  const unitName = units.data?.data.find((candidate) => candidate.id === unit);
  const from = useMemo(() => {
    const start = new Date();
    start.setMonth(start.getMonth() - months, 1);
    start.setHours(0, 0, 0, 0);
    return start.toISOString();
  }, [months]);
  const range = `from=${encodeURIComponent(from)}&minSamples=1`;
  const enabled = unit !== '';

  const overview = useQuery({
    queryKey: ['dashboard', unit, from, 'overview'],
    queryFn: () => get<UnitOverview>(`/analytics/units/${unit}/overview?${range}`),
    enabled,
  });
  const ranking = useQuery({
    queryKey: ['dashboard', unit, from, 'ranking'],
    queryFn: () =>
      get<ZoneRankingItem[]>(
        `/analytics/units/${unit}/zones/ranking?order=worst&limit=200&${range}`,
      ),
    enabled,
  });
  const zones = useQuery({
    queryKey: ['dashboard', unit, 'zones'],
    queryFn: () => get<Page<Zone>>(`/units/${unit}/zones?limit=200`),
    enabled,
  });
  const audits = useQuery({
    queryKey: ['dashboard', unit, from, 'audits'],
    queryFn: () =>
      get<Page<Audit>>(`/audits?unitId=${unit}&from=${encodeURIComponent(from)}&limit=200`),
    enabled,
  });
  const actions = useQuery({
    queryKey: ['dashboard', unit, 'corrective-actions'],
    queryFn: () => get<Page<CorrectiveAction>>(`/corrective-actions?unitId=${unit}&limit=200`),
    enabled,
  });

  /** The five most recent completed, scored audits — a walk-by has no score to show (§2.7). */
  const recent = useMemo(
    () =>
      (audits.data?.data ?? [])
        .filter((audit) => audit.scored && audit.completedAt !== null)
        .sort((a, b) => b.completedAt!.localeCompare(a.completedAt!))
        .slice(0, RECENT),
    [audits.data],
  );
  const summaries = useQueries({
    queries: recent.map((audit) => ({
      queryKey: ['audit', audit.id, 'summary'],
      queryFn: () => get<AuditScoreSummary>(`/audits/${audit.id}/summary`),
    })),
  });

  /** Newest breakdown wins: the board shows each Zone's latest completed audit. */
  const latest = useMemo(() => {
    const map = new Map<string, LatestZoneAudit>();
    recent.forEach((audit, index) => {
      for (const zone of summaries[index]?.data?.zones ?? []) {
        if (zone.status !== 'COMPLETED' || map.has(zone.zoneCode)) continue;
        map.set(zone.zoneCode, {
          sections: zone.sections,
          auditorName: audit.auditorName,
          completedAt: audit.completedAt,
        });
      }
    });
    return map;
  }, [recent, summaries]);

  const board = useMemo(
    () => mergeBoard(zones.data?.data ?? [], ranking.data ?? [], latest),
    [zones.data, ranking.data, latest],
  );
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const selected = board.find((zone) => zone.code === selectedCode) ?? board[worstIndex(board)];
  const panelHeading = useRef<HTMLHeadingElement>(null);
  /**
   * Below 1180px the panel is under every tile, so choosing one changed something a screen
   * or more away (B4). Focus moves to the panel's heading, which brings it into view and
   * tells a screen reader what changed.
   */
  const selectZone = (code: string) => {
    setSelectedCode(code);
    if (window.matchMedia(STACKED).matches) requestAnimationFrame(() => panelHeading.current?.focus());
  };

  const now = Date.now();
  const raised = actions.data?.data ?? [];
  /**
   * Closed means `VERIFIED`. An accepted `NOT_POSSIBLE` also ends at `VERIFIED` (§7.3), so
   * this one test covers both ways a finding can be finished, and `ACTION_SUBMITTED` is
   * correctly not counted — it is waiting on a reviewer, not closed.
   */
  const closed = raised.filter((action) => action.status === 'VERIFIED');
  const open = raised.filter(
    (action) => action.status === 'OPEN' || action.status === 'REOPENED',
  );
  const overdue = open.filter(
    (action) => action.dueAt !== null && Date.parse(action.dueAt) < now,
  );
  const dueThisWeek = open.filter(
    (action) =>
      action.dueAt !== null &&
      Date.parse(action.dueAt) >= now &&
      Date.parse(action.dueAt) < now + 7 * DAY,
  );
  const zeroScored = open.filter((action) => action.scoreAtCapture === 'SCORE_0');
  const oldestOverdue = overdue
    .slice()
    .sort((a, b) => a.dueAt!.localeCompare(b.dueAt!))
    .at(0);
  const closureHours = overview.data?.averageClosureHours ?? null;
  /** Completed audits the nightly rollup has not folded into the analytics yet. */
  const lagging = board.filter((zone) => awaitingRollup(zone)).length;
  const notStarted = board.filter((zone) => zone.score === null);
  const audited = board.length - notStarted.length;

  /** Every completed, scored audit of this Unit in the period, newest first. */
  const scorable = useMemo(
    () =>
      (audits.data?.data ?? [])
        .filter((audit) => audit.scored && audit.completedAt !== null)
        .sort((a, b) => b.completedAt!.localeCompare(a.completedAt!)),
    [audits.data],
  );
  /**
   * The trajectory: one point per audit, oldest first, over the last twelve months.
   *
   * It used to plot `/analytics/units/{id}/trend?granularity=month`, which is the Unit's
   * weighted composite per calendar month — `Σraw / Σmax` across whatever audits fell in
   * it. That answers "how did the Unit do in August", and it is the wrong question for a
   * line titled Unit trajectory: two audits in one month collapsed into a single point, a
   * month with none broke the line, and no point on the chart matched any score anyone
   * could look up on an audit.
   *
   * These are the audits' own totals, exactly as the score tile above reports them, so the
   * chart and the tile can no longer disagree. Still the server's figures — this picks and
   * orders them, it does not compute them (§3).
   */
  const trajectory = useMemo(() => {
    const cutoff = Date.now() - 365 * DAY;
    return scorable
      .filter((audit) => Date.parse(audit.completedAt!) >= cutoff)
      .slice()
      .reverse()
      .map((audit) => ({
        period: formatDayMonth(audit.completedAt),
        detail: formatTime(audit.completedAt),
        scorePercentage: audit.totals.scorePercentage,
      }));
  }, [scorable]);

  const chosenAudit = scorable.find((audit) => audit.id === scoreAuditId) ?? null;

  /**
   * The chosen audit's per-Zone breakdown.
   *
   * `summaries` above only covers the last five audits, and the Score control lists every
   * scored audit in the period, so a sixth-newest pick would otherwise have no zones to
   * offer. Same query key as `summaries` uses, so choosing one of the recent five is served
   * from cache rather than refetched.
   */
  const chosenSummary = useQuery({
    queryKey: ['audit', scoreAuditId, 'summary'],
    queryFn: () => get<AuditScoreSummary>(`/audits/${scoreAuditId}/summary`),
    enabled: chosenAudit !== null,
  });

  /** Only the Zones this audit actually covered, and only those it finished scoring. */
  const scorableZones = useMemo(
    () => (chosenSummary.data?.zones ?? []).filter((zone) => zone.status === 'COMPLETED'),
    [chosenSummary.data],
  );
  const chosenZone = scorableZones.find((zone) => zone.zoneCode === scoreZoneCode) ?? null;

  // Every figure here is the server's, recomputed on completion — never one this page works
  // out, which is the rule the whole board follows (§3). Narrowing from period → audit →
  // Zone only ever picks a different server-supplied number.
  const unitScore = chosenZone
    ? chosenZone.totals.scorePercentage
    : chosenAudit
      ? chosenAudit.totals.scorePercentage
      : (overview.data?.score.scorePercentage ?? null);

  const error = [units, overview, ranking, zones, audits, actions].find((query) => query.error)
    ?.error;
  /** Nothing renders as data until it is data: "0/0 zones" for a second is a false report (B8). */
  const loading =
    units.isLoading || [overview, ranking, zones, audits, actions].some((query) => query.isLoading);
  const latestAudit = scorable[0] ?? null;
  /** The slip names whoever can be chased: the action's leader, else its Zone's typed leader. */
  const overdueOwner = oldestOverdue
    ? (oldestOverdue.assignedZoneLeaderName ??
      board.find((zone) => zone.code === oldestOverdue.zoneCode)?.leader ??
      null)
    : null;

  return (
    <>
      <TopbarTools>
        <div className="gb-sel">
          <label className="gb-label" htmlFor="gb-period">
            Period
          </label>
          <select
            id="gb-period"
            value={months}
            onChange={(event) => setMonths(Number(event.target.value))}
          >
            {PERIODS.map((period) => (
              <option key={period.months} value={period.months}>
                {period.label}
              </option>
            ))}
          </select>
        </div>
        <div className="gb-sel">
          <label className="gb-label" htmlFor="gb-score">
            Score
          </label>
          <select
            id="gb-score"
            value={scoreAuditId}
            onChange={(event) => {
              setScoreAuditId(event.target.value);
              // A Zone code is only meaningful within the audit that was showing it. Left
              // set, picking a second audit would either read a same-coded Zone it never
              // covered or silently fall back to the audit total.
              setScoreZoneCode('');
            }}
          >
            <option value="">Weighted, all audits</option>
            {scorable.map((audit, index) => (
              <option key={audit.id} value={audit.id}>
                {`Audit ${scorable.length - index} · ${formatDate(audit.completedAt)} · ${audit.auditorName}`}
              </option>
            ))}
          </select>
        </div>

        {/* Only the Zones that audit covered, and only once an audit is chosen. */}
        {chosenAudit ? (
          <div className="gb-sel">
            <label className="gb-label" htmlFor="gb-score-zone">
              Zone
            </label>
            <select
              id="gb-score-zone"
              value={scoreZoneCode}
              onChange={(event) => setScoreZoneCode(event.target.value)}
              disabled={chosenSummary.isLoading || scorableZones.length === 0}
            >
              <option value="">
                {chosenSummary.isLoading
                  ? 'Loading zones…'
                  : scorableZones.length === 0
                    ? 'No scored zones'
                    : `Whole audit · ${scorableZones.length} ${scorableZones.length === 1 ? 'zone' : 'zones'}`}
              </option>
              {scorableZones.map((zone) => (
                <option key={zone.zoneCode} value={zone.zoneCode}>
                  {`${zone.zoneName} (${zone.zoneCode})`}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="gb-pill" title="When this board last loaded from the server">
          <i />
          <span className="gb-pill-label">Synced</span> <span className="gb-data">{lastSync(overview.dataUpdatedAt)}</span>
        </div>
        {can('report', 'read_snapshot') ? (
          <Link className="gb-btn" to="/reports">
            Reports &amp; unit summary
          </Link>
        ) : null}
        {can('audit_assignment', 'create') ? (
          <Link className="gb-btn gb-btn--primary" to="/audits">
            New audit
          </Link>
        ) : null}
      </TopbarTools>

      {error ? (
        <div className="gb-tile">
          <span className="gb-label">Request refused</span>
          <p style={{ margin: '6px 0 0', fontSize: 13 }}>{(error as Error).message}</p>
        </div>
      ) : null}

      {!units.isLoading && unit === '' && !error ? (
        <EmptyState
          title="No Unit to show."
          action={
            <Link className="gb-btn" to="/units">
              Units &amp; zones
            </Link>
          }
        >
          The board reads one Unit. Add a Unit, or ask a Super Admin for access to one.
        </EmptyState>
      ) : null}

      {/* The one slip: only ever rendered for something a human must act on (§2.7). */}
      {loading ? null : overdue.length > 0 ? (
        <div className="gb-slip">
          <b>
            {count(overdue.length)} corrective {overdue.length === 1 ? 'action' : 'actions'} overdue
          </b>
          <p>
            Oldest is “{findingTitle(oldestOverdue!)}” in {oldestOverdue!.zoneName}, due{' '}
            {formatDate(oldestOverdue!.dueAt)}.{' '}
            {overdueOwner ? `Chase ${overdueOwner}, the Zone's leader.` : 'Its Zone has no leader named.'}
          </p>
          <div className="gb-slip-actions">
            <Link
              className="gb-btn gb-btn--sm"
              to="/corrective-actions"
              search={{ action: oldestOverdue!.id }}
            >
              Open the action
            </Link>
            <Link className="gb-btn gb-btn--sm" to="/corrective-actions" search={{ overdue: true }}>
              All overdue actions
            </Link>
          </div>
        </div>
      ) : notStarted.length > 0 && audited > 0 ? (
        <div className="gb-slip">
          <b>
            {notStarted.length} of {board.length} zones not audited in this period
          </b>
          <p>
            {notStarted.map((zone) => zone.name).join(', ')} have no completed audit in the
            selected period. Their leaders are notified; reassign if the window will be missed.
          </p>
        </div>
      ) : null}

      {loading ? (
        <>
          <Skeleton variant="tiles" count={5} label="Loading the Unit board…" />
          <Skeleton variant="tiles" count={6} />
          <Skeleton variant="chart" />
        </>
      ) : unit === '' ? null : (
        <>
          {/* ---------------------------------------------------------------- KPIs */}
          <section>
            <div className="gb-head">
              <div>
                <h2 className="gb-h1">{unitName?.name ?? 'Unit'}</h2>
                <p>
                  {PERIODS.find((period) => period.months === months)?.label} ·{' '}
                  {count(overview.data?.completedCount ?? 0)} completed{' '}
                  {overview.data?.completedCount === 1 ? 'audit' : 'audits'} in the analytics rollup ·
                  every score below is the server&apos;s recomputation, not a device&apos;s
                </p>
                {chosenAudit ? (
                  <p>
                    The first tile shows {chosenZone ? `${chosenZone.zoneName} in ` : ''}one audit, of{' '}
                    {formatDate(chosenAudit.completedAt)}; everything else on the board is the
                    period.{' '}
                    <Link to="/audits" search={{ audit: chosenAudit.id }}>
                      Open that audit
                    </Link>
                  </p>
                ) : null}
                {lagging > 0 ? (
                  <p>
                    {lagging} completed {lagging === 1 ? 'audit is' : 'audits are'} not in the rollup
                    yet — it runs nightly per Unit, so those scores reach the board on its next run.
                    They are missing here, not zero.
                  </p>
                ) : null}
              </div>
              <span className="gb-label">Outstanding ≥ {TARGET}</span>
            </div>
            <div className="gb-kpis" style={{ marginTop: 14 }}>
              {/* The score alone. The tile used to append "N scored zones", which read as a
                  second, unrelated figure sitting inside the score — the zone count already has
                  its own tile beside this one. Only the band word stays, because it is what the
                  tile's colour means. */}
              {/* One decimal, like every tile (D1, GEMBA §3). The weighted figure says which
                  number it is and names the latest audit's, which the trajectory ends on (B3). */}
              <Kpi
                label={chosenZone ? 'Zone score' : chosenAudit ? 'Audit score' : 'Unit score'}
                value={score1(unitScore)}
                context={
                  chosenZone
                    ? `${bandLabel(unitScore)} · ${chosenZone.zoneName} · ${formatDayMonth(chosenAudit!.completedAt)}`
                    : chosenAudit
                      ? `${bandLabel(unitScore)} · ${chosenAudit.auditorName} · ${formatDayMonth(chosenAudit.completedAt)}`
                      : `${bandLabel(unitScore)} · weighted across ${count(overview.data?.completedCount ?? 0)} ${
                          overview.data?.completedCount === 1 ? 'audit' : 'audits'
                        }${latestAudit ? ` · latest audit ${score1(latestAudit.totals.scorePercentage)}` : ''}`
                }
                band={bandOf(unitScore)}
              />
              <Kpi
                label="Zones audited"
                value={`${audited}/${board.length}`}
                context={
                  notStarted.length === 0
                    ? 'every zone covered'
                    : `${notStarted.map((zone) => zone.name).slice(0, 2).join(', ')} pending`
                }
                band={notStarted.length === 0 ? 'ok' : 'warn'}
              />
              {/* From the corrective-action list, one per nonconformity photograph: the same
                  source as the rows below, and not waiting on the nightly rollup. */}
              <Kpi
                label="Open actions"
                value={count(open.length)}
                context={`${count(zeroScored.length)} marked “Needs improvement”`}
                band={open.length === 0 ? 'ok' : 'warn'}
              />
              <Kpi
                label="Overdue actions"
                value={count(overdue.length)}
                context={
                  oldestOverdue
                    ? `oldest: ${daysBetween(oldestOverdue.openedAt, now)} d open · ${daysBetween(oldestOverdue.dueAt, now)} d overdue`
                    : 'nothing past its due date'
                }
                band={overdue.length === 0 ? 'ok' : 'crit'}
              />
              {/* Closed out of raised, not a percentage: "2/5" is the sentence a Coordinator
                  actually says, and at this Unit's volume a percentage turns five findings into
                  a figure like 40.0 that reads more precise than it is. The band still comes
                  from the server's rate, so the colour is unchanged. */}
              <Kpi
                label="Closure"
                value={raised.length === 0 ? '—' : `${closed.length}/${raised.length}`}
                context={
                  raised.length === 0
                    ? 'nothing raised in this period'
                    : closureHours === null
                      ? 'nothing closed yet'
                      : `${closureHours.toFixed(1)} h average to close`
                }
                band={bandOf(overview.data?.closureRatePercentage ?? null)}
              />
            </div>
          </section>

          {/* -------------------------------------------------- board + detail panel */}
          <section>
            <div className="gb-head">
              <div>
                <h2 className="gb-h1">Zones</h2>
                <p>Select a tile to read its section breakdown and its open findings.</p>
              </div>
              <span className="gb-label">Period score % · Δ latest on previous audit</span>
            </div>
            <div className="gb-split" style={{ marginTop: 14 }}>
              <div className="gb-board">
                {board.map((zone) => (
                  <ZoneTile
                    key={zone.zoneId}
                    zone={zone}
                    selected={zone.code === selected?.code}
                    onSelect={() => selectZone(zone.code)}
                  />
                ))}
                {board.length === 0 ? (
                  <p className="gb-label">No zones in this Unit yet.</p>
                ) : null}
              </div>
              {selected ? (
                <DetailPanel
                  zone={selected}
                  actions={raised.filter((a) => a.zoneCode === selected.code)}
                  headingRef={panelHeading}
                />
              ) : null}
            </div>
          </section>

          {/* ------------------------------------------------------------- matrix */}
          <section>
            <div className="gb-head">
              <div>
                <h2 className="gb-h1">Zones × 5S</h2>
                <p>
                  The five sections come from each zone&apos;s latest completed audit, and so does
                  Latest. Period is the zone&apos;s score weighted across every audit of it in the
                  period — the figure on its tile. A section marked not applicable throughout is
                  hatched N/A and left out of both.
                </p>
              </div>
              <span className="gb-label">
                From the last {recent.length} {recent.length === 1 ? 'audit' : 'audits'}
              </span>
            </div>
            <div className="gb-matrix" style={{ marginTop: 14 }}>
              <table>
                <thead>
                  <tr>
                    <th>Zone</th>
                    {S_SECTIONS.map((section) => (
                      <th key={section} className="gb-c">
                        {SECTION_SHORT_LABEL[section]}
                      </th>
                    ))}
                    <th className="gb-c gb-avg">Latest</th>
                    <th className="gb-c">Period</th>
                  </tr>
                </thead>
                <tbody>
                  {board.map((zone) => (
                    <tr key={zone.zoneId}>
                      <td className={rail(zone.score !== null && zone.score < TARGET ? 'crit' : 'none')}>
                        {zone.name}
                      </td>
                      {S_SECTIONS.map((section) => {
                        const cell = zone.sections?.find((row) => row.section === section);
                        if (!cell) return <MatrixCell key={section} />;
                        return <MatrixCell key={section} section={cell} />;
                      })}
                      {/* B1: Latest matches the cells beside it; Period is the weighted roll-up.
                          No rollup row means no figure yet: an em dash, never `N/A` and certainly
                          never `0` (§3). `N/A` is reserved for a scored zone whose questions were
                          all marked not applicable. */}
                      <td className="gb-avg gb-data">{zone.ranked ? score1(zone.lastScore) : '—'}</td>
                      <td className="gb-c gb-data" title={zone.ranked ? `Weighted across ${zone.auditCount} ${zone.auditCount === 1 ? 'audit' : 'audits'}` : undefined}>
                        {zone.ranked ? score1(zone.score) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* A cell's tint is its band; the key says which, in words and shape (B2). */}
            <p className="gb-bandkey">
              {BAND_KEY.map(([score, range]) => (
                <span key={range}>
                  <BandLabel score={score} /> {range}
                </span>
              ))}
            </p>
          </section>

          {/* -------------------------------------------------------------- trend */}
          <section>
            <div className="gb-head">
              <div>
                <h2 className="gb-h1">Unit trajectory</h2>
                <p>
                  Each completed audit&apos;s own score, oldest first, over the last twelve months.
                  The dashed rule is the Outstanding boundary at {TARGET}.
                </p>
              </div>
              <span className="gb-label">
                Score % · {trajectory.length} {trajectory.length === 1 ? 'audit' : 'audits'}
              </span>
            </div>
            <Trend points={trajectory} />
          </section>

          {/* ----------------------------------------------------- action pressure */}
          <section>
            <div className="gb-head">
              <div>
                <h2 className="gb-h1">Action pressure</h2>
                <p>Where the open findings sit, and how much of the period is still outstanding.</p>
              </div>
              <span className="gb-label">{count(open.length)} open</span>
            </div>
            {/* One card, counts over the bars (B13): two side by side left a void beside the
                longer one. The bars are ink — a count of findings, not a score band (B14). */}
            <div className="gb-card" style={{ marginTop: 14 }}>
              <h3 className="gb-h2">Open corrective actions · {count(open.length)}</h3>
              <p>One per nonconformity photograph, raised automatically when an audit completes.</p>
              <div className="gb-stats3">
                <div className="gb-crit">
                  <b className="gb-figure">{count(overdue.length)}</b>
                  <span className="gb-label">Overdue</span>
                </div>
                <div className="gb-warn">
                  <b className="gb-figure">{count(zeroScored.length)}</b>
                  <span className="gb-label">Needs improvement</span>
                </div>
                <div>
                  <b className="gb-figure">{count(dueThisWeek.length)}</b>
                  <span className="gb-label">Due this week</span>
                </div>
              </div>
              <div className="gb-completion">
                <span className="gb-label">By zone · share of the open findings, most first</span>
                <div className="gb-share">
                  {shareRows(board).map((row) => (
                    <div key={row.code} className="gb-srow">
                      <b>{row.name}</b>
                      <div className="gb-track">
                        <i style={{ width: `${row.width}%` }} />
                      </div>
                      <span>{count(row.count)}</span>
                    </div>
                  ))}
                  {open.length === 0 ? (
                    <p className="gb-label">No open findings in this Unit.</p>
                  ) : null}
                </div>
              </div>
              <div className="gb-completion">
                <span className="gb-label">Period completion</span>
                <div className="gb-prog">
                  <i style={{ width: `${board.length ? (audited / board.length) * 100 : 0}%` }} />
                </div>
                <div className="gb-progmeta">
                  <span>
                    {audited} of {board.length} zones audited
                  </span>
                  <span>{board.length ? Math.round((audited / board.length) * 100) : 0}%</span>
                </div>
              </div>
            </div>
          </section>

          {/* -------------------------------------------------- corrective actions */}
          <section>
            <div className="gb-head">
              <div>
                <h2 className="gb-h1">Corrective actions</h2>
                <p>
                  Overdue first.{' '}
                  {raised.length > SHOWN
                    ? `The first ${SHOWN} of ${count(raised.length)}${actions.data?.nextCursor ? '+' : ''}; the rest are on Corrective actions.`
                    : 'Raised automatically from every nonconformity on completion.'}{' '}
                  A finding opens its corrective action.
                </p>
              </div>
              {/* B9: never a dead end — the whole list is one step away. */}
              <Link className="gb-btn" to="/corrective-actions">
                {raised.length > SHOWN ? `View all ${count(raised.length)}${actions.data?.nextCursor ? '+' : ''} →` : 'Corrective actions →'}
              </Link>
            </div>
            <div className="gb-tablewrap" style={{ marginTop: 14 }}>
              <table>
                <thead>
                  <tr>
                    <th>Finding</th>
                    <th>Zone</th>
                    <th>Owner</th>
                    <th>Raised</th>
                    <th>Due</th>
                    <th>Days open</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {sortActions(raised, now)
                    .slice(0, SHOWN)
                    .map((action) => {
                      const state = actionState(action, now);
                      return (
                        <tr key={action.id}>
                          <td className={`${rail(state.band)} gb-finding-cell`}>
                            <Link to="/corrective-actions" search={{ action: action.id }}>
                              {findingTitle(action)}
                            </Link>
                          </td>
                          <td>{action.zoneName}</td>
                          <td>{action.assignedZoneLeaderName ?? '—'}</td>
                          <td className="gb-data">{formatDate(action.openedAt)}</td>
                          <td className="gb-data">{formatDate(action.dueAt)}</td>
                          <td className="gb-data">
                            {daysBetween(action.openedAt, now)} d
                          </td>
                          <td>
                            <span className={`gb-chip gb-chip--${chipTone(state.band)}`}>
                              {state.label}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  {raised.length === 0 ? (
                    <tr>
                      <td className={rail('none')} colSpan={7}>
                        No corrective actions in this Unit.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>

          {/* ------------------------------------------------------ recent audits */}
          <section>
            <div className="gb-head">
              <div>
                <h2 className="gb-h1">Recent audits</h2>
                <p>
                  {recent.length === RECENT
                    ? `The last ${RECENT} completed audits in this Unit.`
                    : `All ${recent.length} completed ${recent.length === 1 ? 'audit' : 'audits'} in this Unit for the period.`}{' '}
                  Scores show two decimals, because this table is the record.
                </p>
              </div>
              <span className="gb-label">Walk-by audits carry no score</span>
            </div>
            <div className="gb-tablewrap" style={{ marginTop: 14 }}>
              <table>
                <thead>
                  <tr>
                    <th>Completed</th>
                    <th>Auditor</th>
                    <th>Type</th>
                    <th>Zones</th>
                    <th>Score</th>
                    <th>Band</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((audit, index) => {
                    const summary = summaries[index]?.data;
                    const pct = summary?.audit.totals.scorePercentage ?? null;
                    return (
                      <tr key={audit.id}>
                        <td className={rail(pct !== null && pct < TARGET ? 'warn' : 'none')}>
                          <Link to="/audits" search={{ audit: audit.id }}>
                            {formatDateTime(audit.completedAt)}
                          </Link>
                        </td>
                        <td>{audit.auditorName}</td>
                        <td>{AUDIT_TYPE_LABEL[audit.auditType]}</td>
                        <td className="gb-data">{summary?.zones.length ?? '—'}</td>
                        <td className="gb-data">{score2(pct)}</td>
                        <td>
                          <BandLabel score={pct} />
                        </td>
                        <td>{AUDIT_STATUS_LABEL[audit.status]}</td>
                      </tr>
                    );
                  })}
                  {recent.length === 0 ? (
                    <tr>
                      <td className={rail('none')} colSpan={7}>
                        No completed audits in the selected period.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>

        </>
      )}

      <p className="gb-foot">
        A section where every question is marked not applicable scores <b>N/A</b> and is excluded
        from its zone average — never recorded as zero. Scores here are the server&apos;s
        recomputation; a device&apos;s own figure is display-only and never shown on this board.
      </p>
    </>
  );
}

function Kpi({
  label,
  value,
  context,
  band,
}: {
  label: string;
  value: string;
  context: string;
  band: Band;
}) {
  return (
    <div className={`gb-tile gb-kpi gb-${band}`}>
      <span className="gb-label">{label}</span>
      <b className="gb-figure">{value}</b>
      <small>{context}</small>
      <div className={`gb-band gb-band--${band}`} />
    </div>
  );
}

/**
 * The magnet (§6 "Zone tile"). Anatomy is fixed: label → figure + delta → meta → band.
 * A Zone with no completed audit in the period is the dashed pending tile and an em dash.
 */
function ZoneTile({
  zone,
  selected,
  onSelect,
}: {
  zone: BoardZone;
  selected: boolean;
  onSelect: () => void;
}) {
  const pending = zone.score === null;
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={`gb-tile gb-tile--interactive gb-zone gb-${zone.band}${pending ? ' gb-tile--pending' : ''}`}
      aria-label={`${zone.name}: ${
        pending
          ? awaitingRollup(zone)
            ? 'audited, score not yet in the analytics rollup'
            : 'not audited in this period'
          : `${score1(zone.score)} percent, ${bandLabel(zone.score)}`
      }`}
    >
      <span className="gb-label">{zone.name}</span>
      <span className="gb-row">
        <span className="gb-figure">{pending ? '—' : score1(zone.score)}</span>
        <span className="gb-delta">
          {pending ? (awaitingRollup(zone) ? 'awaiting rollup' : 'not started') : delta1(zone.delta)}
        </span>
      </span>
      {/* The band in words and shape, not colour alone: On Track and Outstanding share a green (B2). */}
      {pending ? null : <BandLabel score={zone.score} className="gb-zone-band" />}
      <span className="gb-meta">
        <span>Leader {zone.leader ?? 'unassigned'}</span>
        {zone.openNonconformities > 0 ? (
          <em>{count(zone.openNonconformities)} NC</em>
        ) : (
          <span>{pending ? zone.code : 'no NC'}</span>
        )}
      </span>
      <span className={`gb-band gb-band--${zone.band}`} />
    </button>
  );
}

/** §6 "Detail panel": header, the five section rows with a tick row, then open findings. */
function DetailPanel({
  zone,
  actions,
  headingRef,
}: {
  zone: BoardZone;
  actions: CorrectiveAction[];
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const scored = (zone.sections ?? []).filter((section) => section.pct !== null);
  const excluded = (zone.sections ?? []).filter(
    (section) => section.pct === null && section.na > 0,
  );

  const openFindings = actions.filter((action) => findingStatus(action).tone === 'open');
  const sortedFindings = groupFindings(
    [...actions].sort((a, b) => {
      const byTone = FINDING_ORDER[findingStatus(a).tone] - FINDING_ORDER[findingStatus(b).tone];
      return byTone !== 0 ? byTone : b.openedAt.localeCompare(a.openedAt);
    }),
  );

  return (
    <div className="gb-detail">
      <div className="gb-detail-head">
        <h3 className="gb-h2" ref={headingRef} tabIndex={-1}>
          {zone.name}
        </h3>
        <p>
          {zone.code} · leader {zone.leader ?? 'unassigned'} ·{' '}
          {zone.lastAuditAt
            ? `audited ${formatDate(zone.lastAuditAt)}${zone.auditorName ? ` by ${zone.auditorName}` : ''}`
            : 'not audited in this period'}
          {awaitingRollup(zone) ? ' · score pending rollup' : ''}
        </p>
      </div>
      <div className="gb-detail-body">
        <span className="gb-label">Section breakdown</span>
        <div className="gb-sections">
          {S_SECTIONS.map((section) => {
            const row = zone.sections?.find((candidate) => candidate.section === section);
            const band = row ? bandOf(row.pct) : 'none';
            return (
              <div key={section} className={`gb-srow gb-${band}`}>
                <u>{SECTION_SHORT_LABEL[section]}</u>
                <div className={`gb-track${row && row.pct === null ? ' gb-na' : ''}`}>
                  {row?.pct !== null && row !== undefined ? (
                    <i style={{ width: `${row.pct}%` }} />
                  ) : null}
                </div>
                <b>{row ? (row.pct === null ? 'N/A' : row.pct.toFixed(1)) : '—'}</b>
              </div>
            );
          })}
        </div>
        <div className="gb-ticks">
          <div />
          <div>
            <span>0</span>
            <span>25</span>
            <span>50</span>
            <span>75</span>
            <span>100</span>
          </div>
          <div />
        </div>

        {zone.sections === null ? (
          <p className="gb-aside">
            No completed audit for this zone in the last {RECENT} audits of the period, so there is
            no section breakdown to show. That is not a score of zero.
          </p>
        ) : awaitingRollup(zone) ? (
          <p className="gb-aside">
            These are the server&apos;s section scores from the audit itself. The zone score and
            its Δ arrive with the nightly analytics rollup, which has not run since this audit
            completed.
          </p>
        ) : excluded.length > 0 ? (
          <p className="gb-aside">
            {excluded.length === 1 ? 'One section was' : `${excluded.length} sections were`} marked
            not applicable throughout and {excluded.length === 1 ? 'is' : 'are'} excluded from the
            average. The zone score is the server&apos;s mean of the {scored.length} scored
            sections.
          </p>
        ) : null}

        {/*
          Every finding of this zone, not only the open ones.

          The panel used to list open findings alone, so a zone that had fixed everything
          read identically to one that was never audited — and the work that had been done
          was invisible on the board that is supposed to show it.

          The rail and the chip carry the same fact, which is the point: colour alone never
          says whether something is closed (non-negotiable 9), so the row stays readable on
          a projector, in sunlight, and to a colour-blind reader.
        */}
        <div className="gb-findings">
          <span className="gb-label">
            Findings · {openFindings.length} open of {actions.length}
          </span>
          {actions.length === 0 ? (
            <p style={{ fontSize: 12.5, margin: '8px 0 0' }}>No findings raised in this zone.</p>
          ) : (
            <ul>
              {sortedFindings.map(({ key, lead: action, actions: photos }) => {
                // Sorted before grouping, so the lead is the group's most pressing action.
                const state = findingStatus(action);
                // Age counts to closure for a finished finding, not to today: a finding
                // closed in three days a month ago took three days, and showing 30 would
                // make prompt work look like a backlog.
                const until =
                  state.tone === 'closed' && action.resolvedAt !== null
                    ? Date.parse(action.resolvedAt)
                    : Date.now();
                return (
                  <li key={key} className={`gb-finding gb-finding--${state.tone}`}>
                    <i />
                    <div className="gb-finding-text">
                      {/* B4: a finding opens its corrective action; its audit holds the photographs. */}
                      <Link to="/corrective-actions" search={{ action: action.id }}>
                        {findingTitle(action)}
                      </Link>
                      {photos.length > 1 ? <b> · {count(photos.length)} photos</b> : null}
                      {' · '}
                      <Link to="/audits" search={{ audit: action.auditId }}>
                        audit
                      </Link>
                      {action.scoreAtCapture === 'SCORE_0' ? <b> · marked “Needs improvement”</b> : null}
                    </div>
                    <em>{state.label}</em>
                    <span>{daysBetween(action.openedAt, until)} d open</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

/** §6 "Trend chart": hand-authored SVG, all strokes and fills from tokens. */
function Trend({
  points,
}: {
  points: Array<{ period: string; detail?: string; scorePercentage: number | null }>;
}) {
  const geometry = trendGeometry(points);
  if (!geometry) {
    return (
      <div className="gb-trend" style={{ marginTop: 14 }}>
        <p className="gb-label">No scored audit in the last twelve months.</p>
      </div>
    );
  }
  const current = geometry.end.value;
  const twoLine = geometry.xTicks.some((tick) => tick.sub !== undefined);

  return (
    <div className="gb-trend" style={{ marginTop: 14 }}>
      <div className="gb-legend">
        <span>
          <i /> Audit score
        </span>
        <span>
          <i className="gb-target" /> Outstanding {TARGET}
        </span>
        <span>
          Current {score1(current)} ·{' '}
          {current >= TARGET
            ? `${(current - TARGET).toFixed(1)} points clear`
            : `${(TARGET - current).toFixed(1)} points short`}
        </span>
      </div>
      <svg
        viewBox={`0 0 720 ${twoLine ? 194 : 182}`}
        role="img"
        aria-label={`Score of each of the last ${geometry.points.length} completed audits, most recently ${score1(current)} against an Outstanding boundary of ${TARGET}`}
      >
        <g className="gb-grid-line">
          {geometry.gridY.map((y) => (
            <line key={y} x1={44} y1={y} x2={706} y2={y} />
          ))}
        </g>
        <line className="gb-target-line" x1={44} y1={geometry.targetY} x2={706} y2={geometry.targetY} />
        <path className="gb-area" d={geometry.area} />
        <path className="gb-line" d={geometry.line} />
        {/* One marker per audit: the line alone hides how many audits drew it, and a
            flat run of four reads the same as a single reading without them. */}
        {/* Each marker names its reading on hover; the hit area is wider than the dot. */}
        {geometry.points.map((point, index) => {
          const last = index === geometry.points.length - 1;
          return (
            <g key={index}>
              <title>{`${point.label}${point.detail ? `, ${point.detail}` : ''}: ${score1(point.value)}`}</title>
              <circle className="gb-hit" cx={point.x} cy={point.y} r={10} />
              <circle className={last ? 'gb-dot' : 'gb-mark'} cx={point.x} cy={point.y} r={last ? 5 : 3.5} />
            </g>
          );
        })}
        <text className="gb-now" x={geometry.end.x - 6} y={geometry.end.y - 10} textAnchor="end">
          {score1(current)}
        </text>
        <g className="gb-axis" textAnchor="end">
          {geometry.yTicks.map((tick) => (
            <text key={tick.label} x={36} y={tick.y + 3}>
              {tick.label}
            </text>
          ))}
        </g>
        <g className="gb-axis" textAnchor="middle">
          {geometry.xTicks.map((tick, index) => (
            <text key={index} x={tick.x} y={168}>
              {tick.label}
              {tick.sub ? (
                <tspan x={tick.x} dy={12}>
                  {tick.sub}
                </tspan>
              ) : null}
            </text>
          ))}
        </g>
        <text className="gb-axis" x={50} y={geometry.targetY - 4} textAnchor="start">
          OUTSTANDING {TARGET}
        </text>
      </svg>
    </div>
  );
}

function MatrixCell({ section }: { section?: SectionScorePayload }) {
  if (!section) return <td className="gb-c gb-none gb-data">—</td>;
  if (section.pct === null) {
    return (
      <td className="gb-c gb-na gb-data" title={`${section.na} questions, all not applicable`}>
        N/A
      </td>
    );
  }
  return (
    <td className={`gb-c gb-${bandOf(section.pct)} gb-data`}>{section.pct.toFixed(1)}</td>
  );
}

/** The 4px severity rail on the first cell of a row (§6 "Table"). */
function rail(band: Band): string {
  return band === 'crit' ? 'gb-row-crit' : band === 'warn' ? 'gb-row-warn' : 'gb-row-none';
}

function chipTone(band: Band): string {
  return band === 'none' ? 'muted' : band;
}

function shareRows(board: BoardZone[]) {
  const ranked = board
    .filter((zone) => zone.openNonconformities > 0)
    .sort((a, b) => b.openNonconformities - a.openNonconformities);
  const top = ranked[0]?.openNonconformities ?? 1;
  return ranked.map((zone) => ({
    code: zone.code,
    name: zone.name,
    count: zone.openNonconformities,
    width: Math.round((zone.openNonconformities / top) * 100),
  }));
}

/** Overdue first, then due soonest, then everything already answered. */
function sortActions(actions: CorrectiveAction[], now: number): CorrectiveAction[] {
  const weight = (action: CorrectiveAction) => {
    const state = actionState(action, now);
    return state.band === 'crit' ? 0 : state.band === 'warn' ? 1 : 2;
  };
  return actions
    .slice()
    .sort(
      (a, b) =>
        weight(a) - weight(b) ||
        (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999') ||
        a.openedAt.localeCompare(b.openedAt),
    );
}

function actionState(action: CorrectiveAction, now: number): { band: Band; label: string } {
  const live = action.status === 'OPEN' || action.status === 'REOPENED';
  const due = action.dueAt === null ? null : Date.parse(action.dueAt);
  if (live && due !== null && due < now) return { band: 'crit', label: 'Overdue' };
  if (live && due !== null && due < now + 7 * DAY) {
    return { band: 'warn', label: `Due in ${Math.max(0, Math.ceil((due - now) / DAY))} d` };
  }
  // R-43: closed is not verified — only a reviewer's approval makes it that.
  if (action.status === 'VERIFIED') {
    return { band: 'none', label: action.verifiedByUserId === null ? 'Closed' : 'Closed · approved' };
  }
  if (action.status === 'ACTION_SUBMITTED') return { band: 'none', label: 'Awaiting review' };
  if (action.status === 'NOT_POSSIBLE') return { band: 'none', label: 'Not possible' };
  return { band: 'none', label: action.status === 'REOPENED' ? 'Reopened' : 'Open' };
}

/**
 * Open, in flight, or closed — the distinction the zone panel colour-codes.
 *
 * Deliberately not `actionState`, which answers a different question: that one is about
 * *urgency* (overdue, due this week) and drives the register below. A finding can be open
 * and not yet due, and the panel still has to show it as open.
 *
 * `NOT_POSSIBLE` sits with the submitted work rather than with the closed findings: it is
 * an answer awaiting a reviewer's acceptance, and §7.3 ends it at `VERIFIED` like any
 * other. Counting it as closed here would show a finding as resolved that nobody has yet
 * agreed to resolve.
 */
function findingStatus(action: CorrectiveAction): {
  tone: 'open' | 'submitted' | 'closed';
  label: string;
} {
  switch (action.status) {
    case 'OPEN':
      return { tone: 'open', label: 'Open' };
    case 'REOPENED':
      return { tone: 'open', label: 'Reopened' };
    case 'ACTION_SUBMITTED':
      return { tone: 'submitted', label: 'Awaiting review' };
    case 'NOT_POSSIBLE':
      return { tone: 'submitted', label: 'Not possible' };
    case 'VERIFIED':
      return { tone: 'closed', label: 'Closed' };
    case 'WITHDRAWN':
      // Settled, so it sorts with the closed findings — but labelled for what it is. R-31:
      // the auditor corrected the mark, and nobody fixed anything.
      return { tone: 'closed', label: 'Withdrawn' };
  }
}

/** Open first, then what is awaiting review, then what is done; newest first within each. */
const FINDING_ORDER: Record<'open' | 'submitted' | 'closed', number> = {
  open: 0,
  submitted: 1,
  closed: 2,
};

function findingTitle(action: CorrectiveAction): string {
  return action.questionText ?? action.suggestion ?? action.findingRemark ?? 'Walk-by observation';
}
