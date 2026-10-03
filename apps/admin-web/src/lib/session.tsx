import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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

/** `/auth/me`, cached: one request per sign-in or reload, not one per screen. */
const ME_KEY = ['auth', 'me'] as const;
const fetchMe = () => api.get<MeResponse>('/auth/me');

export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [signedIn, setSignedIn] = useState(() => loadSession() !== null);

  const me = useQuery({
    queryKey: ME_KEY,
    queryFn: fetchMe,
    enabled: signedIn,
    // What a role may do changes when an administrator changes it, not every 30 seconds.
    // The API refuses a stale permission regardless; a reload or a sign-in refreshes it.
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const user = signedIn ? (me.data?.user ?? null) : null;
  const scope = signedIn ? (me.data?.scope ?? null) : null;
  const loading = signedIn && me.isPending;

  const forget = useCallback(() => {
    setSignedIn(false);
    // Someone else may sign in next in this tab: nothing the last person fetched survives.
    queryClient.clear();
  }, [queryClient]);

  const reload = useCallback(async () => {
    if (!loadSession()) {
      forget();
      return;
    }
    setSignedIn(true);
    await queryClient.fetchQuery({ queryKey: ME_KEY, queryFn: fetchMe, staleTime: 0 }).catch(() => undefined);
  }, [forget, queryClient]);

  useEffect(() => {
    onSessionLost(forget);
  }, [forget]);

  const signIn = useCallback(
    async (credentials: LoginRequest) => {
      const result = await api.post<LoginResponse>('/auth/login', credentials);
      setSession({ accessToken: result.accessToken, refreshToken: result.refreshToken });
      queryClient.setQueryData<MeResponse>(ME_KEY, { user: result.user, scope: result.scope });
      setSignedIn(true);
      return result;
    },
    [queryClient],
  );

  const signOut = useCallback(async () => {
    const current = loadSession();
    if (current) {
      await api.post('/auth/logout', { refreshToken: current.refreshToken }).catch(() => undefined);
    }
    setSession(null);
    forget();
  }, [forget]);

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
