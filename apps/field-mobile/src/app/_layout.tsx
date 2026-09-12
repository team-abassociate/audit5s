// Must stay the first import: Hermes defines no global `crypto`, and the device id minted
// on every API request needs one.
import '../lib/crypto-polyfill';
import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Slot, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LocalDatabaseProvider } from '../lib/db/provider';
import { SessionProvider, useSession } from '../lib/session';
import { SyncProvider } from '../lib/sync/provider';
import { SyncStatusBar } from '../components/sync-status-bar';
import { theme } from '../lib/theme';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Field devices lose the network constantly; a failed fetch is usually a tunnel,
      // not a dead server. Reference data no longer depends on this at all — it is read
      // from SQLite and refreshed by the catalogue sync.
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
    // Screens pushed on top of a tab — a Unit's Zones, a checklist — are part of the
    // signed-in app, so a redirect back to the tab root would make every drill-down
    // bounce straight home.
    const insideApp =
      group === '(tabs)' ||
      group === 'unit' ||
      group === 'checklist' ||
      group === 'audit' ||
      group === 'walk-by' ||
      group === 'actions' ||
      group === 'notifications' ||
      // A signed-in Zone Leader following a link from a PDF lands here.
      group === 'ca';

    // A corrective-action link is a credential in its own right (§10.4): somebody
    // following one from a PDF may have no account at all, and bouncing them to a login
    // screen would strand a response the business is waiting for. The route itself decides
    // where they go — the app if they are signed in, the web page if they are not.
    if (group === 'ca') return;

    if (status === 'signed-out' && group !== 'login') {
      router.replace('/login');
    } else if (status === 'must-reset' && group !== 'reset-password') {
      router.replace('/reset-password');
    } else if (status === 'ready' && !insideApp) {
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

  // §9.9: the status affordance is on **every** field screen, not on a sync page nobody
  // visits. The login and forced-reset screens are the exception — there is no device
  // store to report on until somebody is signed in.
  const signedIn = status === 'ready';

  return (
    <>
      {signedIn && <SyncStatusBar />}
      <Slot />
    </>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <LocalDatabaseProvider>
          <SessionProvider>
            <SyncProvider>
              <StatusBar style="light" />
              <AuthGate />
            </SyncProvider>
          </SessionProvider>
        </LocalDatabaseProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
