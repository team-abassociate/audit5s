import { and, type SQL } from 'drizzle-orm';
import type { Database, Transaction } from '@audit5s/db';
import type { ScopeContext } from '@audit5s/domain';
import type { ScopeColumns, ScopeResolverRegistry } from '../auth/resolvers';

/**
 * The base every repository extends.
 *
 * AZ-1: **no repository method may execute without a scope predicate.** That is enforced
 * three ways, and all three matter:
 *
 *   1. `scoped()` requires an explicit `ScopeContext` argument — there is no default and
 *      no ambient fallback, so forgetting it is a type error, not a silent full-table read.
 *   2. An ESLint rule forbids constructing a Drizzle query anywhere but a `*.repository.ts`,
 *      so no service can route around this class.
 *   3. RLS in the database refuses the rows anyway if the request context was never set.
 *
 * The predicate comes from the resolver PART 6 grants for the actor's role, never from
 * anything the client sent (AZ-2): a `unitId` in a query string is intersected with scope,
 * it is not a grant.
 */
export abstract class BaseRepository {
  protected constructor(
    protected readonly db: Database,
    private readonly resolvers: ScopeResolverRegistry,
  ) {}

  /**
   * The scope predicate for this request, optionally intersected with caller filters.
   *
   * Filters are ANDed, never ORed: a client-supplied filter can only ever narrow what the
   * actor may already see.
   */
  protected scoped(scope: ScopeContext, columns: ScopeColumns, ...filters: Array<SQL | undefined>): SQL {
    const resolver = this.resolvers.get(scope.resolver);
    const predicate = resolver.predicate(scope.actor, columns, scope);
    const conditions = [predicate, ...filters.filter((f): f is SQL => f !== undefined)];
    return and(...conditions) as SQL;
  }

  /** Runs `work` inside a transaction. Repositories compose; services do not open these. */
  protected transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.db.transaction(work);
  }
}
