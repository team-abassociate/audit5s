import { useEffect, useState } from 'react';
import { Image, Modal, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  interpolate,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { KaizenPhotoKind } from '@audit5s/contracts';
import { KAIZEN_STRINGS } from '../lib/kaizen-strings';
import { useLanguage } from '../lib/language-provider';
import { timing } from '../lib/motion';
import { createThemedStyles } from '../lib/theme';
import { Button, Hatch, Muted, Segmented, Tape } from './ui';

/**
 * A Kaizen's before and after, full screen (plans/kaizen-ux-plan.md 3.1): the Coordinator
 * judges the Kaizen from these, so they open large and switch without closing. Modelled on
 * `PhotoPreview`: a plain `Modal`, Close in the thumb zone, Android Back closes.
 *
 * The photo is held in the hand (M6): pinch to 4× (it gives past the ends and settles back),
 * drag it about once zoomed, double-tap for 2.5× where the finger is, and at 1× pull it down
 * to close: far enough or fast enough. All of it on the UI thread; React hears only the close.
 * Close and Back still work without any of it.
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
  // How far the photo has been pulled down at 1×; the whole viewer fades with it.
  const pulled = useSharedValue(0);
  const height = useSharedValue(1);
  useEffect(() => {
    if (kind) {
      setShown(kind);
      pulled.set(0);
    }
  }, [kind, pulled]);
  const fade = useAnimatedStyle(() => ({
    opacity: interpolate(pulled.get(), [0, height.get()], [1, 0], 'clamp'),
  }));

  if (!kind) return null;
  const uri = photos[shown];
  const label = shown === 'BEFORE' ? t.before : t.after;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      {/* A Modal is its own window on Android: gestures inside need their own root. */}
      <GestureHandlerRootView style={styles.root}>
        <Animated.View style={[styles.viewer, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 }, fade]}>
          <Segmented<KaizenPhotoKind>
            options={[
              { value: 'BEFORE', label: t.before },
              { value: 'AFTER', label: t.after },
            ]}
            value={shown}
            onChange={setShown}
          />
          <View style={styles.frame} onLayout={(event) => height.set(event.nativeEvent.layout.height)}>
            {uri ? (
              // A fresh one per photo, so switching starts the other at 1×.
              <Zoomable key={shown} uri={uri} label={label} pulled={pulled} onDismiss={onClose} />
            ) : photos[shown] === null ? (
              <Hatch />
            ) : (
              <Muted>{t.photoOnline}</Muted>
            )}
            <View style={styles.tape} pointerEvents="none">
              <Tape>{uri ? label : `${label} · ${t.none}`}</Tape>
            </View>
          </View>
          <Button title={t.close} icon="close" variant="secondary" onPress={onClose} />
        </Animated.View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const MAX_ZOOM = 4;
const DOUBLE_TAP_ZOOM = 2.5;
/** Pulled down this far, or flicked this fast, at 1×: it closes. Either alone is enough. */
const DISMISS_DISTANCE = 120;
const DISMISS_VELOCITY = 800;
/** Settling home: no overshoot. Snapping back after a pull keeps the finger's speed. */
const SETTLE = { duration: 400, dampingRatio: 1 } as const;

/** Past an end it still moves, a quarter as far: the edge gives instead of stopping dead. */
function rubberBand(value: number, min: number, max: number) {
  'worklet';
  if (value < min) return min - (min - value) / 4;
  if (value > max) return max + (value - max) / 4;
  return value;
}

function clamp(value: number, limit: number) {
  'worklet';
  return Math.min(Math.max(value, -limit), limit);
}

function Zoomable({
  uri,
  label,
  pulled,
  onDismiss,
}: {
  uri: string;
  label: string;
  pulled: SharedValue<number>;
  onDismiss: () => void;
}) {
  const styles = useStyles();
  const reduced = useReducedMotion();
  const width = useSharedValue(0);
  const height = useSharedValue(0);
  const scale = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const start = useSharedValue({ scale: 1, x: 0, y: 0 });

  /** Back inside the frame at `zoom`: a zoomed photo's edge never leaves the frame's edge. */
  const settle = (zoom: number) => {
    'worklet';
    const target = Math.min(Math.max(zoom, 1), MAX_ZOOM);
    scale.set(withSpring(target, SETTLE));
    x.set(withSpring(clamp(x.get(), ((target - 1) * width.get()) / 2), SETTLE));
    y.set(withSpring(clamp(y.get(), ((target - 1) * height.get()) / 2), SETTLE));
  };

  const pinch = Gesture.Pinch()
    .onStart(() => {
      start.set({ scale: scale.get(), x: x.get(), y: y.get() });
    })
    .onUpdate((event) => {
      scale.set(rubberBand(start.get().scale * event.scale, 1, MAX_ZOOM));
    })
    .onEnd(() => settle(scale.get()));

  const pan = Gesture.Pan()
    .averageTouches(true)
    .onStart(() => {
      start.set({ scale: scale.get(), x: x.get(), y: y.get() });
    })
    .onUpdate((event) => {
      const zoom = scale.get();
      if (zoom > 1.01) {
        x.set(rubberBand(start.get().x + event.translationX, -((zoom - 1) * width.get()) / 2, ((zoom - 1) * width.get()) / 2));
        y.set(rubberBand(start.get().y + event.translationY, -((zoom - 1) * height.get()) / 2, ((zoom - 1) * height.get()) / 2));
      } else if (event.numberOfPointers === 1) {
        pulled.set(Math.max(0, event.translationY));
      }
    })
    .onEnd((event) => {
      if (scale.get() > 1.01) return settle(scale.get());
      if (pulled.get() === 0) return;
      if (pulled.get() > DISMISS_DISTANCE || event.velocityY > DISMISS_VELOCITY) {
        // Out the way it was going; under reduced motion it only fades (the photo never moved).
        pulled.set(
          withTiming(height.get(), { ...timing, reduceMotion: ReduceMotion.Never }, (finished) => {
            if (finished) scheduleOnRN(onDismiss);
          }),
        );
      } else {
        pulled.set(withSpring(0, reduced ? SETTLE : { duration: 300, dampingRatio: 0.8, velocity: event.velocityY }));
      }
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd((event) => {
      if (scale.get() > 1.01) return settle(1);
      // Zoom about the tapped point: it stays under the finger.
      const limitX = ((DOUBLE_TAP_ZOOM - 1) * width.get()) / 2;
      const limitY = ((DOUBLE_TAP_ZOOM - 1) * height.get()) / 2;
      x.set(withSpring(clamp((1 - DOUBLE_TAP_ZOOM) * (event.x - width.get() / 2), limitX), SETTLE));
      y.set(withSpring(clamp((1 - DOUBLE_TAP_ZOOM) * (event.y - height.get() / 2), limitY), SETTLE));
      scale.set(withSpring(DOUBLE_TAP_ZOOM, SETTLE));
    });

  const held = useAnimatedStyle(() => ({
    transform: [
      { translateX: x.get() },
      { translateY: y.get() + (reduced ? 0 : pulled.get()) },
      { scale: scale.get() },
    ],
  }));

  return (
    <GestureDetector gesture={Gesture.Race(doubleTap, Gesture.Simultaneous(pinch, pan))}>
      <View
        style={styles.stage}
        onLayout={(event) => {
          width.set(event.nativeEvent.layout.width);
          height.set(event.nativeEvent.layout.height);
        }}
      >
        <Animated.View style={[styles.stage, held]}>
          <Image source={{ uri }} style={styles.image} resizeMode="contain" accessibilityLabel={label} />
        </Animated.View>
      </View>
    </GestureDetector>
  );
}

const useStyles = createThemedStyles((theme) => ({
  root: { flex: 1 },
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
  stage: { width: '100%', height: '100%' },
  image: { width: '100%', height: '100%' },
  tape: { position: 'absolute', left: 0, bottom: 0 },
}));
