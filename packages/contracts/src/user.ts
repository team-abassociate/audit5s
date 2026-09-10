import { z } from 'zod';
import {
  emailSchema,
  isoDateTimeSchema,
  clearable,
  loginIdSchema,
  optional,
  paginationQuerySchema,
  phoneE164Schema,
  uuidSchema,
} from './common';
import { roleSchema, userStatusSchema } from './enums';

export const userSchema = z.object({
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
  createdByUserId: uuidSchema.nullable(),
  archivedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type User = z.infer<typeof userSchema>;

export const fullNameSchema = z.string().trim().min(1).max(160);

export const createUserRequestSchema = z.object({
  fullName: fullNameSchema,
  phone: phoneE164Schema,
  email: optional(emailSchema),
  role: roleSchema,
  /**
   * Optional at the type level, required by the service for every role except SUPER_ADMIN:
   * a Consultant, Coordinator or Zone Leader with no Unit has no scope and could see
   * nothing. A Coordinator creating a user may only create ZONE_LEADERs, and the unit is
   * taken from their own membership rather than the body (AZ-2).
   */
  unitId: optional(uuidSchema),
});
export type CreateUserRequest = z.infer<typeof createUserRequestSchema>;

/**
 * `201` body. The bootstrap credential is the user's phone number and is **never** returned
 * or logged (ARCHITECTURE.md §12.1) — only the login ID and the 72-hour expiry are.
 */
export const createUserResponseSchema = z.object({
  user: userSchema,
  loginId: loginIdSchema,
  bootstrapExpiresAt: isoDateTimeSchema,
});
export type CreateUserResponse = z.infer<typeof createUserResponseSchema>;

/** Fields a user may change on their own record. */
export const SELF_EDITABLE_USER_FIELDS = ['fullName', 'email'] as const;
/** Fields an administrator may change on another user's record. */
export const ADMIN_EDITABLE_USER_FIELDS = ['fullName', 'email', 'phone'] as const;

export const updateUserRequestSchema = z
  .object({
    fullName: fullNameSchema.optional(),
    email: clearable(emailSchema),
    phone: optional(phoneE164Schema),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'No fields to update' });
export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>;

export const listUsersQuerySchema = paginationQuerySchema.extend({
  role: roleSchema.optional(),
  status: userStatusSchema.optional(),
  /** A filter, never a grant — it is intersected with the actor's scope (AZ-2). */
  unitId: uuidSchema.optional(),
  search: z.string().trim().min(1).max(120).optional(),
});
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;

export const disableUserRequestSchema = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
});
export type DisableUserRequest = z.infer<typeof disableUserRequestSchema>;

/** Issues a fresh bootstrap credential and forces a reset. Never returns the credential. */
export const resetUserPasswordResponseSchema = z.object({
  loginId: loginIdSchema,
  bootstrapExpiresAt: isoDateTimeSchema,
});
export type ResetUserPasswordResponse = z.infer<typeof resetUserPasswordResponseSchema>;
