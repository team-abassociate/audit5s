import { z } from 'zod';
import {
  booleanQuery,
  clearable,
  isoDateTimeSchema,
  optional,
  paginationQuerySchema,
  uuidSchema,
} from './common';

/**
 * Zones (ARCHITECTURE.md §5.3).
 *
 * A Zone belongs to exactly one Unit and never moves (invariant Z-1): `unitId` appears in
 * no update shape at all, so "move this Zone" is not expressible rather than merely
 * refused. Moving one would silently rewrite every historical Unit trend.
 */

export const zoneSchema = z.object({
  id: uuidSchema,
  unitId: uuidSchema,
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  /** Suggests a default ChecklistTemplate; free text, matched against template names. */
  departmentHint: z.string().nullable(),
  defaultChecklistTemplateId: uuidSchema.nullable(),
  /** A **responsibility pointer, not a permission** (C2). Granting access is a membership. */
  zoneLeaderId: uuidSchema.nullable(),
  /** Joined for display, and cached by the device so the Zone list reads offline. */
  zoneLeaderName: z.string().nullable(),
  sortOrder: z.number().int(),
  version: z.number().int(),
  archivedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type Zone = z.infer<typeof zoneSchema>;

/**
 * The Zone-number range the auditor's dropdown offers (`brainstorm.md`: "a dropdown from
 * Zone 1 to Zone 100"). It bounds the code helper, not the column: a Unit that names its
 * Zones some other way is still free to.
 */
export const ZONE_NUMBER_MIN = 1;
export const ZONE_NUMBER_MAX = 100;

export const zoneCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(1)
  .max(32)
  .regex(/^[A-Z0-9][A-Z0-9_-]*$/, 'Zone code may contain letters, digits, hyphen and underscore');

export const zoneNameSchema = z.string().trim().min(1).max(200);

export const createZoneRequestSchema = z.object({
  code: zoneCodeSchema,
  name: zoneNameSchema,
  description: optional(z.string().trim().max(2000)),
  departmentHint: optional(z.string().trim().max(120)),
  defaultChecklistTemplateId: uuidSchema.optional(),
  zoneLeaderId: uuidSchema.optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});
export type CreateZoneRequest = z.infer<typeof createZoneRequestSchema>;

/**
 * `unitId` is absent by construction (Z-1). `description` is freely editable because
 * history is protected by the `AuditZone` snapshot, not by locking the master row (D6).
 */
export const updateZoneRequestSchema = z
  .object({
    code: zoneCodeSchema.optional(),
    name: zoneNameSchema.optional(),
    description: clearable(z.string().trim().max(2000)),
    departmentHint: clearable(z.string().trim().max(120)),
    defaultChecklistTemplateId: uuidSchema.nullable().optional(),
    zoneLeaderId: uuidSchema.nullable().optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
    version: z.number().int().positive().optional(),
  })
  .refine((body) => Object.keys(body).some((key) => key !== 'version'), {
    message: 'No fields to update',
  });
export type UpdateZoneRequest = z.infer<typeof updateZoneRequestSchema>;

/** `?active=true` (the default) is the Zone dropdown source — archived Zones vanish. */
export const listZonesQuerySchema = paginationQuerySchema.extend({
  active: booleanQuery(true),
  search: z.string().trim().min(1).max(120).optional(),
});
export type ListZonesQuery = z.infer<typeof listZonesQuerySchema>;

/** `null` clears the pointer, which is how a Zone is left without a leader. */
export const assignZoneLeaderRequestSchema = z.object({
  zoneLeaderId: uuidSchema.nullable(),
});
export type AssignZoneLeaderRequest = z.infer<typeof assignZoneLeaderRequestSchema>;
