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
    /**
     * `null` clears the leader an auditor typed (0015) — "Nobody" chosen over it. Explicit,
     * because released field apps send `zoneLeaderId: null` on every save; that alone must not
     * erase a typed leader. Choosing an account clears it as well.
     */
    zoneLeaderName: z.null().optional(),
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

/**
 * What `POST /units/{id}/zones/import` did (R-59). The file replaces the Unit's list: its
 * Zones are added or updated, and the Unit's other Zones are archived.
 */
export const zoneListImportResultSchema = z.object({
  created: z.number().int(),
  updated: z.number().int(),
  archived: z.number().int(),
  zoneListImportedAt: isoDateTimeSchema,
  /** What the file carried that the Zone list does not read, such as mobile numbers. */
  notes: z.array(z.string()),
});
export type ZoneListImportResult = z.infer<typeof zoneListImportResultSchema>;

/**
 * What `POST /units/{id}/auditors/import` did (R-64): the Zone Leader and auditor accounts
 * made from the Auditor list. It adds people; it never replaces or removes anyone.
 */
export const auditorListImportResultSchema = z.object({
  /** New accounts. Each signs in with their mobile number and chooses a password. */
  created: z.number().int(),
  /** People the Unit already had an account for, matched by name, then by number. */
  existing: z.number().int(),
  /** Rows that made no account, and why: "Zone 4 ZL2: 9876 is not a 10-digit mobile number". */
  notes: z.array(z.string()),
});
export type AuditorListImportResult = z.infer<typeof auditorListImportResultSchema>;

/** The largest Zone-list or Auditor-list file an import reads. Both clients check it first. */
export const ZONE_LIST_IMPORT_MAX_BYTES = 5 * 1024 * 1024;

/** `null` clears the pointer, which is how a Zone is left without a leader. */
export const assignZoneLeaderRequestSchema = z.object({
  zoneLeaderId: uuidSchema.nullable(),
});
export type AssignZoneLeaderRequest = z.infer<typeof assignZoneLeaderRequestSchema>;
