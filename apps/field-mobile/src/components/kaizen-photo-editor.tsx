import { useRef, useState } from 'react';
import { Image, Modal, PanResponder, Pressable, View, type GestureResponderEvent, type PanResponderGestureState } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { cropPhoto, finishPhoto, rotatePhoto, type EditableImage } from '../lib/capture/photo-edit';
import { cropStrokes, rotateStrokes, type MarkupColour, type Stroke } from '../lib/capture/photo-markup';
import type { ProcessedImage } from '../lib/capture/media';
import { KAIZEN_STRINGS } from '../lib/kaizen-strings';
import { useLanguage } from '../lib/language-provider';
import { ledgerMarkup } from '../lib/ledger';
import { createThemedStyles } from '../lib/theme';
import { Button, ErrorBanner, Segmented } from './ui';

type Tool = 'highlight' | 'crop';
interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
/** One state of the edit. Undo returns to the one before, whatever the step was. */
interface Snapshot {
  image: EditableImage;
  strokes: readonly Stroke[];
}
type Grab = 'tl' | 'tr' | 'bl' | 'br' | 'move' | null;

/** How thick each mark is on screen, so it reads the same on any photo. */
const STROKE_DP: Record<MarkupColour, number> = { yellow: 22, red: 5 };
/** A new point once the finger has moved this far: enough for a smooth line, few enough Views. */
const POINT_SPACING_DP = 4;
/** A corner is grabbed within a 48dp target; a crop is never smaller than that. */
const HANDLE_REACH_DP = 32;
const MIN_CROP_DP = 48;

/**
 * Crop, rotate and highlight a Kaizen photo before it is kept (owner, 2026-11-06), whether it
 * came from the camera or the gallery. Plain Views and `PanResponder`, as the phone's charts
 * are plain Views (R-48), so this ships without a new APK and runs the same in `/field`.
 *
 * `onDone(null)` means nothing was changed: the caller keeps the photo it already has.
 */
export function KaizenPhotoEditor({
  source,
  onDone,
  onCancel,
}: {
  source: EditableImage;
  onDone: (edited: ProcessedImage | null) => void;
  onCancel: () => void;
}) {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const { language } = useLanguage();
  const t = KAIZEN_STRINGS[language];
  const [history, setHistory] = useState<Snapshot[]>([]);
  const [current, setCurrent] = useState<Snapshot>({ image: source, strokes: [] });
  const [tool, setTool] = useState<Tool>('highlight');
  const [colour, setColour] = useState<MarkupColour>('yellow');
  const [drawing, setDrawing] = useState<Stroke | null>(null);
  const [crop, setCrop] = useState<Rect | null>(null);
  const [frame, setFrame] = useState({ width: 0, height: 0 });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const { image } = current;
  const scale = frame.width > 0 ? Math.min(frame.width / image.width, frame.height / image.height) : 0;
  const whole: Rect = { x: 0, y: 0, width: image.width, height: image.height };
  const shownCrop = crop ?? whole;

  const push = (next: Snapshot) => {
    setHistory((past) => [...past, current]);
    setCurrent(next);
    setCrop(null);
  };

  // The responder lives for the whole screen, so it reads the latest values through here.
  const live = useRef({ tool, colour, scale, image, shownCrop, current, push });
  live.current = { tool, colour, scale, image, shownCrop, current, push };
  const gesture = useRef<{ grab: Grab; rect: Rect; start: { x: number; y: number }; stroke: Stroke | null }>({
    grab: null,
    rect: whole,
    start: { x: 0, y: 0 },
    stroke: null,
  });

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (event: GestureResponderEvent) => {
        const { tool: active, colour: ink, scale: zoom, shownCrop: rect } = live.current;
        if (zoom === 0) return;
        const start = { x: event.nativeEvent.locationX / zoom, y: event.nativeEvent.locationY / zoom };
        if (active === 'highlight') {
          const stroke = { colour: ink, width: STROKE_DP[ink] / zoom, points: [start] };
          gesture.current = { ...gesture.current, start, stroke };
          setDrawing(stroke);
        } else {
          gesture.current = { ...gesture.current, start, rect, grab: grabOf(rect, start, HANDLE_REACH_DP / zoom) };
        }
      },
      onPanResponderMove: (_event, moved: PanResponderGestureState) => {
        const { scale: zoom, image: picture } = live.current;
        if (zoom === 0) return;
        const { start, stroke, grab, rect } = gesture.current;
        if (stroke) {
          const point = { x: start.x + moved.dx / zoom, y: start.y + moved.dy / zoom };
          const last = stroke.points[stroke.points.length - 1]!;
          if (Math.hypot(point.x - last.x, point.y - last.y) * zoom < POINT_SPACING_DP) return;
          const longer = { ...stroke, points: [...stroke.points, point] };
          gesture.current.stroke = longer;
          setDrawing(longer);
        } else if (grab) {
          setCrop(moveCrop(rect, grab, moved.dx / zoom, moved.dy / zoom, picture, MIN_CROP_DP / zoom));
        }
      },
      onPanResponderRelease: () => {
        const { stroke } = gesture.current;
        if (!stroke) return;
        gesture.current.stroke = null;
        setDrawing(null);
        const { current: now, push: keep } = live.current;
        keep({ image: now.image, strokes: [...now.strokes, stroke] });
      },
    }),
  ).current;

  /** One step that takes a moment. A frame goes by first, so "busy" shows before the work starts. */
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setFailed(false);
    try {
      await new Promise((resolve) => setTimeout(resolve, 16));
      await work();
    } catch (cause) {
      console.error('photo edit failed', cause);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const rotate = () =>
    run(async () => {
      const turned = await rotatePhoto(image);
      push({ image: turned, strokes: rotateStrokes(current.strokes, image.height) });
    });
  const applyCrop = () =>
    run(async () => {
      const rect = {
        x: Math.round(shownCrop.x),
        y: Math.round(shownCrop.y),
        width: Math.round(shownCrop.width),
        height: Math.round(shownCrop.height),
      };
      const cropped = await cropPhoto(image, rect);
      push({ image: cropped, strokes: cropStrokes(current.strokes, rect.x, rect.y) });
      setTool('highlight');
    });
  const undo = () => {
    const previous = history[history.length - 1];
    if (!previous) return;
    setHistory(history.slice(0, -1));
    setCurrent(previous);
    setCrop(null);
  };
  const finish = () => {
    if (history.length === 0) return onDone(null);
    void run(async () => onDone(await finishPhoto(image, current.strokes)));
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel} statusBarTranslucent>
      <View style={[styles.screen, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 }]}>
        <Segmented<Tool>
          options={[
            { value: 'highlight', label: t.highlight },
            { value: 'crop', label: t.crop },
          ]}
          value={tool}
          onChange={setTool}
        />
        <View
          style={styles.frame}
          onLayout={({ nativeEvent: { layout } }) => setFrame({ width: layout.width, height: layout.height })}
        >
          {scale > 0 ? (
            // Sized to the photo, so a touch's position in here is its position on the photo.
            <View style={[styles.stage, { width: image.width * scale, height: image.height * scale }]} {...responder.panHandlers}>
              <View style={styles.fill} pointerEvents="none">
                <Image source={{ uri: image.uri }} style={styles.fill} accessibilityLabel={t.editPhoto} />
                {[...current.strokes, ...(drawing ? [drawing] : [])].map((stroke, index) => (
                  <StrokeView key={index} stroke={stroke} scale={scale} />
                ))}
                {tool === 'crop' ? <CropOverlay rect={shownCrop} image={image} scale={scale} /> : null}
              </View>
            </View>
          ) : null}
        </View>

        <View style={styles.row}>
          {tool === 'highlight' ? (
            (Object.keys(ledgerMarkup) as MarkupColour[]).map((option) => (
              <Pressable
                key={option}
                accessibilityRole="radio"
                accessibilityState={{ checked: colour === option }}
                accessibilityLabel={option === 'yellow' ? t.markerYellow : t.markerRed}
                onPress={() => setColour(option)}
                style={[styles.swatch, colour === option && styles.swatchOn]}
              >
                <View style={[styles.swatchInk, { backgroundColor: ledgerMarkup[option].hex }]} />
              </Pressable>
            ))
          ) : (
            <View style={styles.flex}>
              <Button title={t.applyCrop} icon="crop" compact disabled={crop === null} busy={busy} onPress={() => void applyCrop()} />
            </View>
          )}
          <View style={styles.flex}>
            <Button title={t.rotate} icon="rotate-right" variant="secondary" compact disabled={busy} onPress={() => void rotate()} />
          </View>
          <View style={styles.flex}>
            <Button title={t.undo} icon="undo" variant="secondary" compact disabled={busy || history.length === 0} onPress={undo} />
          </View>
        </View>
        <ErrorBanner message={failed ? t.editFailed : null} />
        <View style={styles.row}>
          <View style={styles.flex}>
            <Button title={t.cancelPhoto} icon="close" variant="secondary" disabled={busy} onPress={onCancel} />
          </View>
          <View style={styles.flex}>
            <Button testID="kaizen-photo-use" title={t.usePhoto} icon="check" busy={busy} onPress={finish} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

function grabOf(rect: Rect, at: { x: number; y: number }, reach: number): Grab {
  const near = (x: number, y: number) => Math.hypot(at.x - x, at.y - y) <= reach;
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  if (near(rect.x, rect.y)) return 'tl';
  if (near(right, rect.y)) return 'tr';
  if (near(rect.x, bottom)) return 'bl';
  if (near(right, bottom)) return 'br';
  return at.x >= rect.x && at.x <= right && at.y >= rect.y && at.y <= bottom ? 'move' : null;
}

function moveCrop(rect: Rect, grab: Exclude<Grab, null>, dx: number, dy: number, image: EditableImage, least: number): Rect {
  if (grab === 'move') {
    return {
      ...rect,
      x: Math.min(Math.max(rect.x + dx, 0), image.width - rect.width),
      y: Math.min(Math.max(rect.y + dy, 0), image.height - rect.height),
    };
  }
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.width;
  let bottom = rect.y + rect.height;
  if (grab === 'tl' || grab === 'bl') left = Math.min(Math.max(left + dx, 0), right - least);
  else right = Math.max(Math.min(right + dx, image.width), left + least);
  if (grab === 'tl' || grab === 'tr') top = Math.min(Math.max(top + dy, 0), bottom - least);
  else bottom = Math.max(Math.min(bottom + dy, image.height), top + least);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** A mark as short rounded bars. One compositing group, so overlaps don't darken the highlighter. */
function StrokeView({ stroke, scale }: { stroke: Stroke; scale: number }) {
  const width = stroke.width * scale;
  const { hex, alpha } = ledgerMarkup[stroke.colour];
  return (
    <View style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, opacity: alpha }} needsOffscreenAlphaCompositing>
      {stroke.points.map((point, index) => {
        const from = stroke.points[index - 1] ?? point;
        const x = (from.x + point.x) * (scale / 2);
        const y = (from.y + point.y) * (scale / 2);
        const length = Math.hypot(point.x - from.x, point.y - from.y) * scale + width;
        return (
          <View
            key={index}
            style={{
              position: 'absolute',
              left: x - length / 2,
              top: y - width / 2,
              width: length,
              height: width,
              borderRadius: width / 2,
              backgroundColor: hex,
              transform: [{ rotate: `${Math.atan2(point.y - from.y, point.x - from.x)}rad` }],
            }}
          />
        );
      })}
    </View>
  );
}

/** What the crop would cut away is dimmed, with a corner mark at each of the four handles. */
function CropOverlay({ rect, image, scale }: { rect: Rect; image: EditableImage; scale: number }) {
  const styles = useStyles();
  const left = rect.x * scale;
  const top = rect.y * scale;
  const width = rect.width * scale;
  const height = rect.height * scale;
  const fullWidth = image.width * scale;
  const fullHeight = image.height * scale;
  return (
    <View style={styles.fill}>
      <View style={[styles.dim, { left: 0, top: 0, width: fullWidth, height: top }]} />
      <View style={[styles.dim, { left: 0, top: top + height, width: fullWidth, height: fullHeight - top - height }]} />
      <View style={[styles.dim, { left: 0, top, width: left, height }]} />
      <View style={[styles.dim, { left: left + width, top, width: fullWidth - left - width, height }]} />
      <View style={[styles.cropBox, { left, top, width, height }]} />
      {[
        [left, top],
        [left + width, top],
        [left, top + height],
        [left + width, top + height],
      ].map(([x, y], index) => (
        <View key={index} style={[styles.handle, { left: x! - 9, top: y! - 9 }]} />
      ))}
    </View>
  );
}

const useStyles = createThemedStyles((theme) => ({
  screen: { flex: 1, backgroundColor: theme.color.ground, paddingHorizontal: theme.space.md, gap: theme.space.sm },
  frame: { flex: 1, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  stage: { overflow: 'hidden' },
  fill: { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 },
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.space.sm },
  flex: { flex: 1 },
  swatch: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.control,
    borderWidth: 1,
    borderColor: theme.color.rule,
  },
  swatchOn: { borderWidth: 2, borderColor: theme.color.ink },
  swatchInk: { width: 24, height: 24, borderRadius: theme.radius.pill },
  dim: { position: 'absolute', backgroundColor: theme.color.scrim },
  cropBox: { position: 'absolute', borderWidth: 2, borderColor: theme.color.surface },
  handle: { position: 'absolute', width: 18, height: 18, borderRadius: theme.radius.pill, backgroundColor: theme.color.surface },
}));
