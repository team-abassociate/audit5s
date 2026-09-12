import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { HEADER_DEVICE_ID } from '@audit5s/contracts';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../errors';
import { getRequestContext, setActor, setJti } from '../observability/request-context';
import { ActorRepository } from './actor.repository';
import { ALLOW_PENDING_RESET_KEY, PUBLIC_KEY } from './decorators';
import { SIGNED_TOKEN_KEY } from './signed-token.guard';
import { TokenService } from './token.service';

/**
 * Check 1 of ARCHITECTURE.md §6.1:
 *   valid, unexpired access JWT · user ACTIVE · password reset not pending.
 *
 * All three, in that order. The third is CH-1: a bootstrap credential is the user's own
 * phone number, so until it is rotated every route except the reset itself is closed.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly actors: ActorRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }

    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    // A signed-link route has already been authenticated by `SignedTokenGuard`, which runs
    // before this one and put a real actor in the request context. It is not `@Public()`:
    // the two guards after this one still run in full.
    const bySignedToken = this.reflector.getAllAndOverride<boolean>(SIGNED_TOKEN_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (bySignedToken) {
      return getRequestContext()?.actor !== undefined;
    }

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const claims = await this.tokens.verifyAccessToken(extractBearerToken(request));

    if (await this.actors.isAccessTokenRevoked(claims.jti)) {
      throw AppError.unauthorized('TOKEN_INVALID', 'This session has been revoked');
    }

    const headerDeviceId = request.headers[HEADER_DEVICE_ID];
    const deviceId = Array.isArray(headerDeviceId) ? headerDeviceId[0] : headerDeviceId;

    // The token binds a device; a header claiming a different one is a red flag, not a
    // preference to honour.
    if (claims.deviceId && deviceId && claims.deviceId !== deviceId) {
      throw AppError.unauthorized('TOKEN_INVALID', 'Device does not match this session');
    }

    const record = await this.actors.loadActor(claims.sub, claims.deviceId ?? deviceId ?? null);
    if (!record) {
      throw AppError.unauthorized('TOKEN_INVALID', 'This session is no longer valid');
    }

    if (record.archivedAt !== null) {
      throw AppError.unauthorized('ACCOUNT_DISABLED', 'This account is no longer active');
    }
    if (record.status === 'DISABLED') {
      throw AppError.unauthorized('ACCOUNT_DISABLED', 'This account has been disabled');
    }
    if (record.status === 'LOCKED') {
      throw AppError.unauthorized('ACCOUNT_LOCKED', 'This account is locked');
    }

    // The role in the token is only a hint. Authorization uses the role in the database,
    // so a token minted before a role change cannot outlive it.
    if (record.actor.role !== claims.role) {
      throw AppError.unauthorized('TOKEN_INVALID', 'This session predates a change to your account');
    }

    if (record.mustResetPassword) {
      const allowed = this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_RESET_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (!allowed) {
        throw new AppError(
          'PASSWORD_RESET_REQUIRED',
          403,
          'Password reset required',
          'Set a new password before using the rest of the application',
        );
      }
    }

    setJti(claims.jti);
    setActor(record.actor, `${record.fullName} (${record.loginId})`);
    return true;
  }
}

function extractBearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw AppError.unauthorized('TOKEN_INVALID', 'Missing bearer token');
  }
  return header.slice('Bearer '.length).trim();
}
