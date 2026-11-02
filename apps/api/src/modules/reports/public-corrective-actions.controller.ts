import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import {
  type CorrectiveActionSubmission,
  type PublicCorrectiveAction,
  type UploadIntentResponse,
} from '@audit5s/contracts';
import type { ScopeContext } from '@audit5s/domain';
import { RequirePermission, Scope } from '../../common/auth/decorators';
import { CurrentScope } from '../../common/auth/current-scope.decorator';
import {
  SIGNED_TOKEN_PROPERTY,
  SignedTokenRoute,
  type RequestWithSignedToken,
} from '../../common/auth/signed-token.guard';
import { AppError } from '../../common/errors';
import { PublicCorrectiveActionsService } from './public-corrective-actions.service';

/**
 * The public, signed-token surface (§8.8, §10.4).
 *
 * **This is the only surface a person outside the organization touches.** Three routes,
 * one item, no listing. Everything about its shape follows from that:
 *
 *   * There is no `GET /public/corrective-actions` and there never will be. A leaked link
 *     must not become a tour of the Unit, and the absence of a listing route is a stronger
 *     guarantee than a scope check on one.
 *   * The token is not a session. It authorizes exactly what these three handlers do, it
 *     grants no other API access, and it cannot be exchanged for a JWT.
 *   * Submission goes through **the same domain service** as the authenticated route
 *     (§8.8), so there is one implementation of CA-1, CA-2 and the audit rollup rather
 *     than a second one that has to be kept in step.
 *
 * `@SignedTokenRoute()` is not `@Public()`: `PermissionGuard` and `ScopeGuard` both run,
 * the former asking whether a Zone Leader may do this at all and the latter narrowing the
 * request to the single action the link names.
 */
@Controller('public/corrective-actions')
export class PublicCorrectiveActionsController {
  constructor(private readonly publicActions: PublicCorrectiveActionsService) {}

  /** "Returns **only** that one item … No listing, no navigation to siblings" (§8.8). */
  @SignedTokenRoute()
  @RequirePermission('corrective_action', 'read')
  @Scope({ intent: 'read' })
  @Get(':token')
  get(
    @CurrentScope() scope: ScopeContext,
    @Req() request: RequestWithSignedToken,
  ): Promise<PublicCorrectiveAction> {
    return this.publicActions.get(scope, tokenOf(request));
  }

  /**
   * The after-photo's presigned PUT. The photo may come from the camera or the gallery
   * (R-38, R-40); `isLiveCapture` records which.
   */
  @SignedTokenRoute()
  @RequirePermission('evidence', 'create')
  @Scope({ intent: 'write' })
  @Post(':token/upload-intent')
  @HttpCode(HttpStatus.CREATED)
  uploadIntent(): Promise<UploadIntentResponse> {
    return this.publicActions.createUploadIntent();
  }

  /** R-78: refused — the Zone's leader answers in the app. Kept so an old page is told why. */
  @SignedTokenRoute()
  @RequirePermission('corrective_action', 'submit')
  @Scope({ intent: 'write' })
  @Post(':token/submissions')
  @HttpCode(HttpStatus.CREATED)
  submit(): Promise<CorrectiveActionSubmission> {
    return this.publicActions.submit();
  }
}

/**
 * The resolved token the guard attached.
 *
 * Read from the request rather than from the path: what the guard validated is the
 * authority, and re-parsing the URL here would be a second source of truth that could
 * disagree with it.
 */
function tokenOf(request: RequestWithSignedToken) {
  const token = request[SIGNED_TOKEN_PROPERTY];
  if (!token) {
    throw AppError.internal('Signed-token route reached with no resolved token');
  }
  return token;
}
