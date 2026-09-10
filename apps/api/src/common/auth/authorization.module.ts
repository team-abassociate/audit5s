import { Global, Module } from '@nestjs/common';
import { IdempotencyRepository } from '../idempotency/idempotency.repository';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { RateLimitService } from '../rate-limit/rate-limit.service';
import { ActorRepository } from './actor.repository';
import { SCOPE_RESOLVERS, ScopeResolverRegistry } from './resolvers';
import { TokenService } from './token.service';

/**
 * The authorization machinery, global because every feature module's repository needs the
 * resolver registry to build its scope predicate (AZ-1).
 *
 * Global is the right call here rather than a convenience: if a feature module could be
 * written without importing this, it could be written without a scope predicate, and that
 * is exactly the failure mode PART 6 exists to prevent.
 */
@Global()
@Module({
  providers: [
    ...SCOPE_RESOLVERS,
    ScopeResolverRegistry,
    ActorRepository,
    TokenService,
    RateLimitService,
    IdempotencyService,
    IdempotencyRepository,
  ],
  exports: [
    ...SCOPE_RESOLVERS,
    ScopeResolverRegistry,
    ActorRepository,
    TokenService,
    RateLimitService,
    IdempotencyService,
    IdempotencyRepository,
  ],
})
export class AuthorizationModule {}
