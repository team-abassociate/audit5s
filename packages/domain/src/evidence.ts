import type { EvidenceClassification, EvidenceKind, ResponseValue } from '@audit5s/contracts';

/**
 * Evidence classification — invariant E-1 (ARCHITECTURE.md §5.6).
 *
 * > `QUESTION_EVIDENCE`: `SCORE_2 → GOOD`; `SCORE_1`/`SCORE_0 → NONCONFORMITY`; `NA → NEUTRAL`.
 * > Computed server-side from the linked response. The client may send it; the server
 * > overwrites it.
 *
 * It lives here, pure, for the same reason scoring does: the device shows the auditor a
 * green tick or a yellow warning the instant a photo is taken, offline, and the server
 * writes the authoritative value at commit. One function, so the badge on the phone and
 * the section of the report cannot disagree.
 *
 * The one auditor-chosen case is `WALK_BY_PHOTO`, and §2.7 says why: a walk-by has no
 * questionnaire, so there is no score to derive anything from. That is the *only* input a
 * client contributes, and `classify` takes it as a separate argument rather than reading
 * it off a payload, so a caller cannot pass an auditor's choice where a score belongs.
 */
export interface ClassifyEvidenceInput {
  kind: EvidenceKind;
  /** The linked response's value at capture time. Null when there is no linked response. */
  scoreAtCapture?: ResponseValue | null;
  /** The auditor's choice. Honoured for `WALK_BY_PHOTO` and ignored everywhere else. */
  auditorSelected?: EvidenceClassification | null;
}

export function classifyEvidence(input: ClassifyEvidenceInput): EvidenceClassification {
  switch (input.kind) {
    case 'QUESTION_EVIDENCE':
      return classifyScore(input.scoreAtCapture ?? null);

    case 'WALK_BY_PHOTO':
      // Auditor-selected (§2.7). NEUTRAL when they have not chosen: a photo the auditor
      // has not judged is not evidence of conformity *or* of a nonconformity, and
      // guessing either way would put it in a report section it does not belong to.
      return input.auditorSelected ?? 'NEUTRAL';

    case 'AUDITOR_SELFIE':
    case 'CORRECTIVE_AFTER':
      // Always NEUTRAL (E-1). A selfie is proof of attendance and an after-photo is proof
      // of a fix; neither is a finding.
      return 'NEUTRAL';
  }
}

/**
 * The score half of E-1, separately callable because E-2 needs exactly this: when a
 * response's value changes before completion, every attached evidence row is reclassified
 * in the same transaction, and the only input that changed is the score.
 */
export function classifyScore(value: ResponseValue | null): EvidenceClassification {
  switch (value) {
    case 'SCORE_2':
      return 'GOOD';
    case 'SCORE_1':
    case 'SCORE_0':
      return 'NONCONFORMITY';
    case 'NA':
      return 'NEUTRAL';
    case null:
      // A question photo whose response has not been saved yet. It becomes GOOD or
      // NONCONFORMITY the moment the answer arrives (E-2); until then it is unjudged.
      return 'NEUTRAL';
  }
}

/**
 * Invariant E-3: `is_summary_flagged` requires `classification IN ('GOOD','NONCONFORMITY')`.
 *
 * A `CHECK` constraint in the database says the same thing. This is here so the phone can
 * hide the flag control on a NEUTRAL photo rather than offering an action the server will
 * refuse — the constraint is the enforcement, this is the affordance.
 */
export function canBeSummaryFlagged(classification: EvidenceClassification): boolean {
  return classification === 'GOOD' || classification === 'NONCONFORMITY';
}

/**
 * The object-key convention of §5.6.
 *
 * Keys embed `unit_id` so a lifecycle rule or a per-Unit export is a prefix operation, and
 * they are built here rather than at each call site so the prefix cannot drift between the
 * uploader and the sweeper that has to find the object later.
 *
 * Nothing user-supplied enters a key: §12.8 says filenames are never used, and a key made
 * of ids is a key that cannot carry a traversal or a stored XSS.
 */
export function evidenceObjectKey(input: {
  kind: EvidenceKind;
  unitId: string;
  auditId: string;
  auditZoneId?: string | null;
  evidenceId: string;
  extension?: string;
  /** `CORRECTIVE_AFTER` only: §5.6's `corrective/{unit}/{action}/{submission}/{id}`. */
  correctiveActionId?: string | null;
  correctiveActionSubmissionId?: string | null;
}): string {
  const extension = input.extension ?? 'jpg';

  if (input.kind === 'AUDITOR_SELFIE') {
    return `selfie/${input.unitId}/${input.auditId}/${input.evidenceId}.${extension}`;
  }

  if (input.kind === 'CORRECTIVE_AFTER') {
    return (
      `corrective/${input.unitId}/${input.correctiveActionId ?? 'unlinked'}/` +
      `${input.correctiveActionSubmissionId ?? 'unlinked'}/${input.evidenceId}.${extension}`
    );
  }

  // A walk-by or question photo always belongs to a Zone; the fallback keeps the key
  // well-formed rather than producing `.../undefined/...` if one ever does not.
  const zoneSegment = input.auditZoneId ?? 'unzoned';
  return `evidence/${input.unitId}/${input.auditId}/${zoneSegment}/${input.evidenceId}.${extension}`;
}

/** The content types §12.8 allows, and the file extension each maps to. */
export const ALLOWED_IMAGE_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;

export type AllowedImageType = keyof typeof ALLOWED_IMAGE_TYPES;

export function isAllowedImageType(contentType: string): contentType is AllowedImageType {
  return contentType in ALLOWED_IMAGE_TYPES;
}

/**
 * Magic-byte sniffing (§12.8): "re-verified server-side by magic-byte sniffing during
 * `commit`".
 *
 * The declared content type is what the presigned policy enforced; this is what the bytes
 * actually are. They have to agree, because the policy constrains what a client *claimed*
 * and this constrains what a client *sent* — and a file that is not an image has no
 * business being decoded by the media worker.
 */
export function sniffImageType(header: Uint8Array): AllowedImageType | null {
  const at = (index: number): number => header[index] ?? -1;

  // JPEG: FF D8 FF
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) {
    return 'image/jpeg';
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.every((byte, index) => at(index) === byte)) {
    return 'image/png';
  }

  // WebP: "RIFF" ....  "WEBP"
  const riff = [0x52, 0x49, 0x46, 0x46];
  const webp = [0x57, 0x45, 0x42, 0x50];
  if (riff.every((byte, index) => at(index) === byte) && webp.every((byte, index) => at(8 + index) === byte)) {
    return 'image/webp';
  }

  return null;
}

/**
 * Whether the auditor, rather than the score, decides this photo's classification.
 *
 * The affordance half of E-1. `classifyEvidence` already honours `auditorSelected` for
 * `WALK_BY_PHOTO` and ignores it elsewhere, but a *caller* — the phone deciding whether to
 * show three chips, `PATCH /evidence/{id}` deciding whether a classification in the body is
 * a change or a lie — needs to ask the question before it has an answer to classify.
 *
 * There is exactly one such kind, and §2.7 says why: a walk-by has no questionnaire, so
 * there is no score to derive anything from.
 */
export function auditorChoosesClassification(kind: EvidenceKind): boolean {
  return kind === 'WALK_BY_PHOTO';
}

/**
 * The thumbnail's long edge, in pixels.
 *
 * PART 16's checklist asks that "thumbnails [be] generated for gallery views; originals
 * fetched only on demand", and a gallery tile on a laptop is ~160 px wide. 320 covers a
 * 2× display without making the thumbnail a second copy of the photograph.
 */
export const THUMBNAIL_LONG_EDGE_PX = 320;

/**
 * The thumbnail's key, derived from the original's.
 *
 * A suffix rather than a prefix, deliberately. §5.6 embeds `unit_id` in the key "so an S3
 * lifecycle or a per-Unit export can be expressed as a prefix operation" — and a
 * `thumb/...` prefix would put the thumbnails outside every such prefix, so a per-Unit
 * export would quietly miss them and a retention rule would never reach them.
 */
export function thumbnailObjectKey(objectKey: string): string {
  const dot = objectKey.lastIndexOf('.');
  return dot === -1
    ? `${objectKey}.thumb.jpg`
    : `${objectKey.slice(0, dot)}.thumb${objectKey.slice(dot)}`;
}
