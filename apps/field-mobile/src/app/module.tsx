import { Pressable, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import type { KaizenDashboard } from '@audit5s/contracts';
import { awaitsResponse } from '@audit5s/domain';
import { api } from '../lib/api';
import { listResumableAudits } from '../lib/db/audit.repository';
import { listLocalUnits } from '../lib/db/catalogue.repository';
import { listLocalCorrectiveActions } from '../lib/db/corrective-action.repository';
import { localKaizenCounts } from '../lib/db/kaizen.repository';
import { useLocalDatabase } from '../lib/db/provider';
import { KAIZEN_STRINGS } from '../lib/kaizen-strings';
import { ROLE_LABELS } from '../lib/labels';
import { useLanguage } from '../lib/language-provider';
import { saveModule, type AppModule } from '../lib/secure-storage';
import { useSession } from '../lib/session';
import { createThemedStyles, iosHardShadow } from '../lib/theme';
import { Figure, Label, Magnet, Muted, Screen } from '../components/ui';

/**
 * The module picker (plans/kaizen-module.md §4.3; the "Split" design picked in Phase 0).
 *
 * Two equal tiles, each with the one count that says what is waiting there. Every count a
 * leader sees is read from SQLite, so the picker opens offline exactly as it does online —
 * the offline unlock never meets a spinner here. A Coordinator's "awaiting your review" is
 * the one live number (they record nothing offline, R-24); without a connection the tile
 * simply says nothing is known to be waiting.
 */
export default function ModulePicker() {
  const styles = useStyles();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const database = useLocalDatabase();
  const { user, scope, can } = useSession();
  const { language } = useLanguage();
  const t = KAIZEN_STRINGS[language];
  const reviews = can('kaizen', 'review') && !can('kaizen', 'create');

  const local = useQuery({
    queryKey: ['local', 'module-picker'],
    queryFn: async () => {
      const [audits, actions, kaizens, units] = await Promise.all([
        listResumableAudits(database),
        listLocalCorrectiveActions(database),
        localKaizenCounts(database),
        listLocalUnits(database),
      ]);
      return {
        inProgress: audits.length,
        owed: actions.filter((a) => awaitsResponse(a.effectiveStatus) && !a.pendingSubmissionId).length,
        ...kaizens,
        unitName: scope?.unitIds.length === 1 ? (units.find((u) => u.id === scope.unitIds[0])?.name ?? null) : null,
      };
    },
  });
  const awaiting = useQuery({
    queryKey: ['kaizen-dashboard', 'overall'],
    queryFn: () => api.get<KaizenDashboard>('/kaizens/dashboard'),
    enabled: reviews,
  });

  const pick = (module: AppModule) => {
    if (user) void saveModule(user.id, module);
    router.replace(module === 'kaizen' ? '/kaizen/overview' : '/overview');
  };

  const counts = local.data;
  const kaizenCount = reviews
    ? awaiting.data && { figure: awaiting.data.kpi.awaitingReview, text: t.awaitingReview(awaiting.data.kpi.awaitingReview) }
    : counts && { figure: counts.sentBack, text: t.sentBack(counts.sentBack), sub: counts.drafts ? t.drafts(counts.drafts) : null };
  const fiveSCount = counts && {
    figure: counts.inProgress,
    text: t.auditsInProgress(counts.inProgress),
    sub: counts.owed ? t.nonconformitiesOwed(counts.owed) : null,
  };

  return (
    <Screen bare>
      <Stack.Screen
        options={{
          title: t.chooseWork,
          headerBackVisible: false,
          gestureEnabled: false,
          headerRight: () =>
            user ? (
              <View style={styles.chip} accessible accessibilityLabel={user.fullName}>
                <Text style={styles.chipText}>{initials(user.fullName)}</Text>
              </View>
            ) : null,
        }}
      />
      <View style={[styles.body, { paddingBottom: insets.bottom }]}>
        <View>
          <Label>{[scope && ROLE_LABELS[scope.role], counts?.unitName].filter(Boolean).join(' · ')}</Label>
          <Text style={styles.name}>{user?.fullName}</Text>
        </View>
        <Tile name={t.fiveS} line={t.fiveSLine} count={fiveSCount} empty={t.nothingWaiting} label={t.open(t.fiveS)} onPress={() => pick('five-s')} testID="module-five-s" />
        <Tile name={t.kaizen} line={t.kaizenLine} count={kaizenCount} empty={t.nothingWaiting} label={t.open(t.kaizen)} onPress={() => pick('kaizen')} testID="module-kaizen" />
        {/* Where the choice is made, say how to change it later (#18; the switch stays on Profile). */}
        <Muted>{t.switchHint}</Muted>
      </View>
    </Screen>
  );
}

function Tile({
  name,
  line,
  count,
  empty,
  label,
  onPress,
  testID,
}: {
  name: string;
  line: string;
  count: { figure: number; text: string; sub?: string | null } | undefined;
  empty: string;
  label: string;
  onPress: () => void;
  testID: string;
}) {
  const styles = useStyles();
  const waiting = count && (count.figure > 0 || !!count.sub);
  return (
    <Magnet style={styles.tileShell}>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={[label, waiting ? `${count.figure} ${count.text}` : empty, count?.sub].filter(Boolean).join('. ')}
        onPress={onPress}
        style={({ pressed }) => [styles.tile, pressed && styles.pressed]}
      >
        <Text style={styles.tileName} numberOfLines={1} adjustsFontSizeToFit>
          {name}
        </Text>
        <Muted>{line}</Muted>
        <View style={styles.spacer} />
        {count ? (
          waiting ? (
            <View style={styles.count}>
              <Figure size={44}>{count.figure}</Figure>
              <View style={styles.countText}>
                <Text style={styles.countLabel}>{count.text}</Text>
                {count.sub ? <Muted>{count.sub}</Muted> : null}
              </View>
            </View>
          ) : (
            <Muted>{empty}</Muted>
          )
        ) : null}
        <View style={styles.band} />
      </Pressable>
    </Magnet>
  );
}

function initials(fullName: string): string {
  return fullName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => [...part][0]?.toUpperCase() ?? '')
    .join('');
}

const useStyles = createThemedStyles((theme) => ({
  body: { flex: 1, gap: theme.space.md },
  name: { fontFamily: theme.family.bold, fontSize: theme.font.panel, color: theme.color.ink },
  chip: {
    minWidth: 40,
    height: 40,
    paddingHorizontal: 6,
    borderWidth: 1.5,
    borderColor: theme.color.edge,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipText: { fontFamily: theme.family.bold, fontSize: theme.font.sm, color: theme.color.ink },
  tileShell: { flex: 1 },
  tile: {
    flex: 1,
    backgroundColor: theme.color.tile,
    borderWidth: 1.5,
    borderColor: theme.color.edge,
    padding: theme.space.md,
    paddingBottom: theme.space.md + 8,
    ...iosHardShadow(theme.color.hard),
  },
  pressed: { transform: [{ translateX: 3 }, { translateY: 3 }], shadowOpacity: 0 },
  tileName: {
    fontFamily: theme.family.black,
    fontSize: 34,
    lineHeight: 38,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    color: theme.color.ink,
    marginBottom: theme.space.xs,
  },
  spacer: { flex: 1, minHeight: theme.space.md },
  count: { flexDirection: 'row', alignItems: 'center', gap: theme.space.md },
  countText: { flex: 1 },
  countLabel: { fontFamily: theme.family.medium, fontSize: theme.font.base, color: theme.color.ink },
  band: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 8, backgroundColor: theme.color.ink },
}));
