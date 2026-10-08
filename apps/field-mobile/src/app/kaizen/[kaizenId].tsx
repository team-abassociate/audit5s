import { Image, ScrollView, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import type { KaizenDetail } from '@audit5s/contracts';
import { formatDate, formatRupees } from '@audit5s/domain';
import { Button, Card, Chip, Data, Hatch, Label, Muted, Screen, Slip, SlipText } from '../../components/ui';
import { api } from '../../lib/api';
import { getLocalKaizen, type LocalKaizenPhoto } from '../../lib/db/kaizen.repository';
import { useLocalDatabase } from '../../lib/db/provider';
import { KAIZEN_STATUS_TONE, KAIZEN_STRINGS, type KaizenTextField } from '../../lib/kaizen-strings';
import { useLanguage } from '../../lib/language-provider';
import { createThemedStyles } from '../../lib/theme';

/**
 * One Kaizen, read-only (§4.3 Detail): the sheet top to bottom with before and after side by
 * side, its status, and the Coordinator's reasons. Read from SQLite, so it opens offline;
 * online it also fetches `GET /kaizens/{id}` for the photos' view URLs (a photo taken on
 * another phone has no file here) and the whole review history.
 *
 * A Kaizen sent back offers *Edit & resubmit*. The Coordinator's Review section is step 6.
 */
export default function KaizenDetailScreen() {
  const styles = useStyles();
  const router = useRouter();
  const { kaizenId } = useLocalSearchParams<{ kaizenId: string }>();
  const database = useLocalDatabase();
  const { language } = useLanguage();
  const t = KAIZEN_STRINGS[language];

  const local = useQuery({ queryKey: ['local', 'kaizen', kaizenId], queryFn: () => getLocalKaizen(database, kaizenId) });
  const online = useQuery({
    queryKey: ['kaizen', kaizenId],
    queryFn: () => api.get<KaizenDetail>(`/kaizens/${encodeURIComponent(kaizenId)}`),
    retry: false,
  });

  const kaizen = local.data;
  if (local.isLoading) return null;
  if (!kaizen) {
    return (
      <Screen>
        <Muted>{t.notOnPhone}</Muted>
      </Screen>
    );
  }

  const sheet = kaizen.sheet;
  const row = (field: KaizenTextField, value: string | null | undefined) =>
    value ? (
      <View key={field} style={styles.row}>
        <Label>{t.field[field]}</Label>
        <Text style={styles.value}>{value}</Text>
      </View>
    ) : null;
  const reviews = online.data?.reviews.filter((review) => review.comment) ?? [];

  return (
    <Screen>
      <Stack.Screen options={{ title: kaizen.kaizenNo ?? t.numberOnSync }} />
      <ScrollView contentContainerStyle={styles.content}>
        {kaizen.status === 'SENT_BACK' || kaizen.status === 'REJECTED' ? (
          <Slip title={`${t.status[kaizen.status]} · ${t.coordinator}`}>
            {reviews.length
              ? reviews.map((review) => (
                  <SlipText key={review.id}>
                    {formatDate(review.createdAt)}: {review.comment}
                  </SlipText>
                ))
              : kaizen.reviewComment ? <SlipText>{kaizen.reviewComment}</SlipText> : null}
          </Slip>
        ) : null}

        <Card>
          <View style={styles.head}>
            <Chip tone={KAIZEN_STATUS_TONE[kaizen.status]}>{t.status[kaizen.status]}</Chip>
            <Data>{`${kaizen.zoneCode} · ${kaizen.zoneName}`}</Data>
          </View>
          <Text style={styles.theme}>{sheet.theme || '—'}</Text>

          <View style={styles.pair}>
            <Photo label={t.before} none={t.none} local={kaizen.before} url={online.data?.beforePhoto?.viewUrl ?? null} />
            <Photo label={t.after} none={t.none} local={kaizen.after} url={online.data?.afterPhoto?.viewUrl ?? null} />
          </View>

          {row('machine', [sheet.machine, sheet.lineArea].filter(Boolean).join(' · '))}
          {row('implementedOn', sheet.implementedOn ? formatDate(sheet.implementedOn) : null)}
          {row('teamMembers', sheet.teamMembers)}
          {row('target', sheet.target)}
          {row('problem5w1h', sheet.problem5w1h)}
          {row('rootCause4m', sheet.rootCause4m)}
          {row('analysis7qc', sheet.analysis7qc)}
          {row('countermeasure', sheet.countermeasure)}
          {sheet.wastes?.length ? (
            <View style={styles.row}>
              <Label>{t.step.wastes}</Label>
              <Text style={styles.value}>{sheet.wastes.map((waste) => t.waste[waste]).join(', ')}</Text>
            </View>
          ) : null}
          {sheet.parameters?.length ? (
            <View style={styles.row}>
              <Label>{t.step.parameters}</Label>
              <Text style={styles.value}>{sheet.parameters.map((parameter) => t.parameter[parameter]).join(', ')}</Text>
            </View>
          ) : null}
          {sheet.horizontalDeployment === null || sheet.horizontalDeployment === undefined ? null : (
            <View style={styles.row}>
              <Label>{t.step.horizontal}</Label>
              <Text style={styles.value}>{sheet.horizontalDeployment ? t.yes : t.no}</Text>
            </View>
          )}
          {row('benefits', sheet.benefits)}
          {row('annualSaving', sheet.annualSaving ? formatRupees(sheet.annualSaving) : null)}
          {row('ideaBy', sheet.ideaBy)}
          {row('implementedBy', sheet.implementedBy)}
        </Card>

        {kaizen.status === 'SENT_BACK' || kaizen.status === 'DRAFT' ? (
          <Button
            testID="kaizen-edit"
            title={kaizen.status === 'SENT_BACK' ? t.editResubmit : t.continueDraft}
            onPress={() => router.push({ pathname: '/kaizen/edit/[kaizenId]', params: { kaizenId: kaizen.id } })}
          />
        ) : null}
      </ScrollView>
    </Screen>
  );
}

/** One of the pair: this phone's file, else the server's short-lived URL, else the hatch. */
function Photo({ label, none, local, url }: { label: string; none: string; local: LocalKaizenPhoto | null; url: string | null }) {
  const styles = useStyles();
  const uri = local?.localFileUri ?? (local ? url : null);
  return (
    <View style={styles.photoBox}>
      <Label>{local ? label : `${label} · ${none}`}</Label>
      <View style={styles.photo}>
        {uri ? <Image source={{ uri }} style={styles.image} accessibilityLabel={label} /> : local ? null : <Hatch />}
      </View>
    </View>
  );
}

const useStyles = createThemedStyles((theme) => ({
  content: { padding: theme.space.lg, paddingBottom: theme.space.xl * 2, gap: theme.space.md },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.space.sm, marginBottom: theme.space.sm },
  theme: { fontFamily: theme.family.bold, fontSize: theme.font.heading, lineHeight: 24, color: theme.color.ink, marginBottom: theme.space.md },
  pair: { flexDirection: 'row', gap: theme.space.sm, marginBottom: theme.space.md },
  photoBox: { flex: 1 },
  photo: { aspectRatio: 1, borderWidth: 1.5, borderColor: theme.color.edge, backgroundColor: theme.color.tile2, overflow: 'hidden' },
  image: { width: '100%', height: '100%' },
  row: { paddingVertical: 10, borderTopWidth: 1, borderTopColor: theme.color.edgeSoft },
  value: { fontFamily: theme.family.regular, fontSize: theme.font.base, lineHeight: 22, color: theme.color.ink },
}));
