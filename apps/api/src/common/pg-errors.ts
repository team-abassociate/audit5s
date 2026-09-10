/**
 * PostgreSQL error inspection.
 *
 * Drizzle wraps driver errors in a plain `Error` whose message is the failed SQL and whose
 * `cause` is the original `pg` error carrying `code` and `constraint`. Checking only the
 * outer error therefore never matches — which would silently disable the login-ID collision
 * retry and turn every constraint conflict into a 500.
 */

export const PG_UNIQUE_VIOLATION = '23505';

interface PgErrorLike {
  code?: string;
  constraint?: string;
  message?: string;
  cause?: unknown;
}

/** The error and everything in its `cause` chain. */
function chain(error: unknown, depth = 0): PgErrorLike[] {
  if (!error || typeof error !== 'object' || depth > 5) {
    return [];
  }
  const candidate = error as PgErrorLike;
  return [candidate, ...chain(candidate.cause, depth + 1)];
}

/** True when any error in the chain names the constraint. */
export function mentionsConstraint(error: unknown, constraint: string): boolean {
  return chain(error).some(
    (candidate) =>
      candidate.constraint === constraint || (candidate.message?.includes(constraint) ?? false),
  );
}

/**
 * True for a unique-constraint violation — optionally, a specific one.
 *
 * The code and the constraint name may sit on different links of the chain (the driver
 * error has the code; Drizzle's wrapper repeats the constraint name in its message), so
 * each is looked for across the whole chain rather than on one object.
 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const links = chain(error);
  const isUnique = links.some((candidate) => candidate.code === PG_UNIQUE_VIOLATION);
  if (!isUnique) {
    return false;
  }
  return constraint === undefined || mentionsConstraint(error, constraint);
}
