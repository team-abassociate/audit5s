/** Per audit Zone, shared across all five Ss; selfies and after-photos are separate. */
export const ZONE_PHOTO_LIMIT = 25;
export const ZONE_PHOTO_LIMIT_MESSAGE =
  'This Zone has reached its 25-photo limit. Remove a photo from this Zone before taking another.';
export const isZoneAuditPhoto = (kind: string): boolean =>
  kind === 'QUESTION_EVIDENCE' || kind === 'WALK_BY_PHOTO';
