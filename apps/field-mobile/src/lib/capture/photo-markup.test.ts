import { describe, expect, it } from 'vitest';
import { ledgerMarkup } from '../ledger';
import { burnStrokes, cropStrokes, liftCrops, rotateStrokes, scaleStrokes, strokeAt, type Stroke } from './photo-markup';

const white = (width: number, height: number) => new Uint8Array(width * height * 4).fill(255);
const pixel = (rgba: Uint8Array, width: number, x: number, y: number) => [...rgba.slice((y * width + x) * 4, (y * width + x) * 4 + 4)];
const line = (colour: Stroke['colour']): Stroke => ({
  colour,
  width: 2,
  points: [{ x: 2, y: 5 }, { x: 8, y: 5 }],
});

describe('moving marks with the image', () => {
  it('turns with a clockwise rotation', () => {
    // On a 10×6 image, the top-left corner goes to the top-right of the 6×10 result.
    const [turned] = rotateStrokes([{ colour: 'red', width: 2, points: [{ x: 0, y: 0 }] }], 6);
    expect(turned!.points[0]).toEqual({ x: 6, y: 0 });
  });

  it('moves with a crop and scales for a smaller image', () => {
    const [cropped] = cropStrokes([line('red')], 2, 5);
    expect(cropped!.points[0]).toEqual({ x: 0, y: 0 });
    const [scaled] = scaleStrokes([line('red')], 0.5);
    expect(scaled!.points[1]).toEqual({ x: 4, y: 2.5 });
    expect(scaled!.width).toBe(1);
  });
});

describe('liftCrops', () => {
  const dot = (x: number, y: number): Stroke => ({ colour: 'red', width: 2, points: [{ x, y }] });
  const size = { width: 100, height: 60 };

  it('leaves edits with no crop alone', () => {
    const steps = [{ type: 'stroke' as const, stroke: dot(1, 2) }, { type: 'rotate' as const }];
    expect(liftCrops(steps, size)).toEqual({ steps, crop: null });
  });

  it('moves a mark made on a cropped image back to its place on the whole one', () => {
    const { steps, crop } = liftCrops(
      [
        { type: 'stroke', stroke: dot(50, 30) },
        { type: 'crop', rect: { x: 10, y: 20, width: 40, height: 30 } },
        { type: 'stroke', stroke: dot(5, 5) },
        { type: 'erase', index: 0 },
      ],
      size,
    );
    expect(steps).toEqual([
      { type: 'stroke', stroke: dot(50, 30) },
      { type: 'stroke', stroke: dot(15, 25) },
      { type: 'erase', index: 0 },
    ]);
    expect(crop).toEqual({ x: 10, y: 20, width: 40, height: 30 });
  });

  it('adds up two crops', () => {
    const { crop } = liftCrops(
      [
        { type: 'crop', rect: { x: 10, y: 10, width: 50, height: 40 } },
        { type: 'crop', rect: { x: 5, y: 5, width: 20, height: 20 } },
      ],
      size,
    );
    expect(crop).toEqual({ x: 15, y: 15, width: 20, height: 20 });
  });

  it('turns the crop with the image, and a mark made after the turn lands inside it', () => {
    // On 100×60: a crop at (10,10) of 40×30, then a turn: the whole image is 60×100.
    const { steps, crop } = liftCrops(
      [
        { type: 'crop', rect: { x: 10, y: 10, width: 40, height: 30 } },
        { type: 'rotate' },
        { type: 'stroke', stroke: dot(0, 0) },
      ],
      size,
    );
    expect(crop).toEqual({ x: 20, y: 10, width: 30, height: 40 });
    expect(steps[1]).toEqual({ type: 'stroke', stroke: dot(20, 10) });
  });

  it('gives the same answer for edits already lifted and cropped again', () => {
    const first = liftCrops(
      [{ type: 'crop', rect: { x: 10, y: 10, width: 40, height: 30 } }, { type: 'rotate' }],
      size,
    );
    const again = liftCrops([...first.steps, { type: 'crop', rect: first.crop! }], size);
    expect(again).toEqual(first);
  });
});

describe('strokeAt', () => {
  const across = (y: number): Stroke => ({ colour: 'red', width: 2, points: [{ x: 0, y }, { x: 100, y }] });

  it('finds a mark along its length, not only at its points', () => {
    expect(strokeAt([across(10)], { x: 50, y: 12 }, 2)).toBe(0);
    expect(strokeAt([across(10)], { x: 50, y: 20 }, 2)).toBe(-1);
  });

  it('takes the topmost of two marks that overlap', () => {
    expect(strokeAt([across(10), across(11)], { x: 50, y: 10 }, 2)).toBe(1);
  });

  it('finds a single dot', () => {
    expect(strokeAt([{ colour: 'red', width: 4, points: [{ x: 5, y: 5 }] }], { x: 6, y: 6 }, 1)).toBe(0);
  });
});

describe('burnStrokes', () => {
  it('paints an opaque line in its colour and leaves the rest alone', () => {
    const rgba = white(10, 10);
    burnStrokes(rgba, 10, 10, [{ ...line('red') }]);
    const expected = [1, 3, 5].map((at) => parseInt(ledgerMarkup.red.hex.slice(at, at + 2), 16));
    expect(pixel(rgba, 10, 5, 5).slice(0, 3)).toEqual(expected);
    expect(pixel(rgba, 10, 5, 0)).toEqual([255, 255, 255, 255]);
  });

  it('blends a crossing highlighter only once', () => {
    const once = white(10, 10);
    burnStrokes(once, 10, 10, [line('yellow')]);
    const twice = white(10, 10);
    burnStrokes(twice, 10, 10, [line('yellow'), line('yellow')]);
    expect(pixel(twice, 10, 5, 5)).toEqual(pixel(once, 10, 5, 5));
    expect(pixel(once, 10, 5, 5)[3]).toBe(255);
  });

  it('clips a mark that runs off the image', () => {
    const rgba = white(4, 4);
    expect(() =>
      burnStrokes(rgba, 4, 4, [{ colour: 'red', width: 4, points: [{ x: -20, y: 2 }, { x: 30, y: 2 }] }]),
    ).not.toThrow();
    expect(rgba.length).toBe(4 * 4 * 4);
  });
});
