import { SectionList, Text } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Stack, useLocalSearchParams } from 'expo-router';
import { S_SECTION_LABELS, S_SECTION_ORDER } from '@audit5s/domain';
import { Muted, Screen } from '../../components/ui';
import {
  getLocalChecklistVersion,
  listLocalQuestions,
} from '../../lib/db/catalogue.repository';
import { useLocalDatabase } from '../../lib/db/provider';
import { createThemedStyles } from '../../lib/theme';

/**
 * A published checklist, read from SQLite: five sections of ten, in workbook order.
 *
 * This screen is what the questionnaire will render against in Phase 3. Reading it offline
 * now is the cheapest possible proof that the catalogue landed correctly — 50 questions
 * under the right five headings, or something is wrong with the sync.
 */
export default function ChecklistScreen() {
  const styles = useStyles();
  const { versionId } = useLocalSearchParams<{ versionId: string }>();
  const database = useLocalDatabase();

  const version = useQuery({
    queryKey: ['local', 'checklist-version', versionId],
    queryFn: () => getLocalChecklistVersion(database, versionId),
  });

  const questions = useQuery({
    queryKey: ['local', 'checklist-questions', versionId],
    queryFn: () => listLocalQuestions(database, versionId),
  });

  const sections = S_SECTION_ORDER.map((section) => ({
    title: S_SECTION_LABELS[section],
    data: (questions.data ?? []).filter((question) => question.section === section),
  })).filter((section) => section.data.length > 0);

  const detail = version.data?.[0];

  return (
    <Screen>
      <Stack.Screen
        options={{ title: detail?.templateName ?? 'Checklist', headerBackTitle: 'Back' }}
      />

      <SectionList
        sections={sections}
        keyExtractor={(question) => question.id}
        ListHeaderComponent={
          detail ? (
            <Muted>
              v{detail.versionNumber} · {detail.totalQuestions} questions · stored on this device
            </Muted>
          ) : null
        }
        renderSectionHeader={({ section }) => (
          <Text style={styles.sectionTitle}>{section.title}</Text>
        )}
        renderItem={({ item }) => (
          <Text style={styles.question}>
            <Text style={styles.order}>{item.globalOrder}. </Text>
            {item.text}
          </Text>
        )}
        stickySectionHeadersEnabled={false}
      />
    </Screen>
  );
}

const useStyles = createThemedStyles((theme) => ({
  sectionTitle: {
    fontFamily: theme.family.bold,
    fontSize: theme.font.panel,
    color: theme.color.ink,
    textTransform: 'uppercase',
    letterSpacing: 0.32,
    marginTop: theme.space.lg,
    marginBottom: theme.space.sm,
  },
  question: {
    fontFamily: theme.family.regular,
    fontSize: theme.font.base,
    color: theme.color.ink,
    paddingVertical: theme.space.sm,
    borderBottomWidth: 1,
    borderBottomColor: theme.color.edgeSoft,
  },
  order: { fontFamily: theme.family.monoMedium, color: theme.color.ink3 },
}));
