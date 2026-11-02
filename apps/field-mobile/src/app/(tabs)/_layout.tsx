import { Tabs, useRouter } from 'expo-router';
import { Text, type ColorValue } from 'react-native';
import { HeaderTitle, tabIcon } from '../../components/ui';
import { managesOnPhone, useSession } from '../../lib/session';
import { tabBarStyle, useTheme } from '../../lib/theme';

/**
 * The bottom tabs, by role.
 *
 * - **Consultant:** Overview · Units · History. Overview is where
 *   the phone opens: an auditor who paused in Zone 3 yesterday wants the way back into it,
 *   not a list of Units to search. The other two stay exactly as N1 has them, and an
 *   auditor holding a phone in a plant is still not browsing.
 * - **Zone Leader:** Overview · Audit · NCs · History. They belong to one Unit, so
 *   Audit opens that Unit's audit start directly instead of a Units list of one row — the
 *   same reasoning as a Coordinator's My Unit. Nonconformities (R-39) sit between Audit and
 *   History — the work they owe, one tap away rather than behind a slip that only shows while something waits.
 *   "Nonconformities" does not fit a fifth of a phone's width, so the bar says "NCs" and the
 *   header spells it out.
 * - **Super Admin (R-24):** Overview · Audits · Actions · Units · People — the admin web's
 *   rail (Unit board, Audits, Corrective actions, Units & zones, Users & roles) at five, as
 *   the product owner settled on 2026-09-13. Profile and notifications hang off the Overview
 *   header instead of taking a tab.
 * - **Coordinator (R-42):** Overview · Audits · Actions · People · My Unit. They hold one Unit
 *   (M-1), so the last tab is that Unit's page itself rather than a list of one. Each screen
 *   hides the actions the role does not hold.
 *
 * No role has a Profile tab: the avatar at the top left opens it, on every screen, as Kaizen's
 * bar already did. The route stays (`href: null`) because the avatar links to it.
 *
 * Every screen is a route in this group; a tab the role does not get is `href: null`, hidden
 * from the bar rather than absent, so a link to it still resolves.
 *
 * Icons are `TAB_ICON`'s Material symbols, shared with Kaizen's bar: a destination has one
 * symbol whichever role holds it (Audits and a Zone Leader's Audit; Actions and NCs; Units
 * and My Unit), and two destinations never share one. The bar is the web rail turned
 * sideways: a surface bar over a soft rule, the current item in maroon and in the semibold
 * face, and no Android elevation blur.
 */
export default function TabsLayout() {
  const theme = useTheme();
  const router = useRouter();
  const { scope } = useSession();
  const admin = managesOnPhone(scope?.role);
  const coordinator = scope?.role === 'COORDINATOR';
  const zoneLeader = scope?.role === 'ZONE_LEADER';
  const shownTo = (show: boolean) => (show ? {} : { href: null });
  const tabLabel = (text: string, color: ColorValue, focused: boolean) => (
    <Text
      numberOfLines={1}
      style={{
        color,
        fontFamily: focused ? theme.family.bold : theme.family.medium,
        fontSize: 11,
        paddingBottom: 2,
      }}
    >
      {text}
    </Text>
  );

  return (
    <Tabs
      initialRouteName="overview"
      screenOptions={{
        headerStyle: { backgroundColor: theme.color.ground },
        headerTintColor: theme.color.ink,
        headerTitle: ({ children }) => <HeaderTitle>{children}</HeaderTitle>,
        headerShadowVisible: false,
        sceneStyle: { backgroundColor: theme.color.ground },
        tabBarStyle: tabBarStyle(theme),
        // Selected is maroon and bold — weight as well as colour.
        tabBarLabel: ({ children, color, focused }) => tabLabel(children, color, focused),
        tabBarActiveTintColor: theme.color.primaryInk,
        tabBarInactiveTintColor: theme.color.muted,
      }}
    >
      {/* The one tab every role gets; the screen behind it differs (see `overview.tsx`). */}
      <Tabs.Screen name="overview" options={{ title: 'Overview', tabBarIcon: tabIcon('overview') }} />
      <Tabs.Screen name="audits" options={{ title: 'Audits', tabBarIcon: tabIcon('audits'), ...shownTo(admin) }} />
      <Tabs.Screen name="review" options={{ title: 'Actions', tabBarIcon: tabIcon('actions'), ...shownTo(admin) }} />
      <Tabs.Screen name="units" options={{ title: 'Units', tabBarIcon: tabIcon('units'), ...shownTo(admin && !coordinator) }} />
      <Tabs.Screen name="people" options={{ title: 'People', tabBarIcon: tabIcon('people'), ...shownTo(admin) }} />
      <Tabs.Screen name="my-unit" options={{ title: 'My Unit', tabBarIcon: tabIcon('units'), ...shownTo(coordinator) }} />
      <Tabs.Screen name="index" options={{ tabBarButtonTestID: 'field-units-tab', title: 'Units', tabBarIcon: tabIcon('units'), ...shownTo(!admin && !zoneLeader) }} />
      {/* Audit is a button, not a page: it starts the audit (selfie, then Zone) over the tabs, and Back returns. */}
      <Tabs.Screen
        name="audit"
        options={{ tabBarButtonTestID: 'field-audit-tab', title: 'Audit', tabBarIcon: tabIcon('audits'), ...shownTo(zoneLeader) }}
        listeners={{
          tabPress: (event) => {
            event.preventDefault();
            router.push('/audit/start');
          },
        }}
      />
      <Tabs.Screen
        name="nonconformities"
        options={{
          title: 'Nonconformities',
          tabBarLabel: ({ color, focused }) => tabLabel('NCs', color, focused),
          tabBarIcon: tabIcon('actions'),
          ...shownTo(zoneLeader),
        }}
      />
      <Tabs.Screen name="history" options={{ title: 'History', tabBarIcon: tabIcon('history'), ...shownTo(!admin) }} />
      <Tabs.Screen name="profile" options={{ title: 'Profile', href: null }} />
    </Tabs>
  );
}
