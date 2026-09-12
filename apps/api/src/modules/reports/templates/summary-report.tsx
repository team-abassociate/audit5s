import { S_SECTION_ORDER, S_SECTION_SHORT_LABELS } from '@audit5s/domain';
import type { ReportPayload, ReportZone } from './payload-types';
import {
  Footer,
  Header,
  MetaCell,
  Photo,
  RadarWeb,
  RatingPills,
  SectionTable,
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
 * The multi-Zone summary (HANDOFF.md §4.3, ARCHITECTURE.md §10.3-C).
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
        <MetaCell label="Company / Unit" value={`${payload.unit.name} (${payload.unit.code})`} />
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
      <SectionTable sections={payload.sections} bands={payload.bands} />

      <h2 className="section-title">5S performance web — all selected zones</h2>
      <div className="radar-box">
        <RadarWeb sections={payload.sections} brand={payload.brand} size={210} />
        <div className="caption">
          Each S shows summed achieved marks / summed applicable maximum; polygon uses
          percentage.
        </div>
      </div>

      <RatingPills bands={payload.bands} />

      <h2 className="section-title">Zone-wise marks per S</h2>
      <ZoneMatrix payload={payload} />

      <h2 className="section-title">Zone score comparison</h2>
      <ZoneComparisonBars
        zones={payload.zones.map((zone) => ({
          zoneCode: zone.zoneCode,
          zoneName: zone.zoneName,
          pct: zone.totals.scorePercentage,
        }))}
        bands={payload.bands}
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
                      <td>
                        {zone.zoneCode} — {zone.zoneName}
                      </td>
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
                        {zone.zoneCode} — {zone.zoneName}
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

          <h2 className="section-title">Score band distribution</h2>
          <div className="closure-grid">
            {extras.histogram.map((entry) => (
              <MetaCell key={entry.token} label={entry.label} value={String(entry.count)} />
            ))}
          </div>

          <h2 className="section-title">Nonconformity summary</h2>
          <div className="closure-grid">
            <MetaCell label="Open" value={String(extras.nonconformitySummary.open)} />
            <MetaCell label="Submitted" value={String(extras.nonconformitySummary.submitted)} />
            <MetaCell label="Verified" value={String(extras.nonconformitySummary.verified)} />
          </div>
          {extras.nonconformitySummary.recurrent.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th style={{ width: '8%' }}>Sr.</th>
                  <th>Recurrent check point</th>
                  <th style={{ width: '14%' }} className="centre">
                    Zones
                  </th>
                </tr>
              </thead>
              <tbody>
                {extras.nonconformitySummary.recurrent.map((entry) => (
                  <tr key={`rec-${entry.questionGlobalOrder}`}>
                    <td className="centre">{entry.questionGlobalOrder ?? '—'}</td>
                    <td>{entry.questionText ?? '—'}</td>
                    <td className="centre">{entry.zones}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </>
      ) : null}

      <FlaggedPhotos payload={payload} resolve={resolve} />
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
            <td>
              {zone.zoneCode} — {zone.zoneName}
            </td>
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
          <div className="photo-caption">
            Zone {zone.zoneCode} — {zone.zoneName}
          </div>
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

function dateRangeLabel(payload: ReportPayload): string {
  if (!payload.auditDateRange) return '—';
  const { from, to } = payload.auditDateRange;
  const start = formatDate(from);
  const end = formatDate(to);
  return start === end ? start : `${start} – ${end}`;
}

/** Unused by the layout, exported so a reader can see which zone shape this file reads. */
export type SummaryZone = ReportZone;
