import { Tabs } from 'expo-router';
import { Text } from 'react-native';
import { useTheme } from '../../lib/theme';

/**
 * The three tabs of N1: Units, History, Profile. No more — the brainstorm asked for a
 * denser home screen, but ARCHITECTURE.md N1 settles it at three, and an auditor holding a
 * phone in a plant is not browsing.
 *
 * Icons are glyphs rather than an icon package: one fewer dependency, and the vector icon
 * font is a real chunk of the APK for six characters.
 */
export default function TabsLayout() {
  const theme = useTheme();
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: theme.color.tile2 },
        headerTintColor: theme.color.ink,
        headerTitleStyle: { fontFamily: theme.family.bold, textTransform: 'uppercase' },
        headerShadowVisible: false,
        sceneStyle: { backgroundColor: theme.color.board },
        tabBarStyle: {
          minHeight: 64,
          backgroundColor: theme.color.tile2,
          borderTopWidth: 2,
          borderTopColor: theme.color.edge,
        },
        tabBarLabelStyle: { fontFamily: theme.family.medium, textTransform: 'uppercase' },
        tabBarActiveTintColor: theme.color.accent,
        tabBarInactiveTintColor: theme.color.ink2,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Units',
          tabBarIcon: ({ color }) => <Text style={{ color, fontFamily: theme.family.bold, fontSize: 18 }}>▣</Text>,
        }}
      />
      <Tabs.Screen
        name="history"
        options={{
          title: 'History',
          tabBarIcon: ({ color }) => <Text style={{ color, fontFamily: theme.family.bold, fontSize: 18 }}>◷</Text>,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ color }) => <Text style={{ color, fontFamily: theme.family.bold, fontSize: 18 }}>◧</Text>,
        }}
      />
    </Tabs>
  );
}
