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
 * Every Zone is addressed by its number, 1…100, stored as the code `Z-01`…`Z-100`. The
 * number is mandatory and the name optional: a number cannot be mis-typed into a second
 * spelling of the same place the way a name can.
 */
export const ZONE_NUMBER_MIN = 1;
export const ZONE_NUMBER_MAX = 100;

/** Accepts `Z-7`, `z-07`, `Z-007`; stores the one spelling `Z-07` so uniqueness holds. */
export const zoneCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^Z-\d{1,3}$/, `Zone code is Z- and a number from ${ZONE_NUMBER_MIN} to ${ZONE_NUMBER_MAX}`)
  .transform((code) => Number(code.slice(2)))
  .refine((n) => n >= ZONE_NUMBER_MIN && n <= ZONE_NUMBER_MAX, {
    message: `Zone number is ${ZONE_NUMBER_MIN} to ${ZONE_NUMBER_MAX}`,
  })
  .transform((n) => `Z-${String(n).padStart(2, '0')}`);

/** Optional: left empty, the server names the Zone "Zone 7" after its number. */
export const zoneNameSchema = z.string().trim().max(200);

export const createZoneRequestSchema = z.object({
  code: zoneCodeSchema,
  name: zoneNameSchema.optional(),
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
