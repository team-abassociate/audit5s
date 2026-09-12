import { useEffect, useState } from 'react';
import { Linking } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { PublicCorrectiveAction } from '@audit5s/contracts';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';
import { Button, EmptyState, Muted, Screen } from '../../components/ui';

/**
 * Deep-link handling for a corrective-action link (PART 14, Phase 7's Mobile row).
 *
 * A Zone Leader with the app installed taps the button in a PDF and lands **here** rather
 * than in a browser. That is worth doing for one reason that matters in a plant: the app's
 * own corrective-action screen works offline — the answer is written to SQLite and synced
 * later (§9.1) — while the web page needs a live connection for every step. A Zone Leader
 * standing next to the machine they just fixed, on a plant floor with no signal, can finish
 * in the app and cannot finish in the browser.
 *
 * So this screen does one thing: turn the token into an action id and hand over to the
 * screen that already knows how to answer one. It is a router, not a second implementation
 * of the form.
 *
 * Three outcomes, and each is told plainly:
 *
 *   * signed in and the link resolves → the app's own screen, offline-capable;
 *   * the link is dead (410) → say so and offer the path to a new one, exactly as the web
 *     page does. A Zone Leader must never read a failure as "the system lost my work";
 *   * not signed in, or the link belongs to somebody else's Unit → open the web page,
 *     which needs no session. The link is the credential there.
 */
export default function CorrectiveActionDeepLink() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const router = useRouter();
  const { status } = useSession();
  const [state, setState] = useState<'resolving' | 'gone' | 'elsewhere'>('resolving');

  useEffect(() => {
    if (!token || status === 'loading') return;

    let cancelled = false;

    void (async () => {
      // Not signed in: the app cannot read the item, but the link itself can. The web page
      // is the right destination rather than a login screen the reader may not have a
      // password for — a Zone Leader answering one finding is not necessarily an app user.
      if (status !== 'ready') {
        await openWebPage(token);
        if (!cancelled) setState('elsewhere');
        return;
      }

      try {
        // The public endpoint, from the app. The link is the credential either way, and
        // this is the only way to learn which action it names without a listing route —
        // which the public surface deliberately does not have (§8.8).
        const item = await api.get<PublicCorrectiveAction>(
          `/public/corrective-actions/${token}`,
        );
        if (cancelled) return;
        router.replace({
          pathname: '/actions/[actionId]',
          params: { actionId: item.correctiveActionId },
        });
      } catch (error) {
        if (cancelled) return;
        if ((error as { status?: number }).status === 410) {
          setState('gone');
          return;
        }
        // Anything else — no signal, another Unit's item, an account without the grant —
        // is handled by the surface that was built for it.
        await openWebPage(token);
        if (!cancelled) setState('elsewhere');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token, status, router]);

  if (state === 'gone') {
    return (
      <Screen>
        <EmptyState
          title="This link is no longer valid"
          detail={
            'It may have expired, or it may have been replaced. Ask the auditor or your ' +
            'Super Admin for a new link — nothing you have done has been lost.'
          }
        />
        <Button title="Back to my actions" onPress={() => router.replace('/actions')} />
      </Screen>
    );
  }

  if (state === 'elsewhere') {
    return (
      <Screen>
        <EmptyState
          title="Opened in your browser"
          detail="This link works without signing in. Sign in here to answer it offline instead."
        />
        <Button title="Back" onPress={() => router.replace('/')} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Muted>Opening the corrective action…</Muted>
    </Screen>
  );
}

/** Hands the link back to the browser, where it needs no session. */
async function openWebPage(token: string): Promise<void> {
  const base = webAppUrl();
  if (!base) return;
  await Linking.openURL(`${base.replace(/\/+$/, '')}/ca/${token}`).catch(() => undefined);
}

/**
 * Where the web page lives.
 *
 * Derived from the configured API base rather than a second setting: the two are deployed
 * together, and a device pointing at a staging API must not open a production link.
 */
function webAppUrl(): string | null {
  const apiBase = api.baseUrl();
  try {
    return new URL(apiBase).origin;
  } catch {
    return null;
  }
}
