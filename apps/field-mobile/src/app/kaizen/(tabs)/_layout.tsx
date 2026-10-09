import { Tabs } from 'expo-router';
import { Text, type ColorValue } from 'react-native';
import { HeaderTitle } from '../../../components/ui';
import { KAIZEN_STRINGS } from '../../../lib/kaizen-strings';
import { useLanguage } from '../../../lib/language-provider';
import { useSession } from '../../../lib/session';
import { tabBarStyle, useTheme } from '../../../lib/theme';

/**
 * Kaizen's tabs (plans/kaizen-module.md §4.2), a group of its own beside 5S's `(tabs)` so
 * neither module's bar knows about the other. A Zone Leader (`kaizen:create`) gets
 * Overview · New Kaizen · History. Everyone else who reads Kaizens — a Coordinator, a
 * Consultant, the Super Admin — gets Overview · Kaizens · Analysis, and a Coordinator also
 * My Unit (the 5S screen itself). A tab a role does not get is `href: null`, as in 5S. The
 * bar is 5S's: tile-2 ground, a 2px ink rule, the current item in ink.
 */
export default function KaizenTabsLayout() {
  const theme = useTheme();
  const { can, scope } = useSession();
  const { language } = useLanguage();
  const t = KAIZEN_STRINGS[language];
  const author = can('kaizen', 'create');
  const shownTo = (show: boolean) => (show ? {} : { href: null });
  const icon = (glyph: string) =>
    function TabIcon({ color }: { color: ColorValue }) {
      return <Text style={{ color, fontFamily: theme.family.bold, fontSize: 18 }}>{glyph}</Text>;
    };
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: theme.color.tile2 },
        headerTintColor: theme.color.ink,
        headerTitle: ({ children }) => <HeaderTitle>{children}</HeaderTitle>,
        headerShadowVisible: false,
        sceneStyle: { backgroundColor: theme.color.board },
        tabBarStyle: tabBarStyle(theme),
        tabBarLabelStyle: { fontFamily: theme.family.bold, fontSize: 10, letterSpacing: 0.8, textTransform: 'uppercase' },
        tabBarActiveTintColor: theme.color.ink,
        tabBarInactiveTintColor: theme.color.ink3,
      }}
    >
      <Tabs.Screen name="overview" options={{ title: t.overview, tabBarIcon: icon('▦') }} />
      <Tabs.Screen name="new" options={{ title: t.newKaizen, tabBarIcon: icon('+'), ...shownTo(author) }} />
      <Tabs.Screen name="history" options={{ title: t.history, tabBarIcon: icon('◷'), ...shownTo(author) }} />
      <Tabs.Screen name="kaizens" options={{ title: t.kaizens, tabBarIcon: icon('◷'), ...shownTo(!author) }} />
      <Tabs.Screen name="my-unit" options={{ title: t.myUnit, tabBarIcon: icon('▣'), ...shownTo(scope?.role === 'COORDINATOR') }} />
      <Tabs.Screen name="analysis" options={{ title: t.analysis, tabBarIcon: icon('▤'), ...shownTo(!author) }} />
      {/* Opened by the initials in the top-left corner, never a tab: it keeps Kaizen's bar. */}
      <Tabs.Screen name="profile" options={{ title: t.profile, href: null }} />
    </Tabs>
  );
}
