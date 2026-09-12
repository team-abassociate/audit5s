import { z } from 'zod';

export const healthCheckSchema = z.object({
  status: z.enum(['ok', 'degraded', 'error']),
  version: z.string(),
  uptimeSeconds: z.number(),
  checks: z.record(
    z.string(),
    z.object({
      /**
       * `degraded` is §16.12's warning band, and it is a distinct answer from `error`:
       * dead-lettered jobs mean work was lost and somebody must look, while the API is
       * still serving every request correctly. Paging on it would train the on-call to
       * ignore the page; hiding it would leave the lost work unnoticed.
       */
      status: z.enum(['ok', 'degraded', 'error']),
      detail: z.string().optional(),
      durationMs: z.number().optional(),
    }),
  ),
});
export type HealthCheck = z.infer<typeof healthCheckSchema>;
