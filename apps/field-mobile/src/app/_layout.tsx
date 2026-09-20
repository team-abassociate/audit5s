// Must stay the first import: Hermes defines no global `crypto`, and the device id minted
// on every API request needs one.
import '../lib/crypto-polyfill';
import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useFonts } from 'expo-font';
import { Archivo_400Regular } from '@expo-google-fonts/archivo/400Regular';
import { Archivo_600SemiBold } from '@expo-google-fonts/archivo/600SemiBold';
import { Archivo_800ExtraBold } from '@expo-google-fonts/archivo/800ExtraBold';
import { Archivo_900Black } from '@expo-google-fonts/archivo/900Black';
import { DMMono_400Regular } from '@expo-google-fonts/dm-mono/400Regular';
import { DMMono_500Medium } from '@expo-google-fonts/dm-mono/500Medium';
import { Stack, useRouter, useSegments } from 'expo-router';
import { SafeAreaInsetsContext, SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LocalDatabaseProvider } from '../lib/db/provider';
import { SessionProvider, useSession } from '../lib/session';
import { SyncProvider } from '../lib/sync/provider';
import { SyncStatusBar } from '../components/sync-status-bar';
import { HeaderTitle } from '../components/ui';
import { ThemedStatusBar, ThemeProvider } from '../lib/theme-provider';
import { useTheme } from '../lib/theme';

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
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { status } = useSession();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (status === 'loading') return;

    const group = segments[0];
    // Screens pushed on top of a tab — a Unit's Zones, an audit — are part of the
    // signed-in app, so a redirect back to the tab root would make every drill-down
    // bounce straight home.
    const insideApp =
      group === '(tabs)' ||
      group === 'unit' ||
      group === 'audit' ||
      group === 'walk-by' ||
      group === 'actions' ||
      group === 'notifications' ||
      group === 'manage' ||
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
      router.replace('/overview');
    } else if (status === 'ready' && group === '(tabs)' && segments.length === 1) {
      // The field Units tab is the app's root route, and nobody's home any more: every
      // role lands on Overview, which is their own version of it (R-24, and the field
      // Overview beside it).
      router.replace('/overview');
    }
  }, [status, segments, router]);

  if (status === 'loading') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.color.board }}>
        <ActivityIndicator color={theme.color.ink} />
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
      {/* The sync bar already pads for the status bar; headers below it must not pad again. */}
      <SafeAreaInsetsContext.Provider value={signedIn ? { ...insets, top: 0 } : insets}>
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: theme.color.tile2 },
            headerTintColor: theme.color.ink,
            headerTitle: ({ children }) => <HeaderTitle>{children}</HeaderTitle>,
            headerShadowVisible: false,
            // The sync bar above already clears the status bar. The native Android header
            // reads the window inset itself, ignoring the zeroed context above, so without
            // this every pushed screen carried a second status-bar-high band over its title.
            unstable_nativeProps: { headerConfig: { disableTopInsetApplication: signedIn } },
            contentStyle: { backgroundColor: theme.color.board },
          }}
        >
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="login" options={{ headerShown: false }} />
          <Stack.Screen name="reset-password" options={{ headerShown: false }} />
        </Stack>
      </SafeAreaInsetsContext.Provider>
    </>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Archivo_400Regular,
    Archivo_600SemiBold,
    Archivo_800ExtraBold,
    Archivo_900Black,
    DMMono_400Regular,
    DMMono_500Medium,
  });

  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider>
      {/* Outermost of the app's own providers: every screen below reads the palette. */}
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <LocalDatabaseProvider>
            <SessionProvider>
              <SyncProvider>
                <ThemedStatusBar />
                <AuthGate />
              </SyncProvider>
            </SessionProvider>
          </LocalDatabaseProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
