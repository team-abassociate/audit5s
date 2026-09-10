import { z } from 'zod';
import { locationReadingSchema } from './audit';
import {
  booleanQuery,
  clearable,
  isoDateTimeSchema,
  paginationQuerySchema,
  uuidSchema,
} from './common';
import {
  evidenceClassificationSchema,
  evidenceKindSchema,
  locationProviderSchema,
  responseValueSchema,
  syncStateSchema,
} from './enums';

/**
 * Evidence (ARCHITECTURE.md §5.6, §7.4, §8.7).
 *
 * Three properties of these shapes carry the invariants rather than describing them:
 *
 *   - **`classification` is not an input.** It appears on the response and nowhere in a
 *     request, because E-1 says the server derives it from the linked response and
 *     overwrites whatever a client claims. A field a client cannot send is a field a
 *     client cannot lie about — except on `WALK_BY_PHOTO`, where §2.7 gives the auditor
 *     the choice because there is no score to derive it from, and only there.
 *   - **The metadata and the bytes are separate calls.** `upload-intent` mints a key and
 *     writes the row; the object goes straight to storage; `commit` confirms. Media never
 *     transits the API (STACK.md §5), and §9.6 makes replaying `commit` the crash-recovery
 *     path, so it is idempotent by contract and not by accident.
 *   - **No delete shape sets a flag.** `DELETE /evidence/{id}` is a soft delete and is
 *     refused after completion (E-4); redaction (R-5) is a separate, Super-Admin verb that
 *     overwrites the object and keeps the row.
 */

export const evidenceSchema = z.object({
  id: uuidSchema,
  kind: evidenceKindSchema,
  auditId: uuidSchema,
  /** Null only for the audit-level selfie. */
  auditZoneId: uuidSchema.nullable(),
  questionResponseId: uuidSchema.nullable(),
  correctiveActionSubmissionId: uuidSchema.nullable(),
  objectKey: z.string(),
  thumbnailObjectKey: z.string().nullable(),
  contentType: z.string(),
  byteSize: z.number().int().nonnegative(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  checksumSha256: z.string(),
  localDeviceId: uuidSchema.nullable(),
  /** The score at the moment the photo was taken, which is what E-1 classifies from. */
  scoreAtCapture: responseValueSchema.nullable(),
  classification: evidenceClassificationSchema,
  remark: z.string().nullable(),
  isSummaryFlagged: z.boolean(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  accuracyM: z.number().nullable(),
  locationProvider: locationProviderSchema.nullable(),
  capturedAt: isoDateTimeSchema,
  uploadedAt: isoDateTimeSchema.nullable(),
  syncState: syncStateSchema,
  /** False ⇒ gallery. §12.10 is explicit that this is deterrence plus evidence, not proof. */
  isLiveCapture: z.boolean(),
  deletedAt: isoDateTimeSchema.nullable(),
  /** R-5: set when the stored object has been overwritten with a placeholder. */
  redactedAt: isoDateTimeSchema.nullable(),
  redactionReason: z.string().nullable(),
  createdAt: isoDateTimeSchema,
});
export type Evidence = z.infer<typeof evidenceSchema>;

/**
 * `POST /evidence/upload-intent` (§8.7).
 *
 * `id` is the device's UUIDv7 (D12), so a retried intent returns the *same* key rather
 * than minting a second one — which is what stops an interrupted upload from leaving two
 * objects and one row.
 */
export const uploadIntentRequestSchema = z.object({
  id: uuidSchema,
  kind: evidenceKindSchema,
  auditId: uuidSchema,
  auditZoneId: uuidSchema.optional(),
  questionResponseId: uuidSchema.optional(),
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  /** §12.8's hard cap is 15 MB, enforced here and again in the presigned policy. */
  byteSize: z
    .number()
    .int()
    .positive()
    .max(15 * 1024 * 1024),
  checksumSha256: z.string().regex(/^[0-9a-f]{64}$/, 'Expected a lowercase hex SHA-256'),
  capturedAt: isoDateTimeSchema,
  /** The capture component sets this; the flows that demand live capture verify it. */
  isLiveCapture: z.boolean(),
  location: locationReadingSchema.optional(),
  /**
   * Auditor-selected classification, honoured for `WALK_BY_PHOTO` **only** (E-1). On every
   * other kind the server derives it and this is ignored rather than rejected, because a
   * device replaying an old payload should not have its photo refused over a field the
   * server was always going to overwrite.
   */
  classification: evidenceClassificationSchema.optional(),
  remark: clearable(z.string().trim().max(2000)),
  localFileUri: z.string().trim().max(1024).optional(),
});
export type UploadIntentRequest = z.infer<typeof uploadIntentRequestSchema>;

export const uploadIntentResponseSchema = z.object({
  evidenceId: uuidSchema,
  objectKey: z.string(),
  uploadUrl: z.string(),
  /**
   * Headers the PUT must carry for the signature to verify. Sent explicitly rather than
   * left for the client to reconstruct: a mismatched `content-type` fails at the storage
   * provider with an opaque 403, hours after the photo was taken.
   */
  requiredHeaders: z.record(z.string(), z.string()),
  /** Seconds. §12.6 puts the PUT window at 900. */
  expiresIn: z.number().int().positive(),
  /**
   * True when this intent found an existing row — the same key, the same URL. The device
   * re-uploads rather than treating it as an error, because §9.4 says a repeat PUT of the
   * same content to the same key is harmless.
   */
  alreadyExists: z.boolean(),
});
export type UploadIntentResponse = z.infer<typeof uploadIntentResponseSchema>;

/**
 * `POST /evidence/{id}/commit` (§8.7, §9.4).
 *
 * The server `HEAD`s the object and verifies size and checksum against the intent, so this
 * body carries only what it checks against. Replaying it on an already-committed row
 * returns the same evidence — that is §9.6's "app killed between PUT and commit" path, and
 * it is a contract, not a nicety.
 */
export const commitEvidenceRequestSchema = z.object({
  checksumSha256: z.string().regex(/^[0-9a-f]{64}$/, 'Expected a lowercase hex SHA-256'),
  width: z.number().int().positive().max(20_000).optional(),
  height: z.number().int().positive().max(20_000).optional(),
});
export type CommitEvidenceRequest = z.infer<typeof commitEvidenceRequestSchema>;

/** `PATCH /evidence/{id}`. A flag conflict is `409 SUMMARY_FLAG_TAKEN` (§8.7). */
export const patchEvidenceRequestSchema = z
  .object({
    remark: clearable(z.string().trim().max(2000)),
    isSummaryFlagged: z.boolean().optional(),
  })
  .refine((patch) => patch.remark !== undefined || patch.isSummaryFlagged !== undefined, {
    message: 'Nothing to change',
  });
export type PatchEvidenceRequest = z.infer<typeof patchEvidenceRequestSchema>;

/** `GET /evidence/{id}/view-url` — minted **after** the scope check, TTL ≤ 300 s (§12.6). */
export const evidenceViewUrlSchema = z.object({
  url: z.string(),
  expiresIn: z.number().int().positive(),
  expiresAt: isoDateTimeSchema,
});
export type EvidenceViewUrl = z.infer<typeof evidenceViewUrlSchema>;

export const listEvidenceQuerySchema = paginationQuerySchema.extend({
  classification: evidenceClassificationSchema.optional(),
  kind: evidenceKindSchema.optional(),
  /** Through `booleanQuery`, so `?includeDeleted=false` means what it says. */
  includeDeleted: booleanQuery(false),
  summaryFlaggedOnly: booleanQuery(false),
});
export type ListEvidenceQuery = z.infer<typeof listEvidenceQuerySchema>;
