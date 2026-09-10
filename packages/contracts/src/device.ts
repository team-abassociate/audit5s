import { z } from 'zod';
import { isoDateTimeSchema, paginationQuerySchema, uuidSchema } from './common';
import { devicePlatformSchema } from './auth';

export const deviceSchema = z.object({
  /** Client-generated and stable per install, so a reinstall is a new device. */
  id: uuidSchema,
  userId: uuidSchema,
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
  includeRevoked: z.coerce.boolean().default(false),
});
export type ListDevicesQuery = z.infer<typeof listDevicesQuerySchema>;
