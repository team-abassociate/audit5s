import * as Location from 'expo-location';
import type { LocationProvider, LocationReading } from '@audit5s/contracts';

/**
 * Location capture (§12.9, STACK.md §2's `expo-location`).
 *
 * §12.9 is the whole specification of this file, and it is unusually blunt: **mobile GPS
 * cannot prove presence.** So this records what the OS says and makes no claim about it.
 * Three consequences are visible in the code:
 *
 *   - `read()` **never throws and never blocks**. A denied permission, a disabled radio and
 *     a timeout all return `null`, and every caller treats null as "no reading" rather than
 *     as a failure. Blocking an audit on a location fix "would strand honest auditors in
 *     steel-framed buildings while barely inconveniencing a determined faker".
 *   - `isMocked` is recorded exactly as reported and trusted no further. It is a signal for
 *     a reviewer, not a verdict.
 *   - Nothing here computes a distance. §12.9 requires the server to do that from the
 *     Unit's stored coordinates, "never trusting a client-computed distance".
 */

/** Long enough to get a fix outdoors, short enough not to stall a start screen. */
const FIX_TIMEOUT_MS = 8_000;

export async function requestLocationPermission(): Promise<boolean> {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    return status === 'granted';
  } catch {
    return false;
  }
}

/**
 * One reading, or `null`.
 *
 * Null is an ordinary answer. The server records the absence and flags it for review
 * (`LOCATION_ABSENT`), which is the honest handling: the auditor may simply have declined
 * the permission prompt, and they have done nothing wrong.
 */
export async function readLocation(): Promise<LocationReading | null> {
  try {
    if (!(await requestLocationPermission())) {
      return null;
    }

    const position = await withTimeout(
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      FIX_TIMEOUT_MS,
    );
    if (!position) return null;

    return {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracyM: position.coords.accuracy ?? null,
      provider: providerOf(position),
      // As reported by the OS — itself defeatable, and §12.9 says so out loud.
      isMocked: position.mocked === true,
      capturedAt: new Date(position.timestamp).toISOString(),
    };
  } catch {
    // Any failure at all is "no reading". There is no error state a field screen could
    // usefully show, and there is certainly no reason to stop an audit over one.
    return null;
  }
}

/**
 * Which provider the OS used.
 *
 * `expo-location` does not expose Android's provider string, so this is inferred from the
 * accuracy it reports: a sub-30-metre fix is satellite-derived in practice, and a coarser
 * one came from cell towers or Wi-Fi. It is labelled `FUSED` rather than `GPS` when
 * uncertain, because claiming a more authoritative source than we know is exactly the kind
 * of overstatement §12.9 warns against.
 */
function providerOf(position: Location.LocationObject): LocationProvider {
  const accuracy = position.coords.accuracy;
  if (accuracy === null || accuracy === undefined) return 'UNKNOWN';
  return accuracy <= 30 ? 'FUSED' : 'NETWORK';
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}
