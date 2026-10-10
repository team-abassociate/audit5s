import { Image, Text, View } from 'react-native';
import { formatDayMonth, formatRupees } from '@audit5s/domain';
import type { Kaizen } from '@audit5s/contracts';
import type { LocalKaizen } from '../lib/db/kaizen.repository';
import { KAIZEN_STATUS_ICON, KAIZEN_STATUS_TONE, KAIZEN_STRINGS } from '../lib/kaizen-strings';
import { useLanguage } from '../lib/language-provider';
import { createThemedStyles } from '../lib/theme';
import { Card, Chip, Data, Figure, Hatch } from './ui';

/**
 * What a card needs, from either source: the leader's own Kaizens from SQLite, or a
 * Coordinator's list from the API (`cardFromServer`). A photo with no file here is one only
 * the server holds.
 */
export interface KaizenCardData extends Pick<LocalKaizen, 'id' | 'status' | 'kaizenNo' | 'sheet' | 'reviewComment'> {
  before: { localFileUri: string | null } | null;
  after: { localFileUri: string | null } | null;
}

export function cardFromServer(kaizen: Kaizen): KaizenCardData {
  return {
    id: kaizen.id,
    status: kaizen.status,
    kaizenNo: kaizen.kaizenNo,
    sheet: { theme: kaizen.theme, machine: kaizen.machine, implementedOn: kaizen.implementedOn, annualSaving: kaizen.annualSaving },
    reviewComment: kaizen.latestReview?.comment ?? null,
    before: kaizen.beforePhoto ? { localFileUri: null } : null,
    after: kaizen.afterPhoto ? { localFileUri: null } : null,
  };
}

/**
 * Where a tap on the leader's own Kaizen goes: one they can still change (a draft, or one sent
 * back, whose reason the form shows on top) straight into the form; anything else its sheet.
 * Only the leader's lists use this; a Coordinator's open the sheet.
 */
export function kaizenHref(kaizen: Pick<LocalKaizen, 'id' | 'status'>) {
  return kaizen.status === 'DRAFT' || kaizen.status === 'SENT_BACK'
    ? ({ pathname: '/kaizen/edit/[kaizenId]', params: { kaizenId: kaizen.id } } as const)
    : ({ pathname: '/kaizen/[kaizenId]', params: { kaizenId: kaizen.id } } as const);
}

/**
 * One Kaizen in a list — the "Evidence" card picked in Phase 0: the before → after pair
 * leads, because a leader knows their Kaizen by its picture. History and Overview both
 * use it, so they cannot drift (as `AuditCard` is shared by Audits and Overview).
 *
 * A photo taken on this phone shows from its file, offline. One known only from the server
 * shows its tag on a plain ground (the list API carries no view URLs; the detail fetches
 * them). A missing photo is the hatch, never a blank: "nothing here", not "still loading".
 */
export function KaizenCard({
  kaizen,
  author,
  arrived,
  onPress,
}: {
  kaizen: KaizenCardData;
  /** Just submitted from this phone: the card lights up where it landed (plan M4). */
  arrived?: boolean;
  /** "{author} · {zone code}", leading the meta line on a Coordinator's list. */
  author?: string;
  onPress: () => void;
}) {
  const styles = useStyles();
  const { language } = useLanguage();
  const t = KAIZEN_STRINGS[language];
  const sheet = kaizen.sheet;
  const no = kaizen.kaizenNo ?? t.numberOnSync;
  const meta = [author ?? sheet.machine, sheet.implementedOn ? formatDayMonth(sheet.implementedOn) : null].filter(Boolean).join(' · ');
  const saving = sheet.annualSaving ?? null;
  const returned = kaizen.status === 'SENT_BACK' || kaizen.status === 'REJECTED';

  return (
    <Card
      style={styles.card}
      arrived={arrived}
      accessibilityRole="button"
      accessibilityLabel={[no, t.status[kaizen.status], sheet.theme, saving ? `${formatRupees(saving)} ${t.perYear}` : null]
        .filter(Boolean)
        .join(', ')}
      onPress={onPress}
    >
      <View style={styles.pair}>
        <Photo photo={kaizen.before} tag={t.before} none={t.none} />
        <View style={styles.divider} />
        <Photo photo={kaizen.after} tag={t.after} none={t.none} />
      </View>
      <View style={styles.body}>
        <View style={styles.row}>
          <Text style={[styles.no, !kaizen.kaizenNo && styles.noPending]}>{no}</Text>
          <Chip tone={KAIZEN_STATUS_TONE[kaizen.status]} icon={KAIZEN_STATUS_ICON[kaizen.status]}>{t.status[kaizen.status]}</Chip>
        </View>
        <Text style={styles.theme} numberOfLines={2}>
          {sheet.theme || '—'}
        </Text>
        <View style={styles.foot}>
          <View style={styles.meta}>
            <Data>{meta}</Data>
          </View>
          {saving ? <Figure size={20}>{formatRupees(saving)}</Figure> : null}
        </View>
      </View>
      {returned && kaizen.reviewComment ? (
        <View style={[styles.slip, kaizen.status === 'REJECTED' && styles.slipRejected]}>
          <Text style={[styles.slipTitle, kaizen.status === 'REJECTED' && styles.rejectedTitle]}>
            {kaizen.status === 'SENT_BACK' ? t.fixAndResubmit : t.status.REJECTED}
          </Text>
          <Text style={[styles.slipText, kaizen.status === 'REJECTED' && styles.rejectedText]}>{kaizen.reviewComment}</Text>
        </View>
      ) : null}
    </Card>
  );
}

function Photo({ photo, tag, none }: { photo: KaizenCardData['before']; tag: string; none: string }) {
  const styles = useStyles();
  return (
    <View style={styles.photo}>
      {photo?.localFileUri ? (
        <Image source={{ uri: photo.localFileUri }} style={styles.image} accessibilityIgnoresInvertColors />
      ) : photo ? null : (
        <Hatch />
      )}
      <View style={styles.tag}>
        <Text style={styles.tagText}>{photo ? tag : `${tag} · ${none}`}</Text>
      </View>
    </View>
  );
}

const useStyles = createThemedStyles((theme) => ({
  card: { padding: 0 },
  pair: { flexDirection: 'row', height: 118, borderBottomWidth: 1.5, borderBottomColor: theme.color.edge },
  divider: { width: 1.5, backgroundColor: theme.color.edge },
  photo: { flex: 1, overflow: 'hidden', backgroundColor: theme.color.tile2 },
  image: { width: '100%', height: '100%' },
  tag: {
    position: 'absolute',
    left: 0,
    bottom: 0,
    backgroundColor: theme.color.tape,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  tagText: {
    fontFamily: theme.family.bold,
    fontSize: theme.font.label,
    letterSpacing: 0.9,
    textTransform: 'uppercase',
    color: theme.color.tapeInk,
  },
  body: { padding: theme.space.md, gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.space.sm },
  no: { fontFamily: theme.family.mono, fontSize: 12.5, color: theme.color.ink },
  noPending: { color: theme.color.ink3 },
  theme: { fontFamily: theme.family.bold, fontSize: theme.font.panel, lineHeight: 20, color: theme.color.ink },
  foot: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: theme.space.sm },
  meta: { flex: 1 },
  slip: {
    backgroundColor: theme.color.slip,
    borderTopWidth: 1.5,
    borderTopColor: theme.color.edge,
    paddingHorizontal: theme.space.md,
    paddingVertical: 10,
    borderLeftWidth: 6,
    borderLeftColor: theme.color.warnBand,
  },
  slipRejected: { backgroundColor: theme.color.tile2, borderLeftColor: theme.color.critBand },
  slipTitle: {
    fontFamily: theme.family.bold,
    fontSize: 10.5,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: theme.color.slipInk,
    marginBottom: 2,
  },
  slipText: { fontFamily: theme.family.regular, fontSize: theme.font.sm, lineHeight: 19, color: theme.color.slipInk },
  rejectedTitle: { color: theme.color.crit },
  rejectedText: { color: theme.color.ink },
}));
