import type { LocationProvider } from '@audit5s/contracts';

/**
 * Geofence distance and the `location_suspicious` flag (ARCHITECTURE.md §12.9).
 *
 * §12.9 is unusually explicit, and this file exists to keep it honest:
 *
 * > **Mobile GPS cannot prove presence.** Mock-location providers, rooted devices and
 * > modified builds can all report arbitrary coordinates. This system therefore makes no
 * > anti-spoofing claim.
 *
 * So there are two rules here that are not negotiable and are asserted by tests:
 *
 *   1. **The distance is computed server-side from the stored Unit coordinates** — never
 *      trusting a client-computed distance. That is why this takes a Unit and a reading
 *      rather than a number.
 *   2. **Nothing this returns blocks anything.** `assessLocation` has no "allowed" field
 *      and no exception, because blocking "would strand honest auditors in steel-framed
 *      buildings while barely inconveniencing a determined faker". It produces a flag and
 *      a list of reasons for a human reviewer, and that is the whole of its authority.
 */

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

/** Mean Earth radius, in metres. */
const EARTH_RADIUS_M = 6_371_008.8;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * Great-circle distance in metres.
 *
 * Haversine rather than a projected approximation: a Unit's geofence is a few hundred
 * metres, where any spherical formula is accurate to well under a metre, and haversine is
 * the one that stays correct if someone later compares two plants a thousand kilometres
 * apart on a trend chart.
 */
export function haversineMetres(from: GeoPoint, to: GeoPoint): number {
  const deltaLat = toRadians(to.latitude - from.latitude);
  const deltaLon = toRadians(to.longitude - from.longitude);
  const fromLat = toRadians(from.latitude);
  const toLat = toRadians(to.latitude);

  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.sin(deltaLon / 2) ** 2 * Math.cos(fromLat) * Math.cos(toLat);

  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Why a reading was flagged. Rendered to a reviewer; never turned into a refusal. */
export type LocationSuspicionReason =
  /** No reading at all — the auditor denied permission, or the fix never arrived. */
  | 'LOCATION_ABSENT'
  /** Beyond the Unit's `geofence_radius_m`. */
  | 'OUTSIDE_GEOFENCE'
  /** The OS reported a mock provider. Itself defeatable, and recorded as such (§12.9). */
  | 'MOCK_PROVIDER'
  /** Implausibly good accuracy — consumer GPS does not do this outdoors, let alone indoors. */
  | 'IMPLAUSIBLE_ACCURACY'
  /** A reading exists but the Unit has no coordinates, so no distance can be computed. */
  | 'UNIT_NOT_GEOCODED';

export interface LocationReadingInput {
  latitude: number;
  longitude: number;
  accuracyM?: number | null;
  provider?: LocationProvider;
  isMocked?: boolean;
}

export interface UnitGeofence {
  latitude: number | null;
  longitude: number | null;
  /** §5.2's default is 300 m; a Unit may widen it. */
  geofenceRadiusM: number | null;
}

export interface LocationAssessment {
  /** Metres from the Unit's stored coordinates, or null when either side is missing. */
  distanceM: number | null;
  suspicious: boolean;
  reasons: LocationSuspicionReason[];
}

/**
 * §12.9's accuracy tripwire: "when accuracy is implausibly good (<3 m consistently)".
 *
 * One reading below this is a *signal*, not a verdict — which is exactly how it is used:
 * it contributes a reason, and reasons are shown to a reviewer rather than acted on.
 */
export const IMPLAUSIBLE_ACCURACY_M = 3;

/** Used when a Unit has coordinates but no radius of its own (§5.2's default). */
export const DEFAULT_GEOFENCE_RADIUS_M = 300;

/**
 * Assesses one location reading against one Unit.
 *
 * Note what is missing: there is no `blocked`, no thrown error, and no branch a caller
 * could read as permission. §12.9 recommends treating location as supporting evidence in
 * a review process, and the shape of this return value is that recommendation made
 * structural — the only thing a caller can do with it is store it and show it.
 */
export function assessLocation(
  reading: LocationReadingInput | null | undefined,
  unit: UnitGeofence,
): LocationAssessment {
  const reasons: LocationSuspicionReason[] = [];

  if (!reading) {
    // Absent location is itself a flag (§12.9), and still not a refusal: an auditor who
    // declined the permission prompt has done nothing wrong, and their work is not lost.
    return { distanceM: null, suspicious: true, reasons: ['LOCATION_ABSENT'] };
  }

  if (reading.isMocked === true) {
    reasons.push('MOCK_PROVIDER');
  }

  if (
    reading.accuracyM !== null &&
    reading.accuracyM !== undefined &&
    reading.accuracyM > 0 &&
    reading.accuracyM < IMPLAUSIBLE_ACCURACY_M
  ) {
    reasons.push('IMPLAUSIBLE_ACCURACY');
  }

  if (unit.latitude === null || unit.longitude === null) {
    // Nothing to measure against. Flagged so it shows up as "we could not check" rather
    // than passing silently — a Unit nobody geocoded is an operational gap, not a clean bill.
    reasons.push('UNIT_NOT_GEOCODED');
    return { distanceM: null, suspicious: reasons.length > 0, reasons };
  }

  const distanceM = haversineMetres(
    { latitude: reading.latitude, longitude: reading.longitude },
    { latitude: unit.latitude, longitude: unit.longitude },
  );

  const radius = unit.geofenceRadiusM ?? DEFAULT_GEOFENCE_RADIUS_M;
  if (distanceM > radius) {
    reasons.push('OUTSIDE_GEOFENCE');
  }

  return { distanceM, suspicious: reasons.length > 0, reasons };
}
