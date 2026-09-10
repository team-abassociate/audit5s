import { z } from 'zod';
import { isoDateTimeSchema, paginationQuerySchema, uuidSchema } from './common';
import { membershipStatusSchema, roleSchema } from './enums';

/**
 * `unit_membership` is the table every scope predicate in ARCHITECTURE.md PART 6 resolves
 * through. Rows are never deleted — revoking sets `status` and `validTo`, so history stays
 * explainable.
 */
export const unitMembershipSchema = z.object({
  id: uuidSchema,
  userId: uuidSchema,
  unitId: uuidSchema,
  role: roleSchema,
  status: membershipStatusSchema,
  validFrom: isoDateTimeSchema,
  validTo: isoDateTimeSchema.nullable(),
  assignedByUserId: uuidSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type UnitMembership = z.infer<typeof unitMembershipSchema>;

export const createMembershipRequestSchema = z.object({
  userId: uuidSchema,
  /**
   * Denormalised from the user for fast scope predicates. Optional on the wire: when
   * omitted the server uses the user's own role, and when supplied it must match — a
   * membership whose role disagrees with the user would corrupt every predicate.
   */
  role: roleSchema.optional(),
});
export type CreateMembershipRequest = z.infer<typeof createMembershipRequestSchema>;

export const listMembershipsQuerySchema = paginationQuerySchema.extend({
  userId: uuidSchema.optional(),
  unitId: uuidSchema.optional(),
  role: roleSchema.optional(),
  status: membershipStatusSchema.optional(),
});
export type ListMembershipsQuery = z.infer<typeof listMembershipsQuerySchema>;

/** Membership with the joined labels the admin UI lists. */
export const membershipDetailSchema = unitMembershipSchema.extend({
  userFullName: z.string(),
  userLoginId: z.string(),
  unitCode: z.string(),
  unitName: z.string(),
});
export type MembershipDetail = z.infer<typeof membershipDetailSchema>;
