import { useMemo, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import type {
  Audit,
  AuditScoreSummary,
  CorrectiveAction,
  Page,
  SectionScorePayload,
  Unit,
  UnitOverview,
  UnitTrend,
  Zone,
  ZoneRankingItem,
} from '@audit5s/contracts';
import { S_SECTIONS } from '@audit5s/contracts';
import { Link } from '@tanstack/react-router';
import { Combobox } from '@/components/ui';
import { TopbarTools } from '@/components/AppShell';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import {
  SECTION_LABEL,
  TARGET,
  awaitingRollup,
  bandLabel,
  bandOf,
  delta1,
  mergeBoard,
  score1,
  score2,
  trendGeometry,
  worstIndex,
  type Band,
  type BoardZone,
  type LatestZoneAudit,
} from './board';

/** The rollup's clock, in the Unit's own timezone — a plant reads its own wall clock. */
function lastSync(at: number | undefined, timezone = 'Asia/Kolkata'): string {
  if (!at) return '—';
  return new Date(at).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone,
    timeZoneName: 'short',
  });
}

const PERIODS = [
  { months: 3, label: 'Last 3 months' },
  { months: 6, label: 'Last 6 months' },
  { months: 12, label: 'Last 12 months' },
] as const;

/** The number of recent audits the section breakdown and the matrix are read from. */
const RECENT = 5;
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
  const [unitId, setUnitId] = useState('');
  const [months, setMonths] = useState<number>(12);
  /**
   * What the Unit score tile reports: the period's weighted score, or one audit's own.
   *
   * The weighted figure answers "how is this Unit doing" — `Σraw / Σmax` across the period,
   * never a mean of percentages (R-15a) — and a single audit answers "how did that one go".
   * Both are the server's; picking between them is the one thing this control does.
   */
  const [scoreAuditId, setScoreAuditId] = useState('');

  const units = useQuery({
    queryKey: ['units'],
    queryFn: () => api.get<Page<Unit>>('/units?limit=200'),
  });
  const unit = unitId || units.data?.data[0]?.id || '';
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
    queryFn: () => api.get<UnitOverview>(`/analytics/units/${unit}/overview?${range}`),
    enabled,
  });
  const ranking = useQuery({
    queryKey: ['dashboard', unit, from, 'ranking'],
    queryFn: () =>
      api.get<ZoneRankingItem[]>(
        `/analytics/units/${unit}/zones/ranking?order=worst&limit=200&${range}`,
      ),
    enabled,
  });
  const trend = useQuery({
    queryKey: ['dashboard', unit, from, 'trend'],
    queryFn: () => api.get<UnitTrend>(`/analytics/units/${unit}/trend?granularity=month&${range}`),
    enabled,
  });
  const zones = useQuery({
    queryKey: ['dashboard', unit, 'zones'],
    queryFn: () => api.get<Page<Zone>>(`/units/${unit}/zones?limit=200`),
    enabled,
  });
  const audits = useQuery({
    queryKey: ['dashboard', unit, from, 'audits'],
    queryFn: () =>
      api.get<Page<Audit>>(`/audits?unitId=${unit}&from=${encodeURIComponent(from)}&limit=200`),
    enabled,
  });
  const actions = useQuery({
    queryKey: ['dashboard', unit, 'corrective-actions'],
    queryFn: () => api.get<Page<CorrectiveAction>>(`/corrective-actions?unitId=${unit}&limit=200`),
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
      queryFn: () => api.get<AuditScoreSummary>(`/audits/${audit.id}/summary`),
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
  const chosenAudit = scorable.find((audit) => audit.id === scoreAuditId) ?? null;
  // The audit's own total, as the server recomputed it on completion — not a figure this
  // page works out, which is the rule the whole board follows (§3).
  const unitScore = chosenAudit
    ? chosenAudit.totals.scorePercentage
    : (overview.data?.score.scorePercentage ?? null);

  const error = [units, overview, ranking, trend, zones, audits, actions].find((query) => query.error)
    ?.error;

  return (
    <>
      <TopbarTools>
        <div className="gb-sel">
          <label className="gb-label" htmlFor="gb-unit">
            Unit
          </label>
          <Combobox
            id="gb-unit"
            className="gb-sel-input"
            value={unit}
            onChange={setUnitId}
            options={(units.data?.data ?? []).map((candidate) => ({
              id: candidate.id,
              label: candidate.name,
            }))}
            placeholder="Search Units…"
          />
        </div>
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
            onChange={(event) => setScoreAuditId(event.target.value)}
          >
            <option value="">Weighted, all audits</option>
            {scorable.map((audit, index) => (
              <option key={audit.id} value={audit.id}>
                {`Audit ${scorable.length - index} · ${formatDate(audit.completedAt)} · ${audit.auditorName}`}
              </option>
            ))}
          </select>
        </div>
        <div className="gb-pill">
          <i />
          Last sync <span className="gb-data">{lastSync(overview.dataUpdatedAt, unitName?.timezone)}</span>
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

      {/* The one slip: only ever rendered for something a human must act on (§2.7). */}
      {overdue.length > 0 ? (
        <div className="gb-slip">
          <b>{overdue.length} corrective actions overdue</b>
          <p>
            Oldest is “{findingTitle(oldestOverdue!)}” in {oldestOverdue!.zoneName}, due{' '}
            {formatDate(oldestOverdue!.dueAt)} and owned by{' '}
            {oldestOverdue!.assignedZoneLeaderName ?? 'nobody'}. Reassign it or accept the slip.
          </p>
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

      {/* ---------------------------------------------------------------- KPIs */}
      <section>
        <div className="gb-head">
          <div>
            <h2 className="gb-h1">{unitName?.name ?? 'Unit'}</h2>
            <p>
              {PERIODS.find((period) => period.months === months)?.label} ·{' '}
              {overview.data?.completedCount ?? 0} completed audits in the analytics rollup ·
              every score below is the server&apos;s recomputation, not a device&apos;s
            </p>
            {lagging > 0 ? (
              <p>
                {lagging} completed {lagging === 1 ? 'audit is' : 'audits are'} not in the rollup
                yet — it runs nightly per Unit, so those scores reach the board on its next run.
                They are missing here, not zero.
              </p>
            ) : null}
          </div>
          <span className="gb-badge">Outstanding ≥ {TARGET}</span>
        </div>
        <div className="gb-kpis" style={{ marginTop: 14 }}>
          {/* The score alone. The tile used to append "N scored zones", which read as a
              second, unrelated figure sitting inside the score — the zone count already has
              its own tile beside this one. Only the band word stays, because it is what the
              tile's colour means. */}
          <Kpi
            label={chosenAudit ? 'Audit score' : 'Unit score'}
            value={score2(unitScore)}
            context={
              chosenAudit
                ? `${bandLabel(unitScore)} · ${chosenAudit.auditorName} · ${formatDate(chosenAudit.completedAt)}`
                : bandLabel(unitScore)
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
            label="Open corrective actions"
            value={String(open.length)}
            context={`${zeroScored.length} captured at score 0`}
            band={open.length === 0 ? 'ok' : 'warn'}
          />
          <Kpi
            label="Overdue actions"
            value={String(overdue.length)}
            context={
              oldestOverdue
                ? `oldest ${Math.floor((now - Date.parse(oldestOverdue.dueAt!)) / DAY)} days`
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
          <span className="gb-label">Score % · Δ on previous audit</span>
        </div>
        <div className="gb-split" style={{ marginTop: 14 }}>
          <div className="gb-board">
            {board.map((zone) => (
              <ZoneTile
                key={zone.zoneId}
                zone={zone}
                selected={zone.code === selected?.code}
                onSelect={() => setSelectedCode(zone.code)}
              />
            ))}
            {board.length === 0 ? (
              <p className="gb-label">No zones in this Unit yet.</p>
            ) : null}
          </div>
          {selected ? (
            <DetailPanel zone={selected} actions={open.filter((a) => a.zoneCode === selected.code)} />
          ) : null}
        </div>
      </section>

      {/* ------------------------------------------------------------- matrix */}
      <section>
        <div className="gb-head">
          <div>
            <h2 className="gb-h1">Zones × 5S</h2>
            <p>
              Every section of every zone in one grid, from each zone&apos;s latest completed
              audit. A section marked not applicable throughout is hatched `N/A` and excluded
              from the zone average.
            </p>
          </div>
          <span className="gb-badge">Last {RECENT} audits</span>
        </div>
        <div className="gb-matrix" style={{ marginTop: 14 }}>
          <table>
            <thead>
              <tr>
                <th>Zone</th>
                {S_SECTIONS.map((section) => (
                  <th key={section} className="gb-c">
                    {SECTION_LABEL[section]}
                  </th>
                ))}
                <th className="gb-c">Zone avg</th>
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
                  {/* No rollup row means no average yet: an em dash, never `N/A` and
                      certainly never `0` (§3). `N/A` is reserved for a scored zone whose
                      questions were all marked not applicable. */}
                  <td className="gb-avg gb-data">{zone.ranked ? score1(zone.score) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* -------------------------------------------------------------- trend */}
      <section>
        <div className="gb-head">
          <div>
            <h2 className="gb-h1">Unit trajectory</h2>
            <p>
              Composite Unit score by month. The dashed rule is the Outstanding boundary at{' '}
              {TARGET}.
            </p>
          </div>
          <span className="gb-label">Score % · monthly</span>
        </div>
        <Trend points={trend.data?.points ?? []} />
      </section>

      {/* ----------------------------------------------------- action pressure */}
      <section>
        <div className="gb-head">
          <div>
            <h2 className="gb-h1">Action pressure</h2>
            <p>Where the open findings sit, and how much of the period is still outstanding.</p>
          </div>
          <span className="gb-label">{open.length} open</span>
        </div>
        <div className="gb-press" style={{ marginTop: 14 }}>
          <div className="gb-card">
            <h3 className="gb-h2">Open corrective actions · {open.length}</h3>
            <p>
              One per nonconformity photograph, raised automatically when an audit completes.
            </p>
            <div className="gb-stats3">
              <div className="gb-crit">
                <b className="gb-figure">{overdue.length}</b>
                <span className="gb-label">Overdue</span>
              </div>
              <div className="gb-warn">
                <b className="gb-figure">{zeroScored.length}</b>
                <span className="gb-label">Captured at 0</span>
              </div>
              <div>
                <b className="gb-figure">{dueThisWeek.length}</b>
                <span className="gb-label">Due this week</span>
              </div>
            </div>
          </div>
          <div className="gb-card">
            <h3 className="gb-h2">By zone</h3>
            <p>Share of the open findings, worst first.</p>
            <div className="gb-share">
              {shareRows(board).map((row) => (
                <div key={row.code} className={`gb-srow gb-${row.band}`}>
                  <b>{row.name}</b>
                  <div className="gb-track">
                    <i style={{ width: `${row.width}%` }} />
                  </div>
                  <span>{row.count}</span>
                </div>
              ))}
              {open.length === 0 ? (
                <p className="gb-label">No open findings in this Unit.</p>
              ) : null}
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
                <span>{board.length ? ((audited / board.length) * 100).toFixed(1) : '0.0'} %</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* -------------------------------------------------- corrective actions */}
      <section>
        <div className="gb-head">
          <div>
            <h2 className="gb-h1">Corrective actions</h2>
            <p>Overdue first. Raised automatically from every nonconformity on completion.</p>
          </div>
          {overdue.length > 0 ? (
            <span className="gb-tape">{overdue.length} overdue</span>
          ) : (
            <span className="gb-label">Nothing overdue</span>
          )}
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
                <th>Age</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {sortActions(raised, now)
                .slice(0, 12)
                .map((action) => {
                  const state = actionState(action, now);
                  return (
                    <tr key={action.id}>
                      <td className={rail(state.band)}>{findingTitle(action)}</td>
                      <td>{action.zoneName}</td>
                      <td>{action.assignedZoneLeaderName ?? '—'}</td>
                      <td className="gb-data">{formatDate(action.openedAt)}</td>
                      <td className="gb-data">{formatDate(action.dueAt)}</td>
                      <td className="gb-data">
                        {Math.floor((now - Date.parse(action.openedAt)) / DAY)} d
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
              The last {RECENT} completed audits in this Unit. Scores are the server&apos;s, to
              three decimals, because this table stands in for the record.
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
                      {formatDateTime(audit.completedAt)}
                    </td>
                    <td>{audit.auditorName}</td>
                    <td>{audit.auditType.replace(/_/g, ' ')}</td>
                    <td className="gb-data">{summary?.zones.length ?? '—'}</td>
                    <td className="gb-data">{score2(pct)}</td>
                    <td>
                      <span className={`gb-chip gb-chip--${chipTone(bandOf(pct))}`}>
                        {bandLabel(pct)}
                      </span>
                    </td>
                    <td>{audit.status.replace(/_/g, ' ').toLowerCase()}</td>
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
      <span className="gb-meta">
        <span>Leader {zone.leader ?? 'unassigned'}</span>
        {zone.openNonconformities > 0 ? (
          <em>{zone.openNonconformities} NC</em>
        ) : (
          <span>{pending ? zone.code : 'no NC'}</span>
        )}
      </span>
      <span className={`gb-band gb-band--${zone.band}`} />
    </button>
  );
}

/** §6 "Detail panel": header, the five section rows with a tick row, then open findings. */
function DetailPanel({ zone, actions }: { zone: BoardZone; actions: CorrectiveAction[] }) {
  const scored = (zone.sections ?? []).filter((section) => section.pct !== null);
  const excluded = (zone.sections ?? []).filter(
    (section) => section.pct === null && section.na > 0,
  );

  return (
    <div className="gb-detail">
      <div className="gb-detail-head">
        <h3 className="gb-h2">{zone.name}</h3>
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
                <u>{SECTION_LABEL[section]}</u>
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

        <div className="gb-findings">
          <span className="gb-label">Open findings · {actions.length}</span>
          {actions.length === 0 ? (
            <p style={{ fontSize: 12.5, margin: '8px 0 0' }}>No open findings in this zone.</p>
          ) : (
            <ul>
              {actions.map((action) => (
                <li
                  key={action.id}
                  className={action.scoreAtCapture === 'SCORE_0' ? 'gb-crit' : undefined}
                >
                  <i />
                  {findingTitle(action)}
                  <span>{Math.floor((Date.now() - Date.parse(action.openedAt)) / DAY)} d</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

/** §6 "Trend chart": hand-authored SVG, all strokes and fills from tokens. */
function Trend({ points }: { points: UnitTrend['points'] }) {
  const geometry = trendGeometry(points);
  if (!geometry) {
    return (
      <div className="gb-trend" style={{ marginTop: 14 }}>
        <p className="gb-label">No scored audit in the selected period.</p>
      </div>
    );
  }
  const current = geometry.end.value;

  return (
    <div className="gb-trend" style={{ marginTop: 14 }}>
      <div className="gb-legend">
        <span>
          <i /> Unit composite
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
        viewBox="0 0 720 182"
        role="img"
        aria-label={`Unit composite score across ${points.length} periods, currently ${score1(current)} against an Outstanding boundary of ${TARGET}`}
      >
        <g className="gb-grid-line">
          {geometry.gridY.map((y) => (
            <line key={y} x1={44} y1={y} x2={706} y2={y} />
          ))}
        </g>
        <line className="gb-target-line" x1={44} y1={geometry.targetY} x2={706} y2={geometry.targetY} />
        <path className="gb-area" d={geometry.area} />
        <path className="gb-line" d={geometry.line} />
        <circle className="gb-dot" cx={geometry.end.x} cy={geometry.end.y} r={5} />
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
          {geometry.xTicks.map((tick) => (
            <text key={tick.label} x={tick.x} y={168}>
              {tick.label}
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
    band: zone.openNonconformities >= 5 ? 'crit' : zone.openNonconformities >= 3 ? 'warn' : 'none',
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
  if (action.status === 'VERIFIED') return { band: 'none', label: 'Closed · verified' };
  if (action.status === 'ACTION_SUBMITTED') return { band: 'none', label: 'Awaiting review' };
  if (action.status === 'NOT_POSSIBLE') return { band: 'none', label: 'Not possible' };
  return { band: 'none', label: action.status === 'REOPENED' ? 'Reopened' : 'Open' };
}

function findingTitle(action: CorrectiveAction): string {
  return action.questionText ?? action.findingRemark ?? 'Walk-by observation';
}

function formatDate(iso: string | null): string {
  return iso === null ? '—' : new Date(iso).toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
}

function formatDateTime(iso: string | null): string {
  return iso === null
    ? '—'
    : new Date(iso).toLocaleString(undefined, {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
}
