import { Platform } from 'react-native';
import { File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { decode, encode } from 'jpeg-js';
import { processCapturedPhoto, readFileBytes, type ProcessedImage } from './media';
import { burnStrokes, cropStrokes, rotateStrokes, scaleStrokes, type Stroke } from './photo-markup';

/** A photograph being edited. Each step writes a new file, so Undo only goes back to the last one. */
export interface EditableImage {
  uri: string;
  width: number;
  height: number;
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One edit. Saved with the photo, so reopening the editor can replay and undo them. */
export type PhotoEditStep = { type: 'rotate' } | { type: 'crop'; rect: CropRect } | { type: 'stroke'; stroke: Stroke };

/** One state of the edit. Undo returns to the one before, whatever the step was. */
export interface PhotoEditState {
  image: EditableImage;
  strokes: readonly Stroke[];
  steps: readonly PhotoEditStep[];
}

/** Synchronous, so a mark never blinks off between the finger lifting and it being kept. */
export function addStroke(state: PhotoEditState, stroke: Stroke): PhotoEditState {
  return { image: state.image, strokes: [...state.strokes, stroke], steps: [...state.steps, { type: 'stroke', stroke }] };
}

export async function applyPhotoStep(state: PhotoEditState, step: PhotoEditStep): Promise<PhotoEditState> {
  if (step.type === 'stroke') return addStroke(state, step.stroke);
  const steps = [...state.steps, step];
  if (step.type === 'rotate') {
    return { image: await rotatePhoto(state.image), strokes: rotateStrokes(state.strokes, state.image.height), steps };
  }
  return { image: await cropPhoto(state.image, step.rect), strokes: cropStrokes(state.strokes, step.rect.x, step.rect.y), steps };
}

/** Every state from the original to the last step: the reopened editor's Undo history. */
export async function replayPhotoSteps(original: EditableImage, steps: readonly PhotoEditStep[]): Promise<PhotoEditState[]> {
  const states: PhotoEditState[] = [{ image: original, strokes: [], steps: [] }];
  for (const step of steps) states.push(await applyPhotoStep(states[states.length - 1]!, step));
  return states;
}

/**
 * ponytail: a highlighted photo is saved at this long edge, because the marks are painted by
 * JavaScript (the installed APK has no native way to flatten a drawing into an image, and a
 * native module would force a new APK). It stays sharp in the sheet's photo box. Move to a
 * native capture when the next APK goes out if saving proves too slow on the plant's phones.
 */
const MARKED_LONG_EDGE_PX = 1280;
/** Above the pipeline's q80, which is the one compression step that is kept. */
const WORKING_QUALITY = 0.95;
const MARKED_JPEG_QUALITY = 90;

async function saved(context: ReturnType<typeof ImageManipulator.manipulate>): Promise<EditableImage> {
  const image = await context.renderAsync();
  const { uri, width, height } = await image.saveAsync({ compress: WORKING_QUALITY, format: SaveFormat.JPEG });
  image.release();
  return { uri, width, height };
}

export function rotatePhoto(image: EditableImage): Promise<EditableImage> {
  return saved(ImageManipulator.manipulate(image.uri).rotate(90));
}

export function cropPhoto(image: EditableImage, rect: CropRect): Promise<EditableImage> {
  return saved(
    ImageManipulator.manipulate(image.uri).crop({
      originX: rect.x,
      originY: rect.y,
      width: rect.width,
      height: rect.height,
    }),
  );
}

/** The finished photo, through the same pipeline as any capture: sized, hashed, kept durably. */
export async function finishPhoto(image: EditableImage, strokes: readonly Stroke[]): Promise<ProcessedImage> {
  if (strokes.length === 0) return processCapturedPhoto(image.uri, { width: image.width, height: image.height });

  const factor = Math.min(1, MARKED_LONG_EDGE_PX / Math.max(image.width, image.height));
  const small = await saved(
    ImageManipulator.manipulate(image.uri).resize(
      image.width >= image.height
        ? { width: Math.round(image.width * factor) }
        : { height: Math.round(image.height * factor) },
    ),
  );
  const decoded = decode(await readFileBytes(small.uri), { useTArray: true, formatAsRGBA: true });
  const rgba = decoded.data as unknown as Uint8Array;
  burnStrokes(rgba, decoded.width, decoded.height, scaleStrokes(strokes, decoded.width / image.width));
  const uri = await writeJpeg(encodeJpeg(rgba, decoded.width, decoded.height));
  return processCapturedPhoto(uri, { width: decoded.width, height: decoded.height });
}

/**
 * jpeg-js ends its encoder with `Buffer.from(bytes)`, and Hermes has no `Buffer`. Lent only for
 * this call, so nothing else in the app sees a half-made one and takes it for Node's.
 */
function encodeJpeg(data: Uint8Array, width: number, height: number): Uint8Array {
  const scope = globalThis as { Buffer?: unknown };
  const lent = scope.Buffer === undefined;
  if (lent) scope.Buffer = { from: (bytes: ArrayLike<number>) => Uint8Array.from(bytes) };
  try {
    return encode({ data: data as never, width, height }, MARKED_JPEG_QUALITY).data as unknown as Uint8Array;
  } finally {
    if (lent) delete scope.Buffer;
  }
}

async function writeJpeg(bytes: Uint8Array): Promise<string> {
  if (Platform.OS === 'web') return URL.createObjectURL(new Blob([bytes as never], { type: 'image/jpeg', lastModified: Date.now() }));
  const file = new File(Paths.cache, `marked-${Date.now()}.jpg`);
  file.create({ overwrite: true });
  file.write(bytes);
  return file.uri;
}
