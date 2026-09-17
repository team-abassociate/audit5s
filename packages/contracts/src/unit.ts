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

export const listUnitsQuerySchema = paginationQuerySchema.extend({
  includeArchived: booleanQuery(false),
  search: z.string().trim().min(1).max(120).optional(),
});
export type ListUnitsQuery = z.infer<typeof listUnitsQuerySchema>;
