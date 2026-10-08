import { Tabs } from 'expo-router';
import { Text, type ColorValue } from 'react-native';
import { ModuleSwitch } from '../../../components/module-switch';
import { HeaderTitle } from '../../../components/ui';
import { useTheme } from '../../../lib/theme';

/**
 * Kaizen's tabs (plans/kaizen-module.md §4.2), a group of its own beside 5S's `(tabs)` so
 * neither module's bar knows about the other. Step 4 lands here with Overview only; the
 * leader's New Kaizen · History (step 5) and the Coordinator's Kaizens · My Unit · Analysis
 * (step 6) join it. The bar is 5S's: tile-2 ground, a 2px ink rule, the current item in ink.
 */
export default function KaizenTabsLayout() {
  const theme = useTheme();
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
        headerLeft: () => <ModuleSwitch />,
        sceneStyle: { backgroundColor: theme.color.board },
        tabBarStyle: {
          minHeight: 64,
          backgroundColor: theme.color.tile2,
          borderTopWidth: 2,
          borderTopColor: theme.color.edge,
          elevation: 0,
        },
        tabBarLabelStyle: { fontFamily: theme.family.bold, fontSize: 10, letterSpacing: 0.8, textTransform: 'uppercase' },
        tabBarActiveTintColor: theme.color.ink,
        tabBarInactiveTintColor: theme.color.ink3,
      }}
    >
      <Tabs.Screen name="overview" options={{ title: 'Overview', tabBarIcon: icon('▦') }} />
    </Tabs>
  );
}
