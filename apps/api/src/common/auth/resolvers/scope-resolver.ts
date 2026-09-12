import { sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { ScopeResolverName } from '@audit5s/contracts';
import type { ActorContext, ScopeContext } from '@audit5s/domain';

/**
 * The columns a resolver may reference. A table hands over whichever it has; a resolver
 * that needs one the table lacks fails loudly at wiring time rather than silently
 * returning a predicate that matches everything.
 */
export interface ScopeColumns {
  /** The tenancy anchor. Every business table reaches one in ≤2 hops (§12.5). */
  unitId?: PgColumn;
  /** The auditor who owns an audit, for `own_audits`. */
  ownerUserId?: PgColumn;
  /** The subject of a personal record, for `own_record`. */
  recordUserId?: PgColumn;
  /** The Zone Leader a corrective action is assigned to, for `assigned_actions`. */
  assignedUserId?: PgColumn;
  /** The corrective action's own primary key, for `signed_token`'s single-item audience. */
  correctiveActionId?: PgColumn;
}

/**
 * A scope resolver returns a **SQL predicate, not a boolean** (ARCHITECTURE.md §6.1).
 *
 * That is the whole point: list endpoints and single-row endpoints share one definition,
 * so "which rows may I list" and "may I read this row" cannot diverge.
 */
export interface ScopeResolver {
  readonly name: ScopeResolverName;
  /**
   * `scope` is the third argument rather than the first for one reason: every resolver
   * written before Phase 7 needs only the actor, and TypeScript's structural typing lets
   * those two-parameter implementations satisfy this signature unchanged. `signed_token`
   * is the first resolver whose predicate depends on something that is not a property of
   * the person — a link they are holding — and it reads it from here.
   */
  predicate(actor: ActorContext, columns: ScopeColumns, scope?: ScopeContext): SQL;
}

/** Matches nothing. Used wherever an actor has no qualifying scope value. */
export const MATCH_NOTHING: SQL = sql`false`;

export function requireColumn(
  columns: ScopeColumns,
  key: keyof ScopeColumns,
  resolver: ScopeResolverName,
): PgColumn {
  const column = columns[key];
  if (!column) {
    throw new Error(
      `Scope resolver '${resolver}' needs the '${key}' column, which this table did not provide`,
    );
  }
  return column;
}
