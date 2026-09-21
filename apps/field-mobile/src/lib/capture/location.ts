import * as Location from 'expo-location';
import type { LocationProvider, LocationReading } from '@audit5s/contracts';

/**
 * Location capture (§12.9, STACK.md §2's `expo-location`).
 *
 * §12.9 is the whole specification of this file, and it is unusually blunt: **mobile GPS
 * cannot prove presence.** So this records what the OS says and makes no claim about it.
 * Three consequences are visible in the code:
 *
 *   - `readLocation()` **never throws and never waits for a fix**. A denied permission, a
 *     disabled radio and a timeout all return `null`, and every caller treats null as "no
 *     reading" rather than as a failure. Blocking an audit on a location fix "would strand honest auditors in
 *     steel-framed buildings while barely inconveniencing a determined faker".
 *   - `isMocked` is recorded exactly as reported and trusted no further. It is a signal for
 *     a reviewer, not a verdict.
 *   - Nothing here computes a distance. §12.9 requires the server to do that from the
 *     Unit's stored coordinates, "never trusting a client-computed distance".
 */

/** How long a background fix may take before it is abandoned. It never holds up a photo. */
const FIX_TIMEOUT_MS = 15_000;

/** A reading older than this is not "where the photo was taken". */
const FRESH_MS = 2 * 60_000;

/** The most a capture will wait for the OS's last-known position. */
const LAST_KNOWN_WAIT_MS = 300;

let permission: Promise<boolean> | null = null;
let latest: LocationReading | null = null;
let inFlight: Promise<void> | null = null;

export async function requestLocationPermission(): Promise<boolean> {
  // Asked once per launch. Each call used to be a native round trip on every photograph.
  permission ??= Location.requestForegroundPermissionsAsync()
    .then(({ status }) => status === 'granted')
    .catch(() => false);
  const granted = await permission;
  if (!granted) permission = null; // Let a later screen ask again after a denial.
  return granted;
}

/**
 * Starts a fix in the background and keeps the result. Called when a camera opens, so by
 * the time the shutter is pressed — seconds later — a reading is usually waiting.
 */
export function warmLocation(): void {
  if (inFlight) return;
  inFlight = (async () => {
    try {
      if (!(await requestLocationPermission())) return;
      const position = await withTimeout(
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
        FIX_TIMEOUT_MS,
      );
      if (position) latest = toReading(position);
    } catch {
      // No reading; see `readLocation`.
    } finally {
      inFlight = null;
    }
  })();
}

/**
 * The best reading available **now**, or `null` — never a wait for satellites.
 *
 * Null is an ordinary answer. The server records the absence and flags it for review
 * (`LOCATION_ABSENT`), which is the honest handling: the auditor may simply have declined
 * the permission prompt, and they have done nothing wrong. Waiting for a fix used to hold
 * every photograph for up to eight seconds indoors; now the camera warms one up while the
 * auditor frames the shot, and the shutter takes whatever is ready.
 */
export async function readLocation(): Promise<LocationReading | null> {
  try {
    if (latest && Date.now() - Date.parse(latest.capturedAt ?? '') < FRESH_MS) {
      return latest;
    }
    warmLocation();
    const known = await withTimeout(
      Location.getLastKnownPositionAsync({ maxAge: FRESH_MS }),
      LAST_KNOWN_WAIT_MS,
    );
    return known ? toReading(known) : null;
  } catch {
    // Any failure at all is "no reading". There is no error state a field screen could
    // usefully show, and there is certainly no reason to stop an audit over one.
    return null;
  }
}

function toReading(position: Location.LocationObject): LocationReading {
  return {
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    accuracyM: position.coords.accuracy ?? null,
    provider: providerOf(position),
    // As reported by the OS — itself defeatable, and §12.9 says so out loud.
    isMocked: position.mocked === true,
    capturedAt: new Date(position.timestamp).toISOString(),
  };
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
