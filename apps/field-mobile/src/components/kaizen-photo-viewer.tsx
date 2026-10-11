import { useEffect, useState } from 'react';
import { Image, Modal, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { KaizenPhotoKind } from '@audit5s/contracts';
import { KAIZEN_STRINGS } from '../lib/kaizen-strings';
import { useLanguage } from '../lib/language-provider';
import { createThemedStyles } from '../lib/theme';
import { Button, Hatch, Muted, Segmented, Tape } from './ui';

/**
 * A Kaizen's before and after, full screen (plans/kaizen-ux-plan.md 3.1): the Coordinator
 * judges the Kaizen from these, so they open large and switch without closing. Modelled on
 * `PhotoPreview`: a plain `Modal`, Close in the thumb zone, Android Back closes.
 * Phase 4 adds pinch-zoom and swipe-to-close inside this same component.
 */
export function KaizenPhotoViewer({
  photos,
  kind,
  onClose,
}: {
  photos: Record<KaizenPhotoKind, string | null | undefined>;
  /** The photo it opens on; `null` ⇒ closed. */
  kind: KaizenPhotoKind | null;
  onClose: () => void;
}) {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const { language } = useLanguage();
  const t = KAIZEN_STRINGS[language];
  const [shown, setShown] = useState<KaizenPhotoKind>(kind ?? 'BEFORE');
  useEffect(() => {
    if (kind) setShown(kind);
  }, [kind]);

  if (!kind) return null;
  const uri = photos[shown];
  const label = shown === 'BEFORE' ? t.before : t.after;

  return (
    <Modal visible animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={[styles.viewer, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 }]}>
        <Segmented<KaizenPhotoKind>
          options={[
            { value: 'BEFORE', label: t.before },
            { value: 'AFTER', label: t.after },
          ]}
          value={shown}
          onChange={setShown}
        />
        <View style={styles.frame}>
          {uri ? (
            <Image source={{ uri }} style={styles.image} resizeMode="contain" accessibilityLabel={label} />
          ) : photos[shown] === null ? (
            <Hatch />
          ) : (
            <Muted>{t.photoOnline}</Muted>
          )}
          <View style={styles.tape}>
            <Tape>{uri ? label : `${label} · ${t.none}`}</Tape>
          </View>
        </View>
        <Button title={t.close} icon="close" variant="secondary" onPress={onClose} />
      </View>
    </Modal>
  );
}

const useStyles = createThemedStyles((theme) => ({
  viewer: { flex: 1, backgroundColor: theme.color.board, paddingHorizontal: theme.space.md, gap: theme.space.md },
  frame: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: theme.color.edge,
    backgroundColor: theme.color.tile2,
    overflow: 'hidden',
  },
  image: { width: '100%', height: '100%' },
  tape: { position: 'absolute', left: 0, bottom: 0 },
}));
