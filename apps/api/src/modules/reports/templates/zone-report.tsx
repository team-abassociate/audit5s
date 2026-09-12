import { S_SECTION_ORDER, S_SECTION_LABELS, sectionLabel } from '@audit5s/domain';
import type {
  ReportNonconformity,
  ReportPayload,
  ReportPhoto,
  ReportZone,
} from './payload-types';
import {
  Footer,
  Header,
  MetaCell,
  Photo,
  RadarWeb,
  RatingPills,
  SectionTable,
  formatDate,
  formatMarks,
  formatPercentage,
  photoCaption,
  ratingLabel,
  type ImageResolver,
} from './components';

/**
 * The Zone report — `INITIAL_ZONE` (HANDOFF.md §4.1) and `AFTER_EVIDENCE_ZONE` (§4.2).
 *
 * One template, not two. §4.2 is explicit that the after-evidence report is "identical to
 * 4.1 … with GOOD evidence **unchanged**", and the only honest way to guarantee a GOOD
 * photo is byte-identical between v1 and v2 is for one piece of code to draw it both
 * times. Two templates that were meant to agree would drift the first time one was
 * touched — and the test that asserts they match would then be testing a coincidence.
 *
 * The `after` flag changes exactly one thing: what fills a nonconformity's right half.
 */
export function ZoneReport({
  payload,
  resolve,
}: {
  payload: ReportPayload;
  resolve: ImageResolver;
}) {
  const zone = payload.zones[0];
  if (!zone) {
    return (
      <>
        <Header title="LEAN 5S — ZONE REPORT" subtitle="Zone-wise assessment" />
        <p>This report has no Zone.</p>
      </>
    );
  }

  const after = payload.kind === 'AFTER_EVIDENCE_ZONE';

  return (
    <>
      <Footer />
      <Header
        title={after ? 'LEAN 5S — AFTER-EVIDENCE ZONE REPORT' : 'LEAN 5S — ZONE REPORT'}
        subtitle="Zone-wise assessment"
      />

      {/* §4.1 item 2: 3 × 3, small grey caps labels over bold values. */}
      <div className="meta-grid">
        <MetaCell label="Company / Unit" value={payload.unit.name} />
        <MetaCell label="Department" value={zone.departmentName ?? '—'} />
        <MetaCell label="Zone" value={`Zone ${zone.zoneCode} — ${zone.zoneName}`} />
        <MetaCell label="Audit date" value={formatDate(zone.auditDate)} />
        <MetaCell label="Auditor name" value={`${zone.auditorName} (${zone.auditorLoginId})`} />
        <MetaCell label="Zone leader" value={zone.zoneLeaderName ?? '—'} />
        <MetaCell label="Marks" value={formatMarks(zone.totals.rawScore, zone.totals.maxScore)} />
        <MetaCell label="Percentage" value={formatPercentage(zone.totals.scorePercentage)} />
        <MetaCell label="Rating" value={ratingLabel(payload, zone.totals.scorePercentage)} />
      </div>

      <h2 className="section-title">S-wise scoring</h2>
      <SectionTable sections={zone.sections} bands={payload.bands} />

      {/* §4.1 item 4: the web, with the AUDITOR VERIFICATION box to its left. */}
      <div className="web-row">
        <div className="verification">
          <h2 className="section-title">Auditor verification</h2>
          {payload.audit?.selfieObjectKey ? (
            <SelfieImage objectKey={payload.audit.selfieObjectKey} resolve={resolve} />
          ) : (
            <div className="redacted">No selfie on record</div>
          )}
          <div className="caption">{zone.auditorName}</div>
        </div>
        <div className="radar-box">
          <h2 className="section-title">5S performance web</h2>
          <RadarWeb sections={zone.sections} brand={payload.brand} />
          <div className="caption">
            Each S shows achieved marks / applicable maximum; polygon uses percentage.
          </div>
        </div>
      </div>

      <RatingPills bands={payload.bands} />

      <h2 className="section-title">Checklist — responses and marks</h2>
      <ChecklistTable zone={zone} payload={payload} />

      {zone.zoneRemark ? (
        <>
          <h2 className="section-title">Zone remark</h2>
          <div className="zone-remark">{zone.zoneRemark}</div>
        </>
      ) : null}

      {zone.good.length > 0 ? (
        <>
          <h2 className="section-title">Good evidence</h2>
          {/* §4.1: two per row, side by side. Identical in v1 and v2 (§4.2). */}
          <div className="good-grid">
            {zone.good.map((photo) => (
              <GoodPhotoCard key={photo.evidenceId} photo={photo} resolve={resolve} />
            ))}
          </div>
        </>
      ) : null}

      {zone.nonconformities.length > 0 ? (
        <>
          <h2 className="section-title">Nonconformities</h2>
          {zone.nonconformities.map((item) => (
            <NonconformityRow
              key={item.evidenceId}
              item={item}
              resolve={resolve}
              after={after}
            />
          ))}
        </>
      ) : null}

      {after && payload.closure ? <ClosureSummary payload={payload} /> : null}

      <div className="footnote">
        NA is excluded from the applicable maximum. After-improvement evidence is managed
        separately and does not change these marks.
      </div>
    </>
  );
}

function SelfieImage({ objectKey, resolve }: { objectKey: string; resolve: ImageResolver }) {
  const source = resolve(objectKey);
  return source ? (
    <img className="selfie" src={source} alt="" />
  ) : (
    <div className="redacted">Photo removed</div>
  );
}

/**
 * §4.1 item 6: `Sr. | Check Point | Response | Marks`, each section opening with a maroon
 * header row carrying its subtotal, and the optional per-question remark as a second,
 * smaller line under the question text.
 */
function ChecklistTable({ zone, payload }: { zone: ReportZone; payload: ReportPayload }) {
  return (
    <table>
      <thead>
        <tr>
          <th style={{ width: '8%' }}>Sr.</th>
          <th>Check point</th>
          <th style={{ width: '22%' }}>Response</th>
          <th style={{ width: '10%' }} className="centre">
            Marks
          </th>
        </tr>
      </thead>
      <tbody>
        {S_SECTION_ORDER.map((section) => {
          const score = zone.sections.find((entry) => entry.section === section);
          const questions = zone.questions.filter((question) => question.section === section);
          if (questions.length === 0 && !score) return null;
          return [
            <tr className="section-row" key={`head-${section}`}>
              <td colSpan={3}>{sectionLabel(section)}</td>
              <td className="centre">{formatMarks(score?.raw ?? 0, score?.max ?? 0)}</td>
            </tr>,
            ...questions.map((question) => {
              const token = question.value ? payload.responseTokens[question.value] : undefined;
              return (
                <tr key={`q-${question.globalOrder}`}>
                  <td className="centre">{question.globalOrder}</td>
                  <td>
                    {question.text}
                    {question.remark ? <span className="q-remark">{question.remark}</span> : null}
                  </td>
                  <td className={question.value ? `response-${question.value}` : 'na'}>
                    {token?.label ?? '—'}
                  </td>
                  <td className="centre">
                    {question.value === 'NA' ? 'NA' : (question.marks ?? '—')}
                  </td>
                </tr>
              );
            }),
          ];
        })}
        <tr className="total-row">
          <td colSpan={2}>Zone total</td>
          <td className="num">{formatMarks(zone.totals.rawScore, zone.totals.maxScore)}</td>
          <td className="centre">{formatPercentage(zone.totals.scorePercentage)}</td>
        </tr>
      </tbody>
    </table>
  );
}

function GoodPhotoCard({ photo, resolve }: { photo: ReportPhoto; resolve: ImageResolver }) {
  return (
    <div className="photo-card">
      <Photo photo={photo} resolve={resolve} />
      <div className="photo-caption">
        <span className="badge-good">✓ GOOD</span> {photoCaption(photo)}
      </div>
      {photo.remark ? <div className="photo-remark">{photo.remark}</div> : null}
    </div>
  );
}

/**
 * One nonconformity: photo **left-aligned in the left half**, the right half either
 * deliberately empty (initial) or carrying the outcome (after-evidence).
 *
 * The initial report's right half is a light placeholder frame with **no text whatsoever**
 * (§10.3-A / §4.1). That is not a stylistic preference — the sample reports are printed
 * and written on by hand, and a caption there would sit where the after-photo goes.
 */
function NonconformityRow({
  item,
  resolve,
  after,
}: {
  item: ReportNonconformity;
  resolve: ImageResolver;
  after: boolean;
}) {
  return (
    <div className="nc-row">
      <div className="photo-card">
        <Photo photo={item} resolve={resolve} />
        <div className="photo-caption">
          <span className="badge-nc">!</span> {photoCaption(item)}
        </div>
        {item.remark ? <div className="photo-remark">{item.remark}</div> : null}
        {item.correctiveActionUrl ? (
          <a className="cta" href={item.correctiveActionUrl}>
            View / Submit Corrective Action ▸
          </a>
        ) : null}
      </div>
      {after ? <Outcome item={item} resolve={resolve} /> : <div className="nc-placeholder" />}
    </div>
  );
}

/** §4.2 / §10.3-B: Option A, Option B, or Pending with the deadline. */
function Outcome({ item, resolve }: { item: ReportNonconformity; resolve: ImageResolver }) {
  const outcome = item.outcome;

  if (!outcome) {
    return (
      <div className="nc-answer">
        <div className="photo-caption">
          <span className="badge-pending">PENDING</span>
        </div>
        <div className="photo-remark">
          {item.dueAt ? `Due ${formatDate(item.dueAt)}` : 'No deadline set'}
        </div>
      </div>
    );
  }

  if (outcome.option === 'NOT_POSSIBLE') {
    return (
      <div className="nc-answer">
        <div className="photo-caption">
          <span className="badge-not-possible">NOT POSSIBLE</span>
        </div>
        <div className="photo-remark">{outcome.explanation}</div>
        <div className="photo-remark">
          {outcome.submittedByName} · {formatDate(outcome.submittedAt)}
          {outcome.verified ? ' · ✓ Accepted' : ''}
        </div>
      </div>
    );
  }

  return (
    <div className="nc-answer">
      {outcome.afterPhoto ? <Photo photo={outcome.afterPhoto} resolve={resolve} /> : null}
      <div className="photo-caption">
        AFTER PHOTO
        {outcome.verified ? <span className="badge-verified"> ✓ VERIFIED</span> : null}
      </div>
      <div className="photo-remark">
        Submitted by {outcome.submittedByName} · {formatDate(outcome.submittedAt)}
      </div>
      {outcome.description ? <div className="photo-remark">{outcome.description}</div> : null}
    </div>
  );
}

function ClosureSummary({ payload }: { payload: ReportPayload }) {
  const closure = payload.closure!;
  return (
    <>
      <h2 className="section-title">Closure summary</h2>
      <div className="closure-grid">
        <MetaCell label="Nonconformities" value={String(closure.nonconformities)} />
        <MetaCell label="Closed" value={String(closure.closed)} />
        <MetaCell label="Not possible" value={String(closure.notPossible)} />
        <MetaCell label="Open" value={String(closure.open)} />
        <MetaCell label="Closure rate" value={formatPercentage(closure.closureRatePercentage)} />
      </div>
      {closure.averageClosureHours !== null ? (
        <div className="caption">
          Average closure time: {(closure.averageClosureHours / 24).toFixed(1)} days.
        </div>
      ) : null}
    </>
  );
}

/** Exported for the layout tests, which assert the §4.1 labels rather than the markup. */
export const ZONE_SECTION_LABELS = S_SECTION_LABELS;
