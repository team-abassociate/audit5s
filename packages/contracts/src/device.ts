import { z } from 'zod';
import { booleanQuery, isoDateTimeSchema, paginationQuerySchema, uuidSchema } from './common';
import { devicePlatformSchema } from './auth';

export const deviceSchema = z.object({
  /** Client-generated and stable per install, so a reinstall is a new device. */
  id: uuidSchema,
  /** Who signed in on it last. Display only: a phone is shared, and access is `people`. */
  userId: uuidSchema,
  /**
   * Everybody who has signed in on this phone with their own credentials, newest first.
   * A field role sees only itself here; a Super Admin sees everybody.
   */
  people: z.array(
    z.object({
      userId: uuidSchema,
      fullName: z.string(),
      lastSignedInAt: isoDateTimeSchema,
      revokedAt: isoDateTimeSchema.nullable(),
    }),
  ),
  platform: devicePlatformSchema,
  model: z.string().nullable(),
  osVersion: z.string().nullable(),
  appVersion: z.string().nullable(),
  lastSeenAt: isoDateTimeSchema.nullable(),
  lastSyncAt: isoDateTimeSchema.nullable(),
  revokedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type Device = z.infer<typeof deviceSchema>;

export const registerDeviceRequestSchema = z.object({
  deviceId: uuidSchema,
  platform: devicePlatformSchema,
  model: z.string().trim().max(120).optional(),
  osVersion: z.string().trim().max(60).optional(),
  appVersion: z.string().trim().max(60).optional(),
  /** FCM registration token, behind the `PushChannel` adapter. */
  pushToken: z.string().trim().max(4096).optional(),
});
export type RegisterDeviceRequest = z.infer<typeof registerDeviceRequestSchema>;

export const listDevicesQuerySchema = paginationQuerySchema.extend({
  userId: uuidSchema.optional(),
  /** Through `booleanQuery`: `z.coerce.boolean()` reads the string "false" as true. */
  includeRevoked: booleanQuery(false),
});
export type ListDevicesQuery = z.infer<typeof listDevicesQuerySchema>;
