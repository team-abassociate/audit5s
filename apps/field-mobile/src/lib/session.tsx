import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import type { LoginResponse, MeResponse, ResolvedScope, AuthenticatedUser } from '@audit5s/contracts';
import { api, setSession, setSessionLostHandler, getSession } from './api';
import { getDeviceId } from './secure-storage';

interface SessionState {
  status: 'loading' | 'signed-out' | 'must-reset' | 'ready';
  user: AuthenticatedUser | null;
  scope: ResolvedScope | null;
}

interface SessionContextValue extends SessionState {
  signIn(loginId: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  changePassword(currentPassword: string, newPassword: string): Promise<void>;
  refreshMe(): Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

const INITIAL: SessionState = { status: 'loading', user: null, scope: null };

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>(INITIAL);

  const applyMe = useCallback((me: MeResponse) => {
    setState({
      // CH-1: a pending reset is a distinct app state, not a banner. Every screen except
      // the reset form is closed until it clears, which mirrors what the API enforces.
      status: me.user.mustResetPassword ? 'must-reset' : 'ready',
      user: me.user,
      scope: me.scope,
    });
  }, []);

  const refreshMe = useCallback(async () => {
    try {
      applyMe(await api.get<MeResponse>('/auth/me'));
    } catch {
      await setSession(null);
      setState({ status: 'signed-out', user: null, scope: null });
    }
  }, [applyMe]);

  // Restore a stored session on launch. The tokens are in the keystore, so this is the
  // only place the app learns whether it is signed in.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const stored = await getSession();
      if (cancelled) return;
      if (!stored) {
        setState({ status: 'signed-out', user: null, scope: null });
        return;
      }
      await refreshMe();
    })();

    setSessionLostHandler(() => {
      setState({ status: 'signed-out', user: null, scope: null });
    });

    return () => {
      cancelled = true;
      setSessionLostHandler(null);
    };
  }, [refreshMe]);

  const signIn = useCallback(
    async (loginId: string, password: string) => {
      const response = await api.post<LoginResponse>('/auth/login', {
        loginId: loginId.trim().toUpperCase(),
        password,
        // Registers the device in the same call, so a fresh install appears in the
        // Super Admin's device list from its first sign-in.
        deviceId: await getDeviceId(),
        platform: Platform.OS === 'ios' ? 'ios' : 'android',
        model: Constants.deviceName ?? undefined,
        osVersion: String(Platform.Version),
        appVersion: Constants.expoConfig?.version ?? undefined,
      });

      await setSession({
        accessToken: response.accessToken,
        refreshToken: response.refreshToken,
      });

      setState({
        status: response.mustResetPassword ? 'must-reset' : 'ready',
        user: response.user,
        scope: response.scope,
      });
    },
    [],
  );

  const signOut = useCallback(async () => {
    const stored = await getSession();
    if (stored) {
      // Best effort: a failed logout call must still sign the device out locally.
      await api.post('/auth/logout', { refreshToken: stored.refreshToken }).catch(() => undefined);
    }
    await setSession(null);
    setState({ status: 'signed-out', user: null, scope: null });
  }, []);

  const changePassword = useCallback(
    async (currentPassword: string, newPassword: string) => {
      await api.post('/auth/change-password', { currentPassword, newPassword });
      // The server revokes every other session on a password change, including this
      // device's refresh family, so sign in again rather than trusting stale tokens.
      await setSession(null);
      setState({ status: 'signed-out', user: null, scope: null });
    },
    [],
  );

  const value = useMemo<SessionContextValue>(
    () => ({ ...state, signIn, signOut, changePassword, refreshMe }),
    [state, signIn, signOut, changePassword, refreshMe],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) {
    throw new Error('useSession must be used inside a SessionProvider');
  }
  return value;
}
