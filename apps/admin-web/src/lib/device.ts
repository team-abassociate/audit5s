import { useQuery } from '@tanstack/react-query';
import type { Device } from '@audit5s/contracts';
import { uuidv7 } from '@audit5s/domain';
import { api, deviceApi } from '@/lib/api';
import { useSession } from '@/lib/session';

/**
 * This browser as a device (R-51). An audit in progress belongs to one device (D7); on
 * the web that device is this browser, for this person. The id is kept per person, because
 * a device id names somebody's device: registering one that is somebody else's is refused
 * (registering is not a way onto another person's device). Storage that throws (a private
 * window) still yields a working id for the session, it simply is not remembered.
 */
const KEY = 'audit5s.web-device.';
const memory = new Map<string, string>();

function deviceIdFor(userId: string): string {
  try {
    const stored = localStorage.getItem(KEY + userId);
    if (stored) return stored;
    const minted = uuidv7();
    localStorage.setItem(KEY + userId, minted);
    return minted;
  } catch {
    if (!memory.has(userId)) memory.set(userId, uuidv7());
    return memory.get(userId)!;
  }
}

/** Registers this browser once per session and hands back the device-bound client. */
export function useWebDevice() {
  const { user } = useSession();
  const query = useQuery({
    queryKey: ['web-device', user?.id],
    enabled: Boolean(user),
    staleTime: Infinity,
    queryFn: async () => {
      const deviceId = deviceIdFor(user!.id);
      await api.post<Device>('/devices/register', {
        deviceId,
        platform: 'web',
        model: navigator.userAgent.slice(0, 120),
        appVersion: 'web',
      });
      return deviceId;
    },
  });
  return {
    ...query,
    deviceId: query.data ?? null,
    client: query.data ? deviceApi(query.data) : null,
  };
}
