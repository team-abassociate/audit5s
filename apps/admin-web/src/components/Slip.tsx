import type { ReactNode } from 'react';

/**
 * The confirmation slip (GEMBA-BOARD.md §6 "Confirmation"): a strip at the top of the page
 * body that says, in the words of what actually happened, what an action did — "Hospital
 * archived. Its checklists are offered to every industry again." Never a toast, never a claim
 * the system did not make, and at most one per view (§2.7).
 *
 * It slides down 8px and fades in over 180ms; under reduced motion it only fades. It leaves at
 * once on dismiss. A status region, so it is announced.
 */
export function Slip({
  title,
  children,
  onDismiss,
}: {
  title: string;
  children?: ReactNode;
  onDismiss?: () => void;
}) {
  return (
    <div className="gb-slip gb-slip--arrive" role="status">
      <div className="gb-slip-row">
        <div className="min-w-0">
          <b>{title}</b>
          {children ? <p>{children}</p> : null}
        </div>
        {onDismiss ? (
          <button type="button" className="gb-btn gb-btn--sm" onClick={onDismiss}>
            Dismiss
          </button>
        ) : null}
      </div>
    </div>
  );
}
