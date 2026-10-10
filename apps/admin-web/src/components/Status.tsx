import type { ReactNode } from 'react';
import type {
  AssignmentStatus,
  AuditStatus,
  AuditZoneStatus,
  ChecklistVersionStatus,
  CorrectiveActionStatus,
  KaizenStatus,
  UserStatus,
} from '@audit5s/contracts';
import { bandFor } from '@audit5s/domain';
import { bandOf } from '@/lib/bands';
import { cn } from '@/lib/cn';
import {
  ACTION_STATUS_LABEL,
  ASSIGNMENT_STATUS_LABEL,
  AUDIT_STATUS_LABEL,
  CHECKLIST_VERSION_STATUS_LABEL,
  KAIZEN_STATUS_LABEL,
  USER_STATUS_LABEL,
  ZONE_STATUS_LABEL,
} from '@/lib/labels';

/**
 * Where a piece of work stands, as a shape. Seven, so each one can be learned:
 *
 * | shape | glyph | means | e.g. |
 * |---|---|---|---|
 * | `open` | ○ | waiting to be started | Assigned, Open, Draft |
 * | `progress` | ◐ | under way | In progress, Submitted, Partly closed |
 * | `paused` | ‖ | stopped, will resume | Paused |
 * | `done` | ✓ | finished | Completed, Closed, Published |
 * | `attention` | ! | needs someone | Reopened, Not possible, Locked |
 * | `ended` | ✕, dashed edge | over without finishing | Cancelled, Withdrawn, Archived |
 * | `active` | ● | in force | Active |
 */
export type StatusShape = 'open' | 'progress' | 'paused' | 'done' | 'attention' | 'ended' | 'active';

const AUDIT: Record<AuditStatus, StatusShape> = {
  ASSIGNED: 'open',
  READY: 'open',
  IN_PROGRESS: 'progress',
  PAUSED: 'paused',
  COMPLETED: 'done',
  CORRECTIVE_ACTION_OPEN: 'progress',
  PARTIALLY_CLOSED: 'progress',
  CLOSED: 'done',
  CANCELLED: 'ended',
};
const ZONE: Record<AuditZoneStatus, StatusShape> = {
  DRAFT: 'open',
  IN_PROGRESS: 'progress',
  COMPLETED: 'done',
  WITHDRAWN: 'ended',
};
const ASSIGNMENT: Record<AssignmentStatus, StatusShape> = {
  ASSIGNED: 'open',
  ACCEPTED: 'open',
  IN_PROGRESS: 'progress',
  COMPLETED: 'done',
  CANCELLED: 'ended',
  EXPIRED: 'ended',
};
const ACTION: Record<CorrectiveActionStatus, StatusShape> = {
  OPEN: 'open',
  ACTION_SUBMITTED: 'progress',
  NOT_POSSIBLE: 'attention',
  VERIFIED: 'done',
  REOPENED: 'attention',
  WITHDRAWN: 'ended',
};
const CHECKLIST: Record<ChecklistVersionStatus, StatusShape> = {
  DRAFT: 'open',
  PUBLISHED: 'done',
  SUPERSEDED: 'ended',
  ARCHIVED: 'ended',
};
const USER: Record<UserStatus, StatusShape> = {
  INVITED: 'open',
  ACTIVE: 'active',
  DISABLED: 'ended',
  LOCKED: 'attention',
};

const KAIZEN: Record<KaizenStatus, StatusShape> = {
  DRAFT: 'open',
  SUBMITTED: 'progress',
  APPROVED: 'done',
  SENT_BACK: 'attention',
  REJECTED: 'ended',
};

/**
 * Kaizen's exception to "ink, never a band colour": its three decisions are told apart by
 * colour on every screen (owner, 2026-10-10) — Approved green, Sent back amber, Rejected red,
 * and waiting teal, a colour no decision uses. The same as the phone's `KAIZEN_STATUS_TONE`.
 */
export const KAIZEN_TONE: Record<KaizenStatus, 'ok' | 'warn' | 'crit' | 'accent' | null> = {
  DRAFT: null,
  SUBMITTED: 'accent',
  APPROVED: 'ok',
  SENT_BACK: 'warn',
  REJECTED: 'crit',
};

type StatusChipProps =
  | { kind: 'audit'; status: AuditStatus }
  | { kind: 'zone'; status: AuditZoneStatus }
  | { kind: 'assignment'; status: AssignmentStatus }
  | { kind: 'action'; status: CorrectiveActionStatus }
  | { kind: 'checklist'; status: ChecklistVersionStatus }
  | { kind: 'user'; status: UserStatus }
  | { kind: 'kaizen'; status: KaizenStatus }
  /** Anything that is not one of the enums above: say the shape and the word. */
  | { shape: StatusShape; children: ReactNode };

function resolve(props: StatusChipProps): { shape: StatusShape; label: ReactNode } {
  if ('shape' in props) return { shape: props.shape, label: props.children };
  switch (props.kind) {
    case 'audit':
      return { shape: AUDIT[props.status], label: AUDIT_STATUS_LABEL[props.status] };
    case 'zone':
      return { shape: ZONE[props.status], label: ZONE_STATUS_LABEL[props.status] };
    case 'assignment':
      return { shape: ASSIGNMENT[props.status], label: ASSIGNMENT_STATUS_LABEL[props.status] };
    case 'action':
      return { shape: ACTION[props.status], label: ACTION_STATUS_LABEL[props.status] };
    case 'checklist':
      return { shape: CHECKLIST[props.status], label: CHECKLIST_VERSION_STATUS_LABEL[props.status] };
    case 'user':
      return { shape: USER[props.status], label: USER_STATUS_LABEL[props.status] };
    case 'kaizen':
      return { shape: KAIZEN[props.status], label: KAIZEN_STATUS_LABEL[props.status] };
  }
}

/**
 * A workflow status: an outlined chip in **ink**, with a shape glyph before the word (G12).
 * Never a band colour — green, amber and red mean a score band and nothing else (GEMBA §2.6),
 * so "Completed" is not green and "Cancelled" is not red. The word comes from
 * `lib/labels.ts`, so a status reads the same on every screen.
 *
 *     <StatusChip kind="audit" status={audit.status} />
 *     <StatusChip shape="ended">Archived</StatusChip>
 */
export function StatusChip(props: StatusChipProps) {
  const { shape, label } = resolve(props);
  return (
    <span
      className={cn(
        'gb-chip gb-status',
        `gb-status--${shape}`,
        'kind' in props && props.kind === 'kaizen' && KAIZEN_TONE[props.status] && `gb-tone--${KAIZEN_TONE[props.status]}`,
      )}
    >
      <StatusGlyph shape={shape} />
      {label}
    </span>
  );
}

/** Drawn, not typed: a glyph from a fallback font would be a third typeface. */
function StatusGlyph({ shape }: { shape: StatusShape }) {
  return (
    <svg className="gb-status-glyph" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
      {shape === 'open' ? <circle cx="5" cy="5" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.6" /> : null}
      {shape === 'progress' ? (
        <>
          <circle cx="5" cy="5" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M5 1.4 A3.6 3.6 0 0 1 5 8.6 Z" fill="currentColor" />
        </>
      ) : null}
      {shape === 'paused' ? (
        <>
          <rect x="2" y="1.5" width="2.2" height="7" fill="currentColor" />
          <rect x="5.8" y="1.5" width="2.2" height="7" fill="currentColor" />
        </>
      ) : null}
      {shape === 'done' ? (
        <path d="M1.5 5.2 L4 7.6 L8.6 2.4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" />
      ) : null}
      {shape === 'attention' ? (
        <>
          <rect x="4" y="0.8" width="2" height="5.6" fill="currentColor" />
          <rect x="4" y="7.6" width="2" height="1.8" fill="currentColor" />
        </>
      ) : null}
      {shape === 'ended' ? (
        <path d="M2 2 L8 8 M8 2 L2 8" fill="none" stroke="currentColor" strokeWidth="1.6" />
      ) : null}
      {shape === 'active' ? <circle cx="5" cy="5" r="3.8" fill="currentColor" /> : null}
    </svg>
  );
}

/**
 * A score's band, readable three ways at once (B2, GEMBA §2.8 and §3): the R-6b word, the band
 * colour, and a shape — ▲ Outstanding, ● On Track, ◆ Improving, ▼ Needs Support. The two upper
 * bands share `--ok`, so the word and the shape are what tell them apart. A fully-`NA` score
 * (`null`) is not a band: it reads `N/A` on the hatch, never "Needs Support".
 *
 * Plain text, not a bordered chip: a label is not a button (B10). The band is always computed
 * from the raw value here, never from a rounded string.
 */
export function BandLabel({ score, className }: { score: number | null; className?: string }) {
  const band = bandFor(score);
  if (!band) {
    return (
      <span className={cn('gb-bandlabel gb-bandlabel--none', className)}>
        <span className="gb-bandlabel-na gb-na" aria-hidden="true" />
        N/A
      </span>
    );
  }
  const tone = bandOf(score);
  return (
    <span className={cn('gb-bandlabel', `gb-text-${tone}`, className)}>
      <svg className="gb-bandlabel-glyph" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
        {band.token === 'band-outstanding' ? <path d="M5 1 L9.4 9 L0.6 9 Z" /> : null}
        {band.token === 'band-on-track' ? <circle cx="5" cy="5" r="4.2" /> : null}
        {band.token === 'band-improving' ? <path d="M5 0.6 L9.4 5 L5 9.4 L0.6 5 Z" /> : null}
        {band.token === 'band-needs-support' ? <path d="M0.6 1 L9.4 1 L5 9 Z" /> : null}
      </svg>
      {band.label}
    </span>
  );
}
