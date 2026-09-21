import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AppState } from 'react-native';
import { runSync, type SyncResult } from './engine';
import { createSyncTransport } from './http-transport';
import { readFileBytes } from '../capture/media';
import { getDeviceId } from '../secure-storage';
import { useOptionalLocalDatabase } from '../db/provider';
import { useSession } from '../session';

/**
 * The sync engine's triggers (§9.3).
 *
 * > **Triggers:** connectivity regained · app foreground · every 60 s while online ·
 * > after audit/zone completion (high priority) · manual **Sync Now** · background fetch.
 *
 * Foreground, the periodic tick and the manual button live here. Completion is a call to
 * `sync()` from the screen that completes; background fetch is an `expo-background-task`
 * registration that belongs with the production build rather than the JS bundle.
 *
 * One cycle at a time, always. Two concurrent drains would both read the same PENDING rows
 * and push the same items in two batches — which the server would deduplicate correctly,
 * and which would still waste the scarce thing.
 *
 * Only a role that holds `sync:push` syncs. A Coordinator (R-24) manages from the phone with
 * live server data and records nothing offline; the server refuses them sync (§6.3), and a
 * cycle that could only fail every sixty seconds would read as a broken app.
 */
interface SyncContextValue {
  sync: () => Promise<SyncResult>;
  syncing: boolean;
  online: boolean;
  lastResult: SyncResult | null;
}

const SyncContext = createContext<SyncContextValue | null>(null);

/** Every 60 s while online (§9.3). */
const TICK_MS = 60_000;

const IDLE: SyncResult = { accepted: 0, conflicted: 0, failed: 0, deferred: 0, photosUploaded: 0, idle: true };

export function SyncProvider({ children }: { children: ReactNode }) {
  const database = useOptionalLocalDatabase();
  const { status, can } = useSession();
  const allowed = status === 'ready' && can('sync', 'push') && database !== null;
  const allowedRef = useRef(allowed);
  allowedRef.current = allowed;
  const [syncing, setSyncing] = useState(false);
  const [online, setOnline] = useState(true);
  const [lastResult, setLastResult] = useState<SyncResult | null>(null);
  const running = useRef(false);
  const again = useRef(false);
  const latest = useRef<() => Promise<SyncResult>>(async () => IDLE);

  const sync = useCallback(async (): Promise<SyncResult> => {
    if (!allowedRef.current) return IDLE;
    if (running.current) {
      // Remember it: whatever was written since this cycle read the outbox goes out next.
      again.current = true;
      return IDLE;
    }
    running.current = true;
    setSyncing(true);

    try {
      const transport = createSyncTransport(readFileBytes);
      // `allowed` guarantees a database; the guard is for the type.
      if (!database) return IDLE;
      const result = await runSync(database, transport, { deviceId: await getDeviceId() });

      // Connectivity is inferred from the attempt rather than from a listener: a device
      // that just pushed successfully is online, whatever a radio API claims.
      setOnline(result.error === undefined);
      setLastResult(result);
      return result;
    } catch {
      setOnline(false);
      // A sync that fails is not an error state for the app: §9.1 makes the local store the
      // source of truth while an audit is running, so the screens are unaffected.
      return {
        accepted: 0,
        conflicted: 0,
        failed: 0,
        deferred: 0,
        photosUploaded: 0,
        idle: false,
        error: 'Sync failed',
      };
    } finally {
      running.current = false;
      setSyncing(false);
      if (again.current) {
        again.current = false;
        void latest.current();
      }
    }
  }, [database]);
  latest.current = sync;

  useEffect(() => {
    if (!allowed) return;
    void sync();
    const timer = setInterval(() => void sync(), TICK_MS);

    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void sync();
    });

    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [sync, allowed]);

  const value = useMemo(
    () => ({ sync, syncing, online, lastResult }),
    [sync, syncing, online, lastResult],
  );

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

export function useSync(): SyncContextValue {
  const value = useContext(SyncContext);
  if (!value) {
    throw new Error('useSync must be used inside a SyncProvider');
  }
  return value;
}
