import { z } from 'zod';
import {
  booleanQuery,
  clearable,
  emailSchema,
  isoDateTimeSchema,
  optional,
  paginationQuerySchema,
  phoneE164Schema,
  uuidSchema,
} from './common';

export const unitSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  address: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  country: z.string().nullable(),
  postalCode: z.string().nullable(),
  contactName: z.string().nullable(),
  contactPhone: z.string().nullable(),
  contactEmail: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  /** `null` disables geofencing for the Unit. */
  geofenceRadiusM: z.number().int().nullable(),
  timezone: z.string(),
  /**
   * The sector this Unit operates in (0018), which narrows the checklists its audits
   * offer. `null` narrows nothing. Never an access decision.
   */
  industryId: uuidSchema.nullable(),
  industryName: z.string().nullable(),
  photoCapPerZone: z.number().int(),
  version: z.number().int(),
  archivedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type Unit = z.infer<typeof unitSchema>;

/**
 * A Unit is identified by its name and nothing else. There was a `code` here — a short
 * immutable handle a Super Admin had to invent at creation — and it is gone: the name is
 * what anyone types, reads and searches for, so it carries the uniqueness instead.
 */
export const unitNameSchema = z.string().trim().min(1).max(200);

/** IANA zone (A11). Validated against the runtime's own tz database, not a regex. */
export const timezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(
    (tz) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Not a valid IANA time zone' },
  );

/**
 * The Coordinator-editable subset (invariant U-1, ARCHITECTURE.md §5.2). `name` is absent
 * by construction: a Coordinator sending it gets `403 FIELD_NOT_EDITABLE` naming the
 * offending field, enforced in the update resolver rather than only in the UI.
 */
export const UNIT_COORDINATOR_EDITABLE_FIELDS = [
  'address',
  'city',
  'state',
  'country',
  'postalCode',
  'contactName',
  'contactPhone',
  'contactEmail',
  'latitude',
  'longitude',
  'geofenceRadiusM',
  'timezone',
  'photoCapPerZone',
] as const;

/**
 * Writable by SUPER_ADMIN only.
 *
 * `industryId` sits here rather than with the Coordinator's fields because it decides
 * which catalogue the Unit's auditors are offered. That is an organization-wide call about
 * what this plant *is*, in the same family as its name — not day-to-day upkeep like an
 * address or a contact number.
 */
export const UNIT_SUPER_ADMIN_ONLY_FIELDS = ['name', 'industryId'] as const;

export const createUnitRequestSchema = z.object({
  name: unitNameSchema,
  address: optional(z.string().trim().max(400)),
  city: optional(z.string().trim().max(120)),
  state: optional(z.string().trim().max(120)),
  country: optional(z.string().trim().max(120)),
  postalCode: optional(z.string().trim().max(20)),
  contactName: optional(z.string().trim().max(160)),
  contactPhone: optional(phoneE164Schema),
  contactEmail: optional(emailSchema),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  geofenceRadiusM: z.number().int().min(10).max(20000).nullable().optional(),
  timezone: timezoneSchema.default('Asia/Kolkata'),
  photoCapPerZone: z.number().int().min(1).max(500).optional(),
  /** The sector this plant operates in (0018). Omitted means unclassified. */
  industryId: uuidSchema.nullable().optional(),
});
export type CreateUnitRequest = z.infer<typeof createUnitRequestSchema>;

// On an update, an emptied field is a request to clear it — `clearable`, not `optional`.
const coordinatorEditableShape = {
  address: clearable(z.string().trim().max(400)),
  city: clearable(z.string().trim().max(120)),
  state: clearable(z.string().trim().max(120)),
  country: clearable(z.string().trim().max(120)),
  postalCode: clearable(z.string().trim().max(20)),
  contactName: clearable(z.string().trim().max(160)),
  contactPhone: clearable(phoneE164Schema),
  contactEmail: clearable(emailSchema),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  geofenceRadiusM: z.number().int().min(10).max(20000).nullable().optional(),
  timezone: timezoneSchema.optional(),
  photoCapPerZone: z.number().int().min(1).max(500).optional(),
};

/**
 * Both roles post to the same endpoint. The wire schema accepts `name` so that a
 * Coordinator sending it reaches the field-level check and receives `FIELD_NOT_EDITABLE`
 * naming it, rather than a generic "unrecognised key" validation error.
 */
export const updateUnitRequestSchema = z
  .object({
    ...coordinatorEditableShape,
    name: unitNameSchema.optional(),
    /**
     * Accepted on the wire for the same reason `name` is: a Coordinator who sends it
     * reaches the field-level check and is told `FIELD_NOT_EDITABLE` naming the field,
     * rather than getting a generic validation error about an unrecognised key.
     */
    industryId: uuidSchema.nullable().optional(),
    /** Optimistic concurrency (ARCHITECTURE.md §5). */
    version: z.number().int().positive().optional(),
  })
  .refine((body) => Object.keys(body).some((k) => k !== 'version'), {
    message: 'No fields to update',
  });
export type UpdateUnitRequest = z.infer<typeof updateUnitRequestSchema>;

/**
 * §2.6: a Coordinator calls a cross audit of one Zone of their Unit, due by `dueOn` (owner,
 * 2026-10-14). `dueOn` is optional on the wire only for phones not yet updated: the server
 * makes it seven days out, as those phones showed.
 */
export const callCrossAuditRequestSchema = z
  .object({
    /** One Zone: what phones before 0051 send. */
    zoneId: uuidSchema.optional(),
    /** Several Zones, one cross audit (owner, 2026-10-14). */
    zoneIds: z.array(uuidSchema).min(1).max(500).optional(),
    dueOn: z.iso.date().optional(),
  })
  .refine((body) => body.zoneId !== undefined || body.zoneIds !== undefined, {
    message: 'Name at least one Zone',
    path: ['zoneIds'],
  });
export type CallCrossAuditRequest = z.infer<typeof callCrossAuditRequestSchema>;

/** Where a Zone of a called cross audit stands: nobody has started it, it is under way, it is done. */
export const crossAuditZoneStateSchema = z.enum(['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED']);
export type CrossAuditZoneState = z.infer<typeof crossAuditZoneStateSchema>;

/**
 * One called cross audit, of one Zone or many (0051): the Coordinator's card on every Audits
 * board. Each Zone's state is read from the first audit of it since the call that counts
 * (R-55: a Zone Leader's cross audit, or any audit by the Coordinator).
 */
export const crossAuditRoundSchema = z.object({
  id: uuidSchema,
  unitId: uuidSchema,
  calledBy: z.string(),
  /** `YYYY-MM-DD`, the deadline in force. */
  dueOn: z.iso.date(),
  createdAt: isoDateTimeSchema,
  completedAt: isoDateTimeSchema.nullable(),
  completedBy: z.string().nullable(),
  completionRemark: z.string().nullable(),
  zones: z.array(
    z.object({
      zoneId: uuidSchema,
      zoneCode: z.string(),
      zoneName: z.string(),
      state: crossAuditZoneStateSchema,
      auditId: uuidSchema.nullable(),
      auditorName: z.string().nullable(),
    }),
  ),
});
export type CrossAuditRound = z.infer<typeof crossAuditRoundSchema>;

/** Moving a called cross audit's deadline — later, or sooner, but not into the past. */
export const changeCrossAuditDeadlineRequestSchema = z.object({ dueOn: z.iso.date() });
export type ChangeCrossAuditDeadlineRequest = z.infer<typeof changeCrossAuditDeadlineRequestSchema>;

/** Completing a called cross audit; the remark is required when a Zone is not done. */
export const completeCrossAuditRequestSchema = z.object({ remark: z.string().trim().max(2000).optional() });
export type CompleteCrossAuditRequest = z.infer<typeof completeCrossAuditRequestSchema>;

/** A call still standing: no audit of its Zone has started since it was made. */
export const crossAuditCallSchema = z.object({
  id: uuidSchema,
  unitId: uuidSchema,
  unitName: z.string(),
  zoneId: uuidSchema,
  zoneCode: z.string(),
  zoneName: z.string(),
  calledBy: z.string(),
  /** `YYYY-MM-DD`; past it the call is overdue, and still stands. */
  dueOn: z.iso.date(),
  createdAt: isoDateTimeSchema,
});
export type CrossAuditCall = z.infer<typeof crossAuditCallSchema>;

export const listUnitsQuerySchema = paginationQuerySchema.extend({
  includeArchived: booleanQuery(false),
  search: z.string().trim().min(1).max(120).optional(),
});
export type ListUnitsQuery = z.infer<typeof listUnitsQuerySchema>;
