import { z } from 'zod';
import {
  emailSchema,
  isoDateTimeSchema,
  paginationQuerySchema,
  phoneE164Schema,
  uuidSchema,
} from './common';

export const unitSchema = z.object({
  id: uuidSchema,
  code: z.string(),
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
  photoCapPerZone: z.number().int(),
  version: z.number().int(),
  archivedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type Unit = z.infer<typeof unitSchema>;

export const unitCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(2)
  .max(32)
  .regex(/^[A-Z0-9][A-Z0-9_-]*$/, 'Unit code may contain letters, digits, hyphen and underscore');

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
 * The Coordinator-editable subset (invariant U-1, ARCHITECTURE.md §5.2). `name` and `code`
 * are absent by construction: a Coordinator sending either gets `403 FIELD_NOT_EDITABLE`
 * naming the offending fields, enforced in the update resolver rather than only in the UI.
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

/** Writable by SUPER_ADMIN only. */
export const UNIT_SUPER_ADMIN_ONLY_FIELDS = ['name'] as const;

/** Immutable after creation, for anyone: changing it would rewrite object-storage keys. */
export const UNIT_IMMUTABLE_FIELDS = ['code'] as const;

export const createUnitRequestSchema = z.object({
  code: unitCodeSchema,
  name: unitNameSchema,
  address: z.string().trim().max(400).optional(),
  city: z.string().trim().max(120).optional(),
  state: z.string().trim().max(120).optional(),
  country: z.string().trim().max(120).optional(),
  postalCode: z.string().trim().max(20).optional(),
  contactName: z.string().trim().max(160).optional(),
  contactPhone: phoneE164Schema.optional(),
  contactEmail: emailSchema.optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  geofenceRadiusM: z.number().int().min(10).max(20000).nullable().optional(),
  timezone: timezoneSchema.default('Asia/Kolkata'),
  photoCapPerZone: z.number().int().min(1).max(500).optional(),
});
export type CreateUnitRequest = z.infer<typeof createUnitRequestSchema>;

const coordinatorEditableShape = {
  address: z.string().trim().max(400).nullable().optional(),
  city: z.string().trim().max(120).nullable().optional(),
  state: z.string().trim().max(120).nullable().optional(),
  country: z.string().trim().max(120).nullable().optional(),
  postalCode: z.string().trim().max(20).nullable().optional(),
  contactName: z.string().trim().max(160).nullable().optional(),
  contactPhone: phoneE164Schema.nullable().optional(),
  contactEmail: emailSchema.nullable().optional(),
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
    /** Present so the immutability rule produces a clear error rather than silence. */
    code: unitCodeSchema.optional(),
    /** Optimistic concurrency (ARCHITECTURE.md §5). */
    version: z.number().int().positive().optional(),
  })
  .refine((body) => Object.keys(body).some((k) => k !== 'version'), {
    message: 'No fields to update',
  });
export type UpdateUnitRequest = z.infer<typeof updateUnitRequestSchema>;

export const listUnitsQuerySchema = paginationQuerySchema.extend({
  includeArchived: z.coerce.boolean().default(false),
  search: z.string().trim().min(1).max(120).optional(),
});
export type ListUnitsQuery = z.infer<typeof listUnitsQuerySchema>;
