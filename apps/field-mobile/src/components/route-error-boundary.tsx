import { ScrollView, Text, View } from 'react-native';
import type { ErrorBoundaryProps } from 'expo-router';
import { gemba, gembaFonts } from '../lib/gemba';

/**
 * What a render crash looks like instead of a white screen.
 *
 * A release build has no LogBox, so an exception thrown while rendering unmounts the tree
 * and leaves the window blank — the app "does not start", with nothing on the device or in
 * logcat to say why. That is what happened after a sign-in on versionCode 9, and the
 * absence of any message is what made it undiagnosable from the outside.
 *
 * So this reports rather than hides: the message and stack on screen, where an auditor can
 * photograph it, and a `console.error` so `adb logcat` carries the same text. `retry()`
 * remounts the segment, which is enough to get past a transient failure without losing the
 * queued work in SQLite.
 *
 * It deliberately uses the token object directly rather than `useTheme()`. The boundary has
 * to render when the tree below it — theme provider included — is the thing that failed, so
 * it cannot depend on context. Values still come from the design system: `gemba.ts` is the
 * React Native port of `gemba-tokens.css` (GEMBA-BOARD.md §8), so there is no literal here.
 */
export function RouteErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  const t = gemba.light;

  // Same text logcat gets, so a device that cannot be read over someone's shoulder can be
  // read over adb.
  console.error('[audit5s] render failed:', error?.message, error?.stack);

  return (
    <View style={{ flex: 1, backgroundColor: t.board, padding: 16, justifyContent: 'center' }}>
      <View style={{ backgroundColor: t.tile, borderWidth: 1.5, borderColor: t.edge, padding: 14 }}>
        <Text style={{ fontFamily: gembaFonts.bold, fontSize: 10.5, letterSpacing: 1.4, color: t.ink3 }}>
          SOMETHING BROKE
        </Text>
        <Text style={{ fontFamily: gembaFonts.bold, fontSize: 17, color: t.ink, marginTop: 6 }}>
          This screen could not open
        </Text>
        <Text style={{ fontFamily: gembaFonts.regular, fontSize: 13, color: t.ink2, marginTop: 8, lineHeight: 19 }}>
          Nothing you saved has been lost — audits stay on this device until they sync. Show
          this message to whoever supports the app.
        </Text>

        <ScrollView style={{ maxHeight: 220, marginTop: 12, backgroundColor: t.tile2, padding: 10 }}>
          <Text selectable style={{ fontFamily: gembaFonts.mono, fontSize: 11, color: t.crit }}>
            {error?.message ?? 'Unknown error'}
          </Text>
          {error?.stack ? (
            <Text selectable style={{ fontFamily: gembaFonts.mono, fontSize: 10, color: t.ink3, marginTop: 8 }}>
              {error.stack}
            </Text>
          ) : null}
        </ScrollView>

        <Text
          accessibilityRole="button"
          onPress={retry}
          style={{
            marginTop: 14,
            textAlign: 'center',
            fontFamily: gembaFonts.bold,
            fontSize: 12.5,
            color: t.ink,
            borderWidth: 1.5,
            borderColor: t.edge,
            backgroundColor: t.tile,
            paddingVertical: 9,
          }}
        >
          Try again
        </Text>
      </View>
    </View>
  );
}
