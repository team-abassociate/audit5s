import { S_SECTION_ORDER, S_SECTION_LABELS, reportZoneLabel, sectionLabel } from '@audit5s/domain';
import type {
  ReportNonconformity,
  ReportOutcome,
  ReportOverallAction,
  ReportPayload,
  ReportPhoto,
  ReportReview,
  ReportZone,
  Role,
} from './payload-types';
import {
  CorrectiveActionLink,
  Footer,
  Header,
  MetaCell,
  Photo,
  RadarWeb,
  RatingPills,
  SectionTable,
  bandOf,
  formatDate,
  formatMarks,
  formatPercentage,
  photoCaption,
  ratingLabel,
  type ImageResolver,
} from './components';

/**
 * The Zone report — `INITIAL_ZONE` and `AFTER_EVIDENCE_ZONE`.
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
        {/* Named as the summary names it: "Zone 1 — Press Shop", the auditor's own words. */}
        <MetaCell label="Zone" value={reportZoneLabel(zone)} />
        <MetaCell label="Audit date" value={formatDate(zone.auditDate)} />
        <MetaCell label="Auditor name" value={`${zone.auditorName} (${zone.auditorLoginId})`} />
        <MetaCell label="Zone leader" value={zone.zoneLeaderName ?? '—'} />
        <MetaCell label="Marks" value={formatMarks(zone.totals.rawScore, zone.totals.maxScore)} />
        <MetaCell label="Percentage" value={formatPercentage(zone.totals.scorePercentage)} />
        <MetaCell label="Rating" value={ratingLabel(payload, zone.totals.scorePercentage)} />
      </div>

      <h2 className="section-title">S-wise scoring</h2>
      <SectionTable sections={zone.sections} bands={payload.bands} />
      {/* The colour key sits under the table whose percentages it colours. */}
      <RatingPills bands={payload.bands} />

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
          <RadarWeb sections={zone.sections} bands={payload.bands} brand={payload.brand} size={220} />
          <div className="caption">
            Each S shows achieved marks / applicable maximum; polygon uses percentage.
          </div>
        </div>
      </div>

      {/* The checklist opens its own page, so its first rows never trail page 1. */}
      <h2 className="section-title page-break">Checklist — responses and marks</h2>
      <ChecklistTable zone={zone} payload={payload} />

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

      {/*
        R-38: after the photo evidence, the auditor's overall remark and then their overall
        corrective-action suggestions — what the auditor found that no photograph shows.
      */}
      {zone.zoneRemark ? (
        <>
          <h2 className="section-title">Auditor's overall remark</h2>
          <div className="zone-remark">{zone.zoneRemark}</div>
        </>
      ) : null}

      {/* Absent on a payload frozen before R-38, which renders as it was issued. */}
      {(zone.overallActions ?? []).length > 0 ? (
        <>
          <h2 className="section-title">Overall corrective action suggestions</h2>
          {zone.overallActions.map((action) => (
            <OverallActionRow
              key={action.correctiveActionId}
              action={action}
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
 * §4.1 item 6: `Sr. | Check Point | Response | Marks`, each section opening with a panel
 * header row carrying its subtotal — tinted by that section's own band, the same rule the
 * S-wise table and the Zone-wise matrix use — and the optional per-question remark as a
 * second, smaller line under the question text.
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
          const band = bandOf(payload.bands, score?.pct ?? null);
          return [
            <tr className="section-row" key={`head-${section}`}>
              <td colSpan={3}>{sectionLabel(section)}</td>
              <td className={`centre ${band ? `band-${band.token}` : 'na'}`}>
                {formatMarks(score?.raw ?? 0, score?.max ?? 0)}
              </td>
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
                  <td className={`centre ${question.value ? `response-${question.value}` : 'na'}`}>
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
          <td
            className={`centre ${
              bandOf(payload.bands, zone.totals.scorePercentage)
                ? `band-${bandOf(payload.bands, zone.totals.scorePercentage)!.token}`
                : 'na'
            }`}
          >
            {formatPercentage(zone.totals.scorePercentage)}
          </td>
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
          <CorrectiveActionLink url={item.correctiveActionUrl} />
        ) : null}
      </div>
      {after ? <Outcome item={item} resolve={resolve} /> : <div className="nc-placeholder" />}
    </div>
  );
}

/**
 * R-38: one overall suggestion, laid out as a nonconformity is — the suggestion and its link
 * on the left where the photo would be, the right half reserved (initial) or answered
 * (after-evidence) by the same rule, so a reader learns one layout, not two.
 */
function OverallActionRow({
  action,
  resolve,
  after,
}: {
  action: ReportOverallAction;
  resolve: ImageResolver;
  after: boolean;
}) {
  return (
    <div className="nc-row">
      <div className="photo-card">
        <div className="photo-caption">
          <span className="badge-overall">OVERALL {action.suggestionNo}</span>
        </div>
        <div className="overall-text">{action.suggestion}</div>
        {action.correctiveActionUrl ? (
          <CorrectiveActionLink
            url={action.correctiveActionUrl}
            hint="Describe what was done; a photograph is optional. No app or login needed."
          />
        ) : null}
      </div>
      {after ? <Outcome item={action} resolve={resolve} /> : <div className="nc-placeholder" />}
    </div>
  );
}

/**
 * §4.2 / §10.3-B: Option A, Option B, or Pending with the deadline — and R-43's review.
 *
 * A Zone Leader's closure is **closed**, not verified: nobody checked it unless a reviewer
 * approved it, and the row says which. A disapproved answer is not printed; the row says who
 * disapproved it and why, and that a new answer is awaited. `review` is absent from a payload
 * frozen before R-43, and the row then prints no review line at all rather than a guess.
 */
function Outcome({
  item,
  resolve,
}: {
  item: { outcome: ReportOutcome | null; dueAt: string | null; review?: ReportReview | null };
  resolve: ImageResolver;
}) {
  const outcome = item.outcome;
  const review = item.review;
  const due = item.dueAt ? `Due ${formatDate(item.dueAt)}` : 'No deadline set';

  if (!outcome) {
    if (review?.verdict === 'DISAPPROVED') {
      return (
        <div className="nc-answer">
          <div className="photo-caption">
            <span className="badge-disapproved">✕ DISAPPROVED</span>
          </div>
          <div className="photo-remark">{reviewLine(review)}</div>
          {review.comment ? <div className="photo-remark">Reason: {review.comment}</div> : null}
          <div className="photo-remark">Awaiting a new answer. {due}</div>
        </div>
      );
    }
    return (
      <div className="nc-answer">
        <div className="photo-caption">
          <span className="badge-pending">PENDING</span>
        </div>
        <div className="photo-remark">{due}</div>
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
          {review === undefined && outcome.verified ? ' · ✓ Accepted' : ''}
        </div>
        {review === undefined ? null : (
          <div className="photo-remark">
            {review?.verdict === 'APPROVED' ? `✓ ${reviewLine(review)}` : 'Awaiting review'}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="nc-answer">
      {outcome.afterPhoto ? <Photo photo={outcome.afterPhoto} resolve={resolve} /> : null}
      <div className="photo-caption">
        {/* An overall action may be answered without a photograph (R-38). */}
        {outcome.afterPhoto ? 'AFTER PHOTO' : 'ACTION TAKEN'}
        {outcome.verified ? <span className="badge-verified"> ✓ CLOSED</span> : null}
      </div>
      <div className="photo-remark">
        Submitted by {outcome.submittedByName} · {formatDate(outcome.submittedAt)}
      </div>
      {outcome.description ? <div className="photo-remark">{outcome.description}</div> : null}
      {review === undefined ? null : (
        <div className="photo-remark">
          {review?.verdict === 'APPROVED' ? `✓ ${reviewLine(review)}` : 'Not reviewed'}
        </div>
      )}
    </div>
  );
}

const REVIEWER_ROLE: Partial<Record<Role, string>> = {
  SUPER_ADMIN: 'Super Admin',
  COORDINATOR: 'Coordinator',
};

/** "Approved by Asha Patil (Coordinator), 3 Oct 2026". */
function reviewLine(review: ReportReview): string {
  const verb = review.verdict === 'APPROVED' ? 'Approved' : 'Disapproved';
  const role = review.reviewerRole ? REVIEWER_ROLE[review.reviewerRole] : undefined;
  const who = review.reviewerName ?? 'a reviewer';
  return `${verb} by ${who}${role ? ` (${role})` : ''}, ${formatDate(review.reviewedAt)}`;
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
