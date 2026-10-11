// Must stay the first import: Hermes defines no global `crypto`, and the device id minted
// on every API request needs one.
import '../lib/crypto-polyfill';
import { useEffect, useRef } from 'react';
import { ActivityIndicator, Alert, AppState, LogBox, View } from 'react-native';
import { useFonts } from 'expo-font';
import { Archivo_400Regular } from '@expo-google-fonts/archivo/400Regular';
import { Archivo_600SemiBold } from '@expo-google-fonts/archivo/600SemiBold';
import { Archivo_800ExtraBold } from '@expo-google-fonts/archivo/800ExtraBold';
import { Archivo_900Black } from '@expo-google-fonts/archivo/900Black';
import { DMMono_400Regular } from '@expo-google-fonts/dm-mono/400Regular';
import { DMMono_500Medium } from '@expo-google-fonts/dm-mono/500Medium';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Stack, useGlobalSearchParams, useRouter, useSegments, type Href } from 'expo-router';
import { SafeAreaInsetsContext, SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { getLocalAudit, getLocalAuditZone, pauseLocalAudit } from '../lib/db/audit.repository';
import { LocalDatabaseProvider, useLocalDatabase } from '../lib/db/provider';
import { LanguageProvider } from '../lib/language-provider';
import { SessionProvider, useSession } from '../lib/session';
import { SyncProvider, useSync } from '../lib/sync/provider';
import { SyncStatusBar } from '../components/sync-status-bar';
import { HeaderTitle } from '../components/ui';
import { ThemedStatusBar, ThemeProvider } from '../lib/theme-provider';
import { useTheme } from '../lib/theme';
import { RouteErrorBoundary } from '../components/route-error-boundary';
import { leaveScreen } from '../lib/leave-screen';
import { permissionPromptOpen } from '../lib/permission-prompt';
import { requestPermissionsAtLaunch, useCameraOpen } from '../components/camera-capture';
import { loadModule } from '../lib/secure-storage';

// Maestro runs (Metro started with EXPO_PUBLIC_E2E=1): the debug build's warning toast
// takes taps meant for the bottom of the screen. A release build has no LogBox at all.
if (__DEV__ && process.env.EXPO_PUBLIC_E2E === '1') LogBox.ignoreAllLogs();

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
  const { status, user, can } = useSession();
  const segments = useSegments() as string[];
  const cameraOpen = useCameraOpen((state) => state.open);
  const { auditId, auditZoneId } = useGlobalSearchParams<{ auditId?: string; auditZoneId?: string }>();
  const router = useRouter();
  const database = useLocalDatabase();
  const queryClient = useQueryClient();
  const { sync } = useSync();
  const pausingOnBackground = useRef(false);
  const showOverviewAfterPause = useRef(false);
  const pauseError = useRef<string | null>(null);
  // Whether this sign-in has already been sent to its landing screen. Overview is where a
  // session *starts*, not a place the app keeps pulling people back to.
  const landed = useRef(false);

  useEffect(() => {
    if (status === 'loading') return;
    if (status !== 'ready') landed.current = false;
    // Where a session starts: the module last picked, or the picker. A role without Kaizen
    // has one module and goes straight to it. Read from the keystore, so it works offline.
    const land = () => {
      landed.current = true;
      void (async (): Promise<Href> => {
        if (!user || !can('kaizen', 'read')) return '/overview';
        const module = await loadModule(user.id);
        if (module === 'kaizen') return '/kaizen/overview';
        return module === 'five-s' ? '/overview' : '/module';
      })().then((path) => router.replace(path));
    };

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
      group === 'module' ||
      group === 'kaizen' ||
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
      land();
    } else if (status === 'ready' && !landed.current) {
      // Every role lands on Overview (R-24), and the field Units tab is the app's root
      // route — so a launch that opens on it is moved once. Only once: this used to fire
      // on every visit to the root, so the field Units tab, and Overview's "Open a Unit"
      // and "Units" buttons, all bounced straight back. An auditor could never reach
      // their Units, see a new assignment, or start an audit.
      if (group === '(tabs)' && segments.length === 1) land();
      else landed.current = true;
    }
  }, [status, segments, router, user, can]);

  // An answered call puts Android in the background. Pause the local audit then, and show
  // Overview's Resume action when the app is active again. Other app switches do the same.
  useEffect(() => {
    const showOverview = () => {
      if (!showOverviewAfterPause.current) return;
      showOverviewAfterPause.current = false;
      leaveScreen(
        () => router.navigate('/overview'),
        () => {
          void queryClient.invalidateQueries({ queryKey: ['local'] });
          void sync();
        },
      );
    };

    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        showOverview();
        if (pauseError.current) {
          Alert.alert('Could not pause audit', pauseError.current);
          pauseError.current = null;
        }
      }
      if (state !== 'background' || pausingOnBackground.current || status !== 'ready') return;
      // A permission dialog is not the auditor leaving: see `permission-prompt.ts`.
      if (permissionPromptOpen()) return;

      const onZones = segments[0] === 'audit' && segments[1] === 'zones';
      const inZone =
        (segments[0] === 'audit' && segments[1] === '[auditZoneId]') ||
        segments[0] === 'walk-by';
      if (!onZones && !inZone) return;

      pausingOnBackground.current = true;
      void (async () => {
        const id = onZones
          ? auditId
          : (await getLocalAuditZone(database, auditZoneId ?? ''))[0]?.auditId;
        if (!id || (await getLocalAudit(database, id))[0]?.status !== 'IN_PROGRESS') return;
        await pauseLocalAudit(database, id, null);
        showOverviewAfterPause.current = true;
        if (AppState.currentState === 'active') showOverview();
      })()
        .catch((error: unknown) => {
          pauseError.current = error instanceof Error ? error.message : 'Please use Pause when you return.';
          if (AppState.currentState === 'active') {
            Alert.alert('Could not pause audit', pauseError.current);
            pauseError.current = null;
          }
        })
        .finally(() => { pausingOnBackground.current = false; });
    });
    return () => subscription.remove();
  }, [status, segments, auditId, auditZoneId, database, queryClient, router, sync]);

  if (status === 'loading') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.color.board }}>
        <ActivityIndicator color={theme.color.ink} />
      </View>
    );
  }

  // The sync bar (initials, status, Sync now) is on the main page of each 5S and Kaizen tab
  // only, as the owner ruled on 2026-10-09. Every screen pushed on top of a tab, the module
  // picker included, uses the space for its own work; sync keeps running underneath, and its
  // status is one Back away. Nobody signed in, nothing to report. A camera is the whole
  // screen, even when it opens on a tab (a Kaizen photo, from New), so the bar steps aside.
  const signedIn = status === 'ready';
  const onTab = segments[0] === '(tabs)' || (segments[0] === 'kaizen' && segments[1] === '(tabs)');
  const showBar = signedIn && onTab && !cameraOpen;

  return (
    <>
      {showBar && <SyncStatusBar />}
      {/* The sync bar already pads for the status bar; headers below it must not pad again. */}
      <SafeAreaInsetsContext.Provider value={showBar ? { ...insets, top: 0 } : insets}>
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: theme.color.tile2 },
            headerTintColor: theme.color.ink,
            headerTitle: ({ children }) => <HeaderTitle>{children}</HeaderTitle>,
            headerShadowVisible: false,
            // The sync bar above already clears the status bar. The native Android header
            // reads the window inset itself, ignoring the zeroed context above, so without
            // this every pushed screen carried a second status-bar-high band over its title.
            unstable_nativeProps: { headerConfig: { disableTopInsetApplication: showBar } },
            contentStyle: { backgroundColor: theme.color.board },
          }}
        >
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="kaizen/(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="login" options={{ headerShown: false }} />
          <Stack.Screen name="reset-password" options={{ headerShown: false }} />
        </Stack>
      </SafeAreaInsetsContext.Provider>
    </>
  );
}

export default function RootLayout() {
  // Every permission the app needs, asked the moment it opens and never mid-audit.
  useEffect(() => {
    void requestPermissionsAtLaunch();
  }, []);

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
    // The photo viewer's pinch and swipe (plan M6): gestures do nothing without this root.
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        {/* Outermost of the app's own providers: every screen below reads the palette. */}
        <ThemeProvider>
          <QueryClientProvider client={queryClient}>
            {/* Session first: each person on a shared phone has their own database (0025). */}
            <SessionProvider>
              {/* Per person, like the database: a shared phone speaks each auditor's language. */}
              <LanguageProvider>
                <LocalDatabaseProvider>
                  <SyncProvider>
                    <ThemedStatusBar />
                    <AuthGate />
                  </SyncProvider>
                </LocalDatabaseProvider>
              </LanguageProvider>
            </SessionProvider>
          </QueryClientProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

/**
 * Exported so expo-router wraps every route below this layout (§ the whole signed-in app).
 * Without one, a render error in a release build unmounts the tree and shows nothing.
 */
export { RouteErrorBoundary as ErrorBoundary };
