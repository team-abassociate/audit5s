import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GEOFENCE_RADIUS_M,
  IMPLAUSIBLE_ACCURACY_M,
  assessLocation,
  haversineMetres,
} from './geofence';

/**
 * §12.9, tested for the two properties it insists on: the distance is computed here from
 * the Unit's own coordinates, and **nothing this file produces blocks an audit**.
 *
 * The second is the one worth a test rather than a comment. It is the property a future
 * change is most likely to break — "surely we should refuse an audit from 40 km away" is a
 * reasonable-sounding sentence, and §12.9 explains at length why it is wrong.
 */

// The Nashik plant of the sample reports, and points measured from it.
const UNIT = { latitude: 19.9975, longitude: 73.7898, geofenceRadiusM: 300 };

describe('haversineMetres', () => {
  it('is zero at the same point', () => {
    expect(haversineMetres(UNIT, UNIT)).toBe(0);
  });

  it('measures a known separation', () => {
    // One degree of latitude is ~111.2 km anywhere on the sphere.
    const north = { latitude: UNIT.latitude + 1, longitude: UNIT.longitude };
    expect(haversineMetres(UNIT, north)).toBeGreaterThan(111_000);
    expect(haversineMetres(UNIT, north)).toBeLessThan(111_400);
  });

  it('is symmetric', () => {
    const other = { latitude: 19.9, longitude: 73.7 };
    expect(haversineMetres(UNIT, other)).toBeCloseTo(haversineMetres(other, UNIT), 6);
  });

  it('handles the antimeridian without producing a half-planet error', () => {
    const west = { latitude: 0, longitude: -179.999 };
    const east = { latitude: 0, longitude: 179.999 };
    // Two points 0.002° apart across the date line are ~222 m apart, not ~40,000 km.
    expect(haversineMetres(west, east)).toBeLessThan(300);
  });
});

describe('assessLocation', () => {
  it('accepts a reading inside the geofence with nothing flagged', () => {
    const reading = { latitude: 19.9977, longitude: 73.79, accuracyM: 12, isMocked: false };
    const assessment = assessLocation(reading, UNIT);

    expect(assessment.distanceM).not.toBeNull();
    expect(assessment.distanceM!).toBeLessThan(300);
    expect(assessment.suspicious).toBe(false);
    expect(assessment.reasons).toEqual([]);
  });

  it('flags a reading beyond the Unit’s radius', () => {
    const reading = { latitude: 20.05, longitude: 73.85, accuracyM: 10, isMocked: false };
    const assessment = assessLocation(reading, UNIT);

    expect(assessment.suspicious).toBe(true);
    expect(assessment.reasons).toContain('OUTSIDE_GEOFENCE');
    expect(assessment.distanceM!).toBeGreaterThan(300);
  });

  it('uses the Unit’s own radius, not a constant', () => {
    const reading = { latitude: 20.05, longitude: 73.85, accuracyM: 10, isMocked: false };
    // A plant with a two-kilometre perimeter is a plant, not a suspect.
    const wide = assessLocation(reading, { ...UNIT, geofenceRadiusM: 20_000 });
    expect(wide.reasons).not.toContain('OUTSIDE_GEOFENCE');
    expect(wide.suspicious).toBe(false);
  });

  it('falls back to the §5.2 default radius when the Unit has none', () => {
    const justOutside = { latitude: 20.001, longitude: 73.7898, accuracyM: 8, isMocked: false };
    const assessment = assessLocation(justOutside, { ...UNIT, geofenceRadiusM: null });

    expect(DEFAULT_GEOFENCE_RADIUS_M).toBe(300);
    expect(assessment.distanceM!).toBeGreaterThan(DEFAULT_GEOFENCE_RADIUS_M);
    expect(assessment.reasons).toContain('OUTSIDE_GEOFENCE');
  });

  it('flags a mocked provider, and records it as reported rather than as proven', () => {
    const reading = { latitude: 19.9977, longitude: 73.79, accuracyM: 12, isMocked: true };
    const assessment = assessLocation(reading, UNIT);

    expect(assessment.reasons).toEqual(['MOCK_PROVIDER']);
    // Inside the fence and still flagged: the flag is about the provider, not the place.
    expect(assessment.distanceM!).toBeLessThan(300);
  });

  it('flags implausibly good accuracy', () => {
    const reading = {
      latitude: 19.9977,
      longitude: 73.79,
      accuracyM: IMPLAUSIBLE_ACCURACY_M - 1,
      isMocked: false,
    };
    expect(assessLocation(reading, UNIT).reasons).toContain('IMPLAUSIBLE_ACCURACY');
  });

  it('does not flag ordinary consumer-GPS accuracy', () => {
    for (const accuracyM of [3, 5, 12, 40, 65]) {
      const reading = { latitude: 19.9977, longitude: 73.79, accuracyM, isMocked: false };
      expect(assessLocation(reading, UNIT).reasons).not.toContain('IMPLAUSIBLE_ACCURACY');
    }
  });

  it('flags an absent reading', () => {
    expect(assessLocation(null, UNIT)).toEqual({
      distanceM: null,
      suspicious: true,
      reasons: ['LOCATION_ABSENT'],
    });
  });

  it('reports a Unit with no coordinates as uncheckable rather than as clean', () => {
    const reading = { latitude: 19.9977, longitude: 73.79, accuracyM: 12, isMocked: false };
    const assessment = assessLocation(reading, {
      latitude: null,
      longitude: null,
      geofenceRadiusM: 300,
    });

    expect(assessment.distanceM).toBeNull();
    expect(assessment.reasons).toContain('UNIT_NOT_GEOCODED');
    expect(assessment.suspicious).toBe(true);
  });

  it('accumulates every reason rather than stopping at the first', () => {
    const reading = { latitude: 20.05, longitude: 73.85, accuracyM: 1, isMocked: true };
    const assessment = assessLocation(reading, UNIT);

    // A reviewer needs all of it: "mocked, 8 km away, claiming 1 m accuracy" is a story;
    // "outside the geofence" alone is not.
    expect(assessment.reasons).toEqual(
      expect.arrayContaining(['MOCK_PROVIDER', 'IMPLAUSIBLE_ACCURACY', 'OUTSIDE_GEOFENCE']),
    );
  });

  it('never returns anything a caller could read as a refusal (§12.9)', () => {
    // The worst reading the system can be handed, from a rooted phone in another state.
    const worst = { latitude: -33.86, longitude: 151.2, accuracyM: 0.5, isMocked: true };
    const assessment = assessLocation(worst, UNIT);

    expect(assessment.suspicious).toBe(true);
    // The shape is the guarantee: three fields, none of them a verdict on whether the
    // audit may proceed. Blocking would strand honest auditors indoors and barely
    // inconvenience a determined faker.
    expect(Object.keys(assessment).sort()).toEqual(['distanceM', 'reasons', 'suspicious']);
  });
});
