import { ledgerMarkup } from '../ledger';

/**
 * Marks drawn on a photograph, in the pixels of the image they were drawn on. Pure, with no
 * React Native in it, so the arithmetic is tested on its own.
 */
export type MarkupColour = keyof typeof ledgerMarkup;

export interface Stroke {
  colour: MarkupColour;
  /** Line thickness, in image pixels. */
  width: number;
  points: readonly { x: number; y: number }[];
}

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

/**
 * One edit. Saved with the photo, so reopening the editor can replay and undo them. Here, not in
 * `photo-edit.ts`, because the repository needs it and `apps/api` typechecks the repository:
 * React Native's global types must not reach that program.
 */
export type PhotoEditStep =
  | { type: 'rotate' }
  | { type: 'crop'; rect: CropRect }
  | { type: 'stroke'; stroke: Stroke }
  /** Removes the mark at this place in the list of marks at that moment. */
  | { type: 'erase'; index: number };

/** Where the marks land after the image turns 90° clockwise. */
export function rotateStrokes(strokes: readonly Stroke[], imageHeight: number): Stroke[] {
  return strokes.map((stroke) => ({
    ...stroke,
    points: stroke.points.map(({ x, y }) => ({ x: imageHeight - y, y: x })),
  }));
}

/** Where the marks land after a crop from this corner. A mark outside it is clipped when drawn. */
export function cropStrokes(strokes: readonly Stroke[], originX: number, originY: number): Stroke[] {
  return strokes.map((stroke) => ({
    ...stroke,
    points: stroke.points.map(({ x, y }) => ({ x: x - originX, y: y - originY })),
  }));
}

export function scaleStrokes(strokes: readonly Stroke[], factor: number): Stroke[] {
  return strokes.map((stroke) => ({
    ...stroke,
    width: stroke.width * factor,
    points: stroke.points.map(({ x, y }) => ({ x: x * factor, y: y * factor })),
  }));
}

/** The topmost mark under this point, within `reach` of its edge; -1 if none. */
export function strokeAt(strokes: readonly Stroke[], at: { x: number; y: number }, reach: number): number {
  for (let index = strokes.length - 1; index >= 0; index -= 1) {
    const stroke = strokes[index]!;
    const limit = stroke.width / 2 + reach;
    const hit = stroke.points.some((point, step) => {
      const from = stroke.points[step - 1] ?? point;
      const dx = point.x - from.x;
      const dy = point.y - from.y;
      const length = dx * dx + dy * dy;
      const along = length === 0 ? 0 : Math.min(1, Math.max(0, ((at.x - from.x) * dx + (at.y - from.y) * dy) / length));
      return Math.hypot(at.x - (from.x + along * dx), at.y - (from.y + along * dy)) <= limit;
    });
    if (hit) return index;
  }
  return -1;
}

/**
 * Paints the marks into RGBA pixels, in place. Each colour is rasterised to a mask first and
 * blended once, so a translucent highlighter stays even where its strokes cross.
 */
export function burnStrokes(rgba: Uint8Array, width: number, height: number, strokes: readonly Stroke[]): void {
  for (const colour of Object.keys(ledgerMarkup) as MarkupColour[]) {
    const mine = strokes.filter((stroke) => stroke.colour === colour);
    if (mine.length === 0) continue;
    const mask = new Uint8Array(width * height);
    for (const stroke of mine) {
      stroke.points.forEach((point, index) => {
        drawSegment(mask, width, height, stroke.points[index - 1] ?? point, point, stroke.width / 2);
      });
    }
    const { hex, alpha } = ledgerMarkup[colour];
    const channels = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16));
    for (let pixel = 0; pixel < mask.length; pixel += 1) {
      if (!mask[pixel]) continue;
      channels.forEach((value, channel) => {
        const at = pixel * 4 + channel;
        rgba[at] = Math.round(rgba[at]! * (1 - alpha) + value * alpha);
      });
    }
  }
}

function drawSegment(
  mask: Uint8Array,
  width: number,
  height: number,
  a: { x: number; y: number },
  b: { x: number; y: number },
  radius: number,
): void {
  const left = Math.max(0, Math.floor(Math.min(a.x, b.x) - radius));
  const right = Math.min(width - 1, Math.ceil(Math.max(a.x, b.x) + radius));
  const top = Math.max(0, Math.floor(Math.min(a.y, b.y) - radius));
  const bottom = Math.min(height - 1, Math.ceil(Math.max(a.y, b.y) + radius));
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const along = length === 0 ? 0 : Math.min(1, Math.max(0, ((x - a.x) * dx + (y - a.y) * dy) / length));
      const offX = x - (a.x + along * dx);
      const offY = y - (a.y + along * dy);
      if (offX * offX + offY * offY <= radius * radius) mask[y * width + x] = 1;
    }
  }
}
