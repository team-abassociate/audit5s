import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { MeResponse, LoginRequest, LoginResponse, ResolvedScope } from '@audit5s/contracts';
import { api, loadSession, onSessionLost, setSession } from './api';

interface SessionState {
  user: MeResponse['user'] | null;
  scope: ResolvedScope | null;
  loading: boolean;
  signIn: (credentials: LoginRequest) => Promise<LoginResponse>;
  signOut: () => Promise<void>;
  reload: () => Promise<void>;
  /** True while the bootstrap credential is still in place (CH-1). */
  mustResetPassword: boolean;
  /**
   * Permission check, from the **server-resolved** scope. The client never computes
   * permissions itself (§8.3) — it renders what /auth/me says it holds.
   */
  can: (resource: string, action: string) => boolean;
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<MeResponse['user'] | null>(null);
  const [scope, setScope] = useState<ResolvedScope | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!loadSession()) {
      setUser(null);
      setScope(null);
      setLoading(false);
      return;
    }
    try {
      const me = await api.get<MeResponse>('/auth/me');
      setUser(me.user);
      setScope(me.scope);
    } catch {
      setUser(null);
      setScope(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    onSessionLost(() => {
      setUser(null);
      setScope(null);
    });
    void reload();
  }, [reload]);

  const signIn = useCallback(
    async (credentials: LoginRequest) => {
      const result = await api.post<LoginResponse>('/auth/login', credentials);
      setSession({ accessToken: result.accessToken, refreshToken: result.refreshToken });
      setUser(result.user);
      setScope(result.scope);
      setLoading(false);
      return result;
    },
    [],
  );

  const signOut = useCallback(async () => {
    const current = loadSession();
    if (current) {
      await api.post('/auth/logout', { refreshToken: current.refreshToken }).catch(() => undefined);
    }
    setSession(null);
    setUser(null);
    setScope(null);
  }, []);

  const value = useMemo<SessionState>(
    () => ({
      user,
      scope,
      loading,
      signIn,
      signOut,
      reload,
      mustResetPassword: user?.mustResetPassword ?? false,
      can: (resource, action) => scope?.permissions.includes(`${resource}:${action}`) ?? false,
    }),
    [user, scope, loading, signIn, signOut, reload],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const context = useContext(SessionContext);
  if (!context) {
    throw new Error('useSession must be used inside a SessionProvider');
  }
  return context;
}
