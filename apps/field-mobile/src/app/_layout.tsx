import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Slot, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionProvider, useSession } from '../lib/session';
import { theme } from '../lib/theme';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Field devices lose the network constantly; a failed fetch is usually a tunnel,
      // not a dead server. Phase 4 replaces this with the SQLite-backed offline store.
      retry: 2,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

/**
 * Routes on session state.
 *
 * `must-reset` is a whole app state, not a prompt: CH-1 makes the phone number a bootstrap
 * credential, and the API closes every other route until it is rotated. The navigation
 * mirrors that rather than letting the user reach a tab that would only 403.
 */
function AuthGate() {
  const { status } = useSession();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (status === 'loading') return;

    const group = segments[0];
    const inTabs = group === '(tabs)';

    if (status === 'signed-out' && group !== 'login') {
      router.replace('/login');
    } else if (status === 'must-reset' && group !== 'reset-password') {
      router.replace('/reset-password');
    } else if (status === 'ready' && !inTabs) {
      router.replace('/');
    }
  }, [status, segments, router]);

  if (status === 'loading') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.color.background }}>
        <ActivityIndicator color={theme.color.brand} />
      </View>
    );
  }

  return <Slot />;
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>
          <StatusBar style="light" />
          <AuthGate />
        </SessionProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
