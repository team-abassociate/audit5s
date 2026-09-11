import { z } from 'zod';
import { loginIdSchema, isoDateTimeSchema, phoneE164Schema, uuidSchema } from './common';
import { roleSchema, userStatusSchema, locationProviderSchema } from './enums';
import { permissionKeySchema } from './permission';

/** Minimum password length on reset (ARCHITECTURE.md §12.1). */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 256;

export const newPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH);

/**
 * Location reported at login. Recorded, never trusted — ARCHITECTURE.md §12.9 is explicit
 * that mobile GPS cannot prove presence and this system makes no anti-spoofing claim.
 */
export const capturedLocationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracyM: z.number().nonnegative().optional(),
  provider: locationProviderSchema.default('UNKNOWN'),
  isMocked: z.boolean().default(false),
  capturedAt: isoDateTimeSchema,
});
export type CapturedLocation = z.infer<typeof capturedLocationSchema>;

export const devicePlatformSchema = z.enum(['android', 'ios']);
export type DevicePlatform = z.infer<typeof devicePlatformSchema>;

export const loginRequestSchema = z.object({
  loginId: loginIdSchema,
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  /** Client-generated, stable per install. Binds the session to a device. */
  deviceId: uuidSchema.optional(),
  platform: devicePlatformSchema.optional(),
  model: z.string().max(120).optional(),
  osVersion: z.string().max(60).optional(),
  appVersion: z.string().max(60).optional(),
  location: capturedLocationSchema.optional(),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** The authenticated user as every client sees it. Never carries a hash or a phone password. */
export const authenticatedUserSchema = z.object({
  id: uuidSchema,
  loginId: loginIdSchema,
  fullName: z.string(),
  phoneE164: phoneE164Schema,
  email: z.email().nullable(),
  role: roleSchema,
  status: userStatusSchema,
  mustResetPassword: z.boolean(),
  bootstrapExpiresAt: isoDateTimeSchema.nullable(),
  lastLoginAt: isoDateTimeSchema.nullable(),
});
export type AuthenticatedUser = z.infer<typeof authenticatedUserSchema>;

/**
 * Server-resolved scope (ARCHITECTURE.md §8.3). Clients render navigation from this and
 * never compute permissions themselves. Note there are no permissions and no unit IDs in
 * the access token itself (§12.3) — revoking a Unit assignment must take effect at once,
 * not at token expiry, so scope is resolved from the database on every request.
 */
export const resolvedScopeSchema = z.object({
  role: roleSchema,
  /** Units the actor may touch. Empty for SUPER_ADMIN, whose scope is organization-wide. */
  unitIds: z.array(uuidSchema),
  organizationWide: z.boolean(),
  permissions: z.array(permissionKeySchema),
});
export type ResolvedScope = z.infer<typeof resolvedScopeSchema>;

export const tokenPairSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  accessTokenExpiresAt: isoDateTimeSchema,
  refreshTokenExpiresAt: isoDateTimeSchema,
});
export type TokenPair = z.infer<typeof tokenPairSchema>;

export const loginResponseSchema = tokenPairSchema.extend({
  user: authenticatedUserSchema,
  mustResetPassword: z.boolean(),
  scope: resolvedScopeSchema,
});
export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const refreshRequestSchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshRequest = z.infer<typeof refreshRequestSchema>;

export const logoutRequestSchema = z.object({
  refreshToken: z.string().min(1),
  deviceId: uuidSchema.optional(),
});
export type LogoutRequest = z.infer<typeof logoutRequestSchema>;

export const changePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: newPasswordSchema,
});
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

export const forgotPasswordRequestSchema = z.object({
  loginId: loginIdSchema,
});
export type ForgotPasswordRequest = z.infer<typeof forgotPasswordRequestSchema>;

export const otpRequestSchema = z.object({ phone: phoneE164Schema });
export type OtpRequest = z.infer<typeof otpRequestSchema>;

export const otpVerifySchema = z.object({
  phone: phoneE164Schema,
  code: z.string().regex(/^\d{6}$/, 'OTP must be 6 digits'),
});
export type OtpVerify = z.infer<typeof otpVerifySchema>;

export const meResponseSchema = z.object({
  user: authenticatedUserSchema,
  scope: resolvedScopeSchema,
});
export type MeResponse = z.infer<typeof meResponseSchema>;

/** Claims carried by the access JWT (ARCHITECTURE.md §12.3). Deliberately thin. */
export const accessTokenClaimsSchema = z.object({
  sub: uuidSchema,
  role: roleSchema,
  jti: uuidSchema,
  deviceId: uuidSchema.nullable().optional(),
  iat: z.number().int(),
  exp: z.number().int(),
  iss: z.string(),
  aud: z.string(),
});
export type AccessTokenClaims = z.infer<typeof accessTokenClaimsSchema>;
