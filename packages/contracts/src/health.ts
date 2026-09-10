import { z } from 'zod';

export const healthCheckSchema = z.object({
  status: z.enum(['ok', 'degraded', 'error']),
  version: z.string(),
  uptimeSeconds: z.number(),
  checks: z.record(
    z.string(),
    z.object({
      status: z.enum(['ok', 'error']),
      detail: z.string().optional(),
      durationMs: z.number().optional(),
    }),
  ),
});
export type HealthCheck = z.infer<typeof healthCheckSchema>;
