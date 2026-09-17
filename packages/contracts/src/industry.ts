import { z } from 'zod';
import { isoDateTimeSchema, uuidSchema } from './common';

/**
 * Industries (0018): the sector a Unit operates in, and the sector a checklist belongs to.
 *
 * This product was built for engineering plants. Selling it to a hospital means a second
 * catalogue that must not appear in an engineering plant's audit, and this is the label
 * that keeps them apart.
 *
 * **It is not a tenant.** One organization, one set of users, one authorization model. An
 * industry decides what a screen *offers*; it never decides what a person may *see*. Code
 * that reads `industryId` to make an access decision is reading it wrong — narrowing a
 * list is a courtesy, and the API refuses out-of-scope requests on its own.
 */
export const industrySchema = z.object({
  id: uuidSchema,
  /** Stable and shouted, like every code here: `ENGINEERING`, `HOSPITAL`. */
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  sortOrder: z.number().int(),
  archivedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  /** How many checklist templates carry this label, for the management screen. */
  templateCount: z.number().int().nonnegative(),
  /** How many Units operate in it. An industry in use is one to archive carefully. */
  unitCount: z.number().int().nonnegative(),
});
export type Industry = z.infer<typeof industrySchema>;

const code = z
  .string()
  .trim()
  .min(2)
  .max(40)
  .regex(/^[A-Z][A-Z0-9_]*$/, 'Use capitals, digits and underscores, e.g. HOSPITAL');

export const createIndustryRequestSchema = z.object({
  code,
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});
export type CreateIndustryRequest = z.infer<typeof createIndustryRequestSchema>;

/**
 * `code` is absent on purpose. Templates and Units point at the row by id, but people
 * recognise an industry by its code, and a code that can change is a code that means
 * something different in two places at once. Renaming the display name is free.
 */
export const updateIndustryRequestSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});
export type UpdateIndustryRequest = z.infer<typeof updateIndustryRequestSchema>;

export const listIndustriesQuerySchema = z.object({
  /** Archived industries are hidden unless asked for; nothing is ever deleted (D8). */
  includeArchived: z
    .union([z.boolean(), z.literal('true'), z.literal('false')])
    .optional()
    .transform((value) => value === true || value === 'true'),
});
export type ListIndustriesQuery = z.infer<typeof listIndustriesQuerySchema>;
