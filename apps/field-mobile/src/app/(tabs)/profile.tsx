import { ScrollView, StyleSheet, Text, View } from 'react-native';
import Constants from 'expo-constants';
import { Button, Card, Heading, Muted, Screen } from '../../components/ui';
import { useSession } from '../../lib/session';
import { theme } from '../../lib/theme';

const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: 'Super Admin',
  CONSULTANT: 'Consultant',
  COORDINATOR: 'Coordinator',
  ZONE_LEADER: 'Zone Leader',
};

export default function ProfileScreen() {
  const { user, scope, signOut } = useSession();

  if (!user) {
    return (
      <Screen>
        <Muted>Not signed in.</Muted>
      </Screen>
    );
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <Card>
          <Heading>{user.fullName}</Heading>
          <Muted>{ROLE_LABELS[user.role] ?? user.role}</Muted>
        </Card>

        <Card>
          <Row label="Login ID" value={user.loginId} />
          <Row label="Phone" value={user.phoneE164} />
          <Row label="Email" value={user.email ?? '—'} />
          <Row
            label="Units"
            value={
              scope?.organizationWide
                ? 'All Units'
                : String(scope?.unitIds.length ?? 0)
            }
          />
          <Row
            label="Last sign-in"
            value={user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : '—'}
          />
        </Card>

        <Card>
          <Muted>
            App version {Constants.expoConfig?.version ?? 'dev'}
          </Muted>
        </Card>

        <Button title="Sign out" variant="secondary" onPress={() => void signOut()} />
      </ScrollView>
    </Screen>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { gap: theme.space.sm, paddingBottom: theme.space.xl },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: theme.space.sm,
    gap: theme.space.md,
  },
  rowLabel: { fontSize: theme.font.sm, color: theme.color.textMuted },
  rowValue: { fontSize: theme.font.base, color: theme.color.text, flexShrink: 1, textAlign: 'right' },
});
