import { S_SECTION_ORDER, S_SECTION_SHORT_LABELS, reportZoneLabel } from '@audit5s/domain';
import type { ReportPayload, ReportZone } from './payload-types';
import {
  Footer,
  Header,
  MetaCell,
  Photo,
  RadarWeb,
  RatingPills,
  SectionBars,
  SectionTable,
  TrendBars,
  ZoneComparisonBars,
  bandOf,
  formatDate,
  formatMarks,
  formatPercentage,
  photoCaption,
  ratingLabel,
  type ImageResolver,
} from './components';

/**
 * The multi-Zone summary (ARCHITECTURE.md §10.3-C).
 *
 * The rule the whole page rests on, and the one a "helpful" refactor would break: every
 * number is **summed over the selected Zones** — `Σachieved / Σmax` — and never the mean
 * of the Zone percentages. The sample confirms it (1280 / 2092 = 61.2 %), and the
 * arithmetic is done once in `freezePayload`, so this template only prints.
 *
 * There is **no auditor selfie** here (§4.3 item 9): a summary spans several audits, so
 * there is no single auditor to verify.
 */
export function SummaryReport({
  payload,
  resolve,
}: {
  payload: ReportPayload;
  resolve: ImageResolver;
}) {
  const extras = payload.summaryExtras;
  const scored = payload.zones.filter((zone) => zone.scored);

  return (
    <>
      <Footer />
      <Header
        title="LEAN 5S SUMMARY REPORT"
        subtitle="Cumulative performance across the selected zones"
      />

      <div className="meta-grid">
        <MetaCell label="Company / Unit" value={payload.unit.name} />
        <MetaCell label="Audit date" value={dateRangeLabel(payload)} />
        {/* "When the selected zones span several audits or auditors, show a date range and
            a comma-separated auditor list — do not silently pick one" (§4.3 item 2). */}
        <MetaCell label="Auditor name" value={payload.auditorNames.join(', ') || '—'} />
        <MetaCell
          label="Marks"
          value={formatMarks(payload.totals.rawScore, payload.totals.maxScore)}
        />
        <MetaCell label="Percentage" value={formatPercentage(payload.totals.scorePercentage)} />
        <MetaCell label="Rating" value={ratingLabel(payload, payload.totals.scorePercentage)} />
        <MetaCell label="Zones summarised" value={String(payload.zones.length)} />
        <MetaCell label="Scored zones" value={String(scored.length)} />
        <MetaCell label="Generated" value={formatDate(payload.generatedAt)} />
      </div>

      <h2 className="section-title">S-wise scoring</h2>
      <SectionBars sections={payload.sections} bands={payload.bands} />
      <SectionTable sections={payload.sections} bands={payload.bands} />
      {/* The colour key sits under the table whose percentages it colours. */}
      <RatingPills bands={payload.bands} />

      <h2 className="section-title">5S performance web — all selected zones</h2>
      <div className="radar-box">
        <RadarWeb sections={payload.sections} bands={payload.bands} brand={payload.brand} size={230} />
        <div className="caption">
          Each S shows summed achieved marks / summed applicable maximum; polygon uses
          percentage.
        </div>
      </div>

      <h2 className="section-title">Zone-wise marks per S</h2>
      <ZoneMatrix payload={payload} />

      <h2 className="section-title">Zone score comparison</h2>
      <ZoneComparisonBars
        zones={payload.zones.map((zone) => ({
          label: reportZoneLabel(zone),
          pct: zone.totals.scorePercentage,
        }))}
        bands={payload.bands}
        brand={payload.brand}
      />

      <div className="footnote">
        Cell colours follow the rating scale: green ≥ 90% Outstanding, blue 75–89% On Track,
        amber 60–74% Improving, red &lt; 60% Needs Support. NA answers are excluded from the
        applicable maximum.
      </div>

      {extras ? (
        <>
          <div className="two-col avoid-break">
            <div>
              <h2 className="section-title">Highest performing</h2>
              <table>
                <tbody>
                  {extras.highest.map((zone) => (
                    <tr key={`hi-${zone.zoneCode}`}>
                      <td>{reportZoneLabel(zone)}</td>
                      <td className={`num band-${bandOf(payload.bands, zone.pct)?.token ?? ''}`}>
                        {formatPercentage(zone.pct)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div>
              <h2 className="section-title">Lowest performing</h2>
              <table>
                <tbody>
                  {extras.lowest.map((zone) => (
                    <tr key={`lo-${zone.zoneCode}`}>
                      <td>
                        {reportZoneLabel(zone)}
                        {zone.weakestSection ? (
                          <span className="q-remark">
                            Weakest: {S_SECTION_SHORT_LABELS[zone.weakestSection]}
                          </span>
                        ) : null}
                      </td>
                      <td className={`num band-${bandOf(payload.bands, zone.pct)?.token ?? ''}`}>
                        {formatPercentage(zone.pct)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : null}

      <FlaggedPhotos payload={payload} resolve={resolve} />

      {/* At the end: each Zone's last six scores with their NCs, then the Unit by month. */}
      <div className="page-break" />
      <Header title="LEAN 5S — LAST SIX AUDITS" subtitle={payload.unit.name} />
      <HistoryTable payload={payload} />
      <RatingPills bands={payload.bands} />

      {extras?.monthly ? (
        <>
          <div className="page-break" />
          <Header title="LEAN 5S — MONTH-WISE UNIT SCORE" subtitle={payload.unit.name} />
          <h2 className="section-title">Unit score — month-wise</h2>
          <TrendBars
            points={extras.monthly.map((entry) => ({ label: monthLabel(entry.month), pct: entry.scorePercentage }))}
            bands={payload.bands}
            brand={payload.brand}
            width={680}
            height={320}
          />
          <div className="footnote">
            Each month is summed achieved marks / summed applicable maximum over every scored
            audit of the Unit finished that month. A month with no audit prints N/A.
          </div>
        </>
      ) : null}
    </>
  );
}

/**
 * §4.3 item 6: `ZONE | DEPARTMENT | 1S…5S | TOTAL | %`.
 *
 * Each S cell is `a/b` **tinted by its own band**, which is what makes the table readable
 * at a glance — a Zone at 61 % overall with one S at 30 % shows the weak S as a red cell
 * rather than hiding inside an amber row.
 */
function ZoneMatrix({ payload }: { payload: ReportPayload }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Zone</th>
          <th>Department</th>
          {S_SECTION_ORDER.map((section) => (
            <th key={section} className="centre">
              {S_SECTION_SHORT_LABELS[section]}
            </th>
          ))}
          <th className="centre">Total</th>
          <th className="centre">%</th>
        </tr>
      </thead>
      <tbody>
        {payload.zones.map((zone) => (
          <tr key={zone.auditZoneId}>
            <td>{reportZoneLabel(zone)}</td>
            <td>{zone.departmentName ?? '—'}</td>
            {S_SECTION_ORDER.map((section) => {
              const score = zone.sections.find((entry) => entry.section === section);
              const band = bandOf(payload.bands, score?.pct ?? null);
              return (
                <td
                  key={`${zone.auditZoneId}-${section}`}
                  className={`centre ${band ? `tint-${band.token}` : 'na'}`}
                >
                  {score ? `${score.raw}/${score.max}` : '—'}
                </td>
              );
            })}
            <td className="centre">
              {formatMarks(zone.totals.rawScore, zone.totals.maxScore)}
            </td>
            <td
              className={`centre ${
                bandOf(payload.bands, zone.totals.scorePercentage)?.token
                  ? `tint-${bandOf(payload.bands, zone.totals.scorePercentage)!.token}`
                  : 'na'
              }`}
            >
              {formatPercentage(zone.totals.scorePercentage)}
            </td>
          </tr>
        ))}
        <tr className="total-row">
          <td>All selected zones</td>
          <td>{payload.zones.length} zone(s)</td>
          {payload.sections.map((section) => (
            <td key={`total-${section.section}`} className="centre">
              {section.raw}/{section.max}
            </td>
          ))}
          <td className="centre">
            {formatMarks(payload.totals.rawScore, payload.totals.maxScore)}
          </td>
          <td className="centre">{formatPercentage(payload.totals.scorePercentage)}</td>
        </tr>
      </tbody>
    </table>
  );
}

/**
 * §10.3-C's flagged photos: **one optional GOOD and one optional NONCONFORMITY per Zone**
 * — exactly the `is_summary_flagged` evidence, omitted where the auditor flagged nothing.
 *
 * "Omitted where nothing was flagged" is the part worth being careful about: falling back
 * to "the first photo in the Zone" would quietly turn an editorial choice the auditor
 * declined to make into one the renderer made for them.
 */
function FlaggedPhotos({
  payload,
  resolve,
}: {
  payload: ReportPayload;
  resolve: ImageResolver;
}) {
  const rows = payload.zones
    .map((zone) => ({
      zone,
      good: zone.good.find((photo) => photo.isSummaryFlagged) ?? null,
      nonconformity: zone.nonconformities.find((photo) => photo.isSummaryFlagged) ?? null,
    }))
    .filter((row) => row.good || row.nonconformity);

  if (rows.length === 0) return null;

  return (
    <>
      <h2 className="section-title">Flagged photographs</h2>
      {rows.map(({ zone, good, nonconformity }) => (
        <div key={`flag-${zone.auditZoneId}`} className="avoid-break">
          <div className="photo-caption">{reportZoneLabel(zone)}</div>
          <div className="good-grid">
            {good ? (
              <div className="photo-card">
                <Photo photo={good} resolve={resolve} />
                <div className="photo-caption">
                  <span className="badge-good">✓ GOOD</span> {photoCaption(good)}
                </div>
                {good.remark ? <div className="photo-remark">{good.remark}</div> : null}
              </div>
            ) : (
              <div />
            )}
            {nonconformity ? (
              <div className="photo-card">
                <Photo photo={nonconformity} resolve={resolve} />
                <div className="photo-caption">
                  <span className="badge-nc">!</span> {photoCaption(nonconformity)}
                </div>
                {nonconformity.remark ? (
                  <div className="photo-remark">{nonconformity.remark}</div>
                ) : null}
              </div>
            ) : (
              <div />
            )}
          </div>
        </div>
      ))}
    </>
  );
}

/**
 * Each Zone's last six scored audits, latest in the right-hand column, and the NCs raised
 * over those audits with how many are closed (verified) — cumulative, so a Zone audited
 * once shows that audit's NCs and one audited six times shows all six audits'.
 */
function HistoryTable({ payload }: { payload: ReportPayload }) {
  const slots = [0, 1, 2, 3, 4, 5];
  return (
    <table>
      <thead>
        <tr>
          <th rowSpan={2}>Zone</th>
          <th colSpan={6} className="centre">
            Score — last six audits (oldest → latest)
          </th>
          <th colSpan={2} className="centre">
            NCs
          </th>
        </tr>
        <tr>
          {slots.map((slot) => (
            <th key={`h-${slot}`} className="centre">
              {slot + 1}
            </th>
          ))}
          <th className="centre">Raised</th>
          <th className="centre">Closed</th>
        </tr>
      </thead>
      <tbody>
        {payload.zones.map((zone) => {
          const history = zone.history ?? [];
          const padded = [...slots.slice(history.length).map(() => null), ...history.slice(-6)];
          return (
            <tr key={`hist-${zone.auditZoneId}`} className="avoid-break">
              <td>{reportZoneLabel(zone)}</td>
              {padded.map((point, index) => {
                const band = bandOf(payload.bands, point?.scorePercentage ?? null);
                return (
                  <td key={`${zone.auditZoneId}-${index}`} className={`centre ${band ? `tint-${band.token}` : 'na'}`}>
                    {point ? (
                      <>
                        {formatPercentage(point.scorePercentage)}
                        <span className="q-remark">{formatDate(point.auditDate)}</span>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                );
              })}
              <td className="centre">{zone.historyNcs?.raised ?? '—'}</td>
              <td className="centre">{zone.historyNcs?.closed ?? '—'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];

/** `2026-11` → `Nov 2026`. */
function monthLabel(key: string): string {
  return `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
}

function dateRangeLabel(payload: ReportPayload): string {
  if (!payload.auditDateRange) return '—';
  const { from, to } = payload.auditDateRange;
  const start = formatDate(from);
  const end = formatDate(to);
  return start === end ? start : `${start} – ${end}`;
}

/** Unused by the layout, exported so a reader can see which zone shape this file reads. */
export type SummaryZone = ReportZone;
