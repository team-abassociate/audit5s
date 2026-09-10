import { z } from 'zod';
import { checklistTemplateSchema, checklistVersionDetailSchema } from './checklist';
import { isoDateTimeSchema } from './common';
import { unitSchema } from './unit';
import { zoneSchema } from './zone';

/**
 * `GET /sync/catalogue` (ARCHITECTURE.md §8.11) — the entire offline bootstrap.
 *
 * Reference data only: the Units the actor may touch, their active Zones, and the
 * published checklist versions with every question. The device replaces its cached copy
 * wholesale, so the payload is complete rather than a delta.
 *
 * Assignments and open corrective actions join this shape in Phases 3 and 6; the envelope
 * is defined once, here, so adding them is an added field rather than a new endpoint.
 */
export const syncCatalogueSchema = z.object({
  /** Authoritative clock, so a device with a skewed clock can normalise its timestamps. */
  serverTime: isoDateTimeSchema,
  /**
   * Changes when any of the payload does. A device that gets the same value back has
   * nothing to write, which is the cheap path on a slow field connection.
   */
  catalogueVersion: z.string(),
  units: z.array(unitSchema),
  zones: z.array(zoneSchema),
  checklistTemplates: z.array(checklistTemplateSchema),
  checklistVersions: z.array(checklistVersionDetailSchema),
});
export type SyncCatalogue = z.infer<typeof syncCatalogueSchema>;

export const syncCatalogueQuerySchema = z.object({
  /**
   * The device's last `catalogueVersion`. When it still matches, the response carries
   * `serverTime` and the same version with empty collections — the device keeps what it has.
   */
  since: z.string().trim().min(1).max(128).optional(),
});
export type SyncCatalogueQuery = z.infer<typeof syncCatalogueQuerySchema>;
