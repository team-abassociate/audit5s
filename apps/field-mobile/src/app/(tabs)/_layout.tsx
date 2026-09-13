import { Tabs } from 'expo-router';
import { Text, type ColorValue } from 'react-native';
import { HeaderTitle } from '../../components/ui';
import { useSession } from '../../lib/session';
import { useTheme } from '../../lib/theme';

/**
 * The bottom tabs, by role.
 *
 * - **Consultant, Coordinator, Zone Leader:** Units · History · Profile — exactly N1, and an
 *   auditor holding a phone in a plant is not browsing.
 * - **Super Admin:** Overview · Audits · Actions · Units · People — the admin web's rail
 *   (Unit board, Audits, Corrective actions, Units & zones, Users & roles) at five, as the
 *   product owner settled on 2026-09-13. N1 binds the Consultant's navigation only. Profile
 *   and notifications hang off the Overview header instead of taking a tab.
 *
 * Every screen is a route in this group; a tab the role does not get is `href: null`, hidden
 * from the bar rather than absent, so a link to it still resolves.
 *
 * Icons are glyphs rather than an icon package: one fewer dependency, and the vector icon
 * font is a real chunk of the APK for a handful of characters. The bar is the web rail turned
 * sideways: tile-2 ground, a 2px ink rule, and the current item in ink with an underline —
 * shape as well as colour, and no Android elevation blur.
 */
export default function TabsLayout() {
  const theme = useTheme();
  const { scope } = useSession();
  const admin = scope?.role === 'SUPER_ADMIN';
  const icon = (glyph: string) =>
    function TabIcon({ color }: { color: ColorValue }) {
      return <Text style={{ color, fontFamily: theme.family.bold, fontSize: 18 }}>{glyph}</Text>;
    };
  const shownTo = (show: boolean) => (show ? {} : { href: null });

  return (
    <Tabs
      initialRouteName={admin ? 'overview' : 'index'}
      screenOptions={{
        headerStyle: { backgroundColor: theme.color.tile2 },
        headerTintColor: theme.color.ink,
        headerTitle: ({ children }) => <HeaderTitle>{children}</HeaderTitle>,
        headerShadowVisible: false,
        sceneStyle: { backgroundColor: theme.color.board },
        tabBarStyle: {
          minHeight: 64,
          backgroundColor: theme.color.tile2,
          borderTopWidth: 2,
          borderTopColor: theme.color.edge,
          elevation: 0,
        },
        // Selected is ink with a 2px underline — shape as well as colour — never a filled box.
        tabBarLabel: ({ children, color, focused }) => (
          <Text
            numberOfLines={1}
            style={{
              color,
              fontFamily: theme.family.bold,
              fontSize: 10,
              letterSpacing: 0.8,
              textTransform: 'uppercase',
              paddingBottom: 2,
              borderBottomWidth: 2,
              borderBottomColor: focused ? theme.color.ink : 'transparent',
            }}
          >
            {children}
          </Text>
        ),
        tabBarActiveTintColor: theme.color.ink,
        tabBarInactiveTintColor: theme.color.ink3,
      }}
    >
      <Tabs.Screen name="overview" options={{ title: 'Overview', tabBarIcon: icon('▦'), ...shownTo(admin) }} />
      <Tabs.Screen name="audits" options={{ title: 'Audits', tabBarIcon: icon('◷'), ...shownTo(admin) }} />
      <Tabs.Screen name="review" options={{ title: 'Actions', tabBarIcon: icon('⚑'), ...shownTo(admin) }} />
      <Tabs.Screen name="units" options={{ title: 'Units', tabBarIcon: icon('▣'), ...shownTo(admin) }} />
      <Tabs.Screen name="people" options={{ title: 'People', tabBarIcon: icon('◉'), ...shownTo(admin) }} />
      <Tabs.Screen name="index" options={{ title: 'Units', tabBarIcon: icon('▣'), ...shownTo(!admin) }} />
      <Tabs.Screen name="history" options={{ title: 'History', tabBarIcon: icon('◷'), ...shownTo(!admin) }} />
      <Tabs.Screen name="profile" options={{ title: 'Profile', tabBarIcon: icon('◧'), ...shownTo(!admin) }} />
    </Tabs>
  );
}
