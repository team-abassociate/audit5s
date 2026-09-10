import { FlatList, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Link, Stack, useLocalSearchParams } from 'expo-router';
import { zoneDisplayLabel } from '@audit5s/domain';
import { Card, EmptyState, Muted, Screen } from '../../components/ui';
import {
  getLocalUnit,
  listLocalChecklistVersions,
  listLocalZones,
} from '../../lib/db/catalogue.repository';
import { useLocalDatabase } from '../../lib/db/provider';
import { theme } from '../../lib/theme';

/**
 * A Unit's active Zones, read from SQLite.
 *
 * Read-only at Phase 2: starting an audit from a Zone arrives with the audit engine. What
 * this proves today is the thing the questionnaire will depend on — that the catalogue is
 * on the device and legible with the radio off.
 */
export default function UnitZonesScreen() {
  const { unitId } = useLocalSearchParams<{ unitId: string }>();
  const database = useLocalDatabase();

  const unit = useQuery({
    queryKey: ['local', 'unit', unitId],
    queryFn: () => getLocalUnit(database, unitId),
  });

  const zones = useQuery({
    queryKey: ['local', 'zones', unitId],
    queryFn: () => listLocalZones(database, unitId),
  });

  const versions = useQuery({
    queryKey: ['local', 'checklist-versions'],
    queryFn: () => listLocalChecklistVersions(database),
  });

  const title = unit.data?.[0]?.name ?? 'Zones';

  return (
    <Screen>
      <Stack.Screen options={{ title, headerBackTitle: 'Units' }} />

      <FlatList
        data={zones.data ?? []}
        keyExtractor={(zone) => zone.id}
        ListEmptyComponent={
          <EmptyState
            title="No Zones"
            detail="This Unit has no active Zones yet. The Coordinator creates them in the admin app."
          />
        }
        ListFooterComponent={
          (versions.data ?? []).length > 0 ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Checklists on this device</Text>
              {(versions.data ?? []).map((version) => (
                <Link
                  key={version.id}
                  href={{ pathname: '/checklist/[versionId]', params: { versionId: version.id } }}
                  asChild
                >
                  <Card>
                    <Text style={styles.name}>{version.templateName}</Text>
                    <Muted>
                      v{version.versionNumber} · {version.totalQuestions} questions
                    </Muted>
                  </Card>
                </Link>
              ))}
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <Card>
            <Text style={styles.name}>{zoneDisplayLabel(item.code, item.name)}</Text>
            {item.description ? <Muted>{item.description}</Muted> : null}
            <Muted>
              {item.zoneLeaderName ? `Zone Leader: ${item.zoneLeaderName}` : 'No Zone Leader'}
            </Muted>
          </Card>
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  name: { fontSize: theme.font.lg, fontWeight: '600', color: theme.color.text },
  section: { marginTop: theme.space.lg },
  sectionTitle: {
    fontSize: theme.font.sm,
    fontWeight: '700',
    color: theme.color.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: theme.space.sm,
  },
});
