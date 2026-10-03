import type { ReactNode } from 'react';

/**
 * Nothing to show — said plainly, with the way out beside it (CA5, I3). The title states the
 * fact in the screen's words ("No archived industries."); `children` adds one line of why or
 * what next; `action` holds the control that changes it ("Clear filters", "Add an industry").
 *
 * Only for a query that has answered. While it is still loading, render a `Skeleton`: an
 * empty state shown before the data arrives is a false statement (B8).
 *
 * It is a status region, so a filter that empties the list is announced, not just drawn.
 */
export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="gb-emptystate" role="status">
      <div className="min-w-0">
        <p className="gb-emptystate-title">{title}</p>
        {children ? <p className="gb-emptystate-text">{children}</p> : null}
      </div>
      {action ? <div className="gb-emptystate-action">{action}</div> : null}
    </div>
  );
}
