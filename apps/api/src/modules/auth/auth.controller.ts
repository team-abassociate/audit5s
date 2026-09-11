import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  changePasswordRequestSchema,
  forgotPasswordRequestSchema,
  loginRequestSchema,
  logoutRequestSchema,
  otpRequestSchema,
  otpVerifySchema,
  type ChangePasswordRequest,
  type ForgotPasswordRequest,
  type LoginRequest,
  type LoginResponse,
  type LogoutRequest,
  type MeResponse,
  type OtpRequest,
  type OtpVerify,
  type RefreshRequest,
  type TokenPair,
} from '@audit5s/contracts';
import { refreshRequestSchema } from '@audit5s/contracts';
import type { ActorContext } from '@audit5s/domain';
import {
  Actor,
  AllowPendingPasswordReset,
  Public,
  RequirePermission,
  Scope,
} from '../../common/auth/decorators';
import { AuthService } from './auth.service';
import { ZodValidationPipe } from './zod.pipe';

/**
 * `/auth/*` is the one route group outside the guard chain (§8.1), because it is what
 * produces the credential the chain checks. Rate limiting stands in for authorization here
 * — hence the limits in `RateLimitService` and the `login_attempt` table behind them.
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body(new ZodValidationPipe(loginRequestSchema)) body: LoginRequest): Promise<LoginResponse> {
    return this.auth.login(body);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body(new ZodValidationPipe(refreshRequestSchema)) body: RefreshRequest): Promise<TokenPair> {
    return this.auth.refresh(body.refreshToken);
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(@Body(new ZodValidationPipe(logoutRequestSchema)) body: LogoutRequest): Promise<void> {
    return this.auth.logout(body.refreshToken);
  }

  /**
   * Reachable while `must_reset_password` is set — it is the way out of that state (CH-1).
   * Every other authenticated route is closed until this succeeds.
   */
  @RequirePermission('user', 'reset_password')
  @Scope({ intent: 'write' })
  @AllowPendingPasswordReset()
  @Post('change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  changePassword(@Actor() actor: ActorContext, @Body(new ZodValidationPipe(changePasswordRequestSchema)) body: ChangePasswordRequest): Promise<void> {
    return this.auth.changePassword(actor, body);
  }

  /** Always 202, existing login ID or not — otherwise this is an enumeration oracle. */
  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.ACCEPTED)
  async forgotPassword(@Body(new ZodValidationPipe(forgotPasswordRequestSchema)) body: ForgotPasswordRequest): Promise<void> {
    await this.auth.forgotPassword(body.loginId);
  }

  @Public()
  @Post('otp/request')
  @HttpCode(HttpStatus.ACCEPTED)
  requestOtp(@Body(new ZodValidationPipe(otpRequestSchema)) body: OtpRequest): Promise<void> {
    return this.auth.requestOtp(body.phone);
  }

  @Public()
  @Post('otp/verify')
  @HttpCode(HttpStatus.OK)
  verifyOtp(@Body(new ZodValidationPipe(otpVerifySchema)) body: OtpVerify): Promise<LoginResponse> {
    return this.auth.verifyOtp(body.phone, body.code);
  }

  /**
   * Returns the server-resolved scope. Allowed during a pending reset so the client can
   * render the forced-reset screen with the user's own name rather than a blank form.
   */
  @RequirePermission('user', 'read')
  @Scope({ intent: 'read' })
  @AllowPendingPasswordReset()
  @Get('me')
  me(@Actor() actor: ActorContext): Promise<MeResponse> {
    return this.auth.me(actor);
  }
}
