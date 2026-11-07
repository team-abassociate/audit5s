import { describe, expect, it, vi } from 'vitest';
import { replayPhotoSteps, type PhotoEditStep } from './photo-edit';

// Only the file writes are faked: each crop or turn reports the size it would produce.
vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
vi.mock('expo-file-system', () => ({ File: class {}, Paths: {} }));
vi.mock('./media', () => ({ processCapturedPhoto: vi.fn(), readFileBytes: vi.fn() }));
vi.mock('expo-image-manipulator', () => ({
  SaveFormat: { JPEG: 'jpeg' },
  ImageManipulator: {
    manipulate: (uri: string) => {
      const size = uri.startsWith('cropped') ? { width: 40, height: 30 } : { width: 100, height: 60 };
      const finish = (result: { uri: string; width: number; height: number }) => ({
        renderAsync: async () => ({ saveAsync: async () => result, release: () => undefined }),
      });
      return {
        rotate: () => finish({ uri: `turned:${uri}`, width: size.height, height: size.width }),
        crop: (rect: { width: number; height: number }) => finish({ uri: `cropped:${uri}`, width: rect.width, height: rect.height }),
      };
    },
  },
}));

const ORIGINAL = { uri: 'original', width: 100, height: 60 };
const stroke = { colour: 'red' as const, width: 2, points: [{ x: 50, y: 30 }] };

describe('replaying saved edits', () => {
  it('rebuilds every state from the original, so each can be undone in turn', async () => {
    const steps: PhotoEditStep[] = [
      { type: 'stroke', stroke },
      { type: 'crop', rect: { x: 10, y: 10, width: 40, height: 30 } },
      { type: 'rotate' },
    ];
    const states = await replayPhotoSteps(ORIGINAL, steps);

    expect(states.map((state) => state.steps.length)).toEqual([0, 1, 2, 3]);
    // Undoing everything gets back the untouched original, with no marks on it.
    expect(states[0]).toEqual({ image: ORIGINAL, strokes: [], steps: [] });
    // The mark follows the crop, then the turn on the 40×30 crop.
    expect(states[2]!.strokes[0]!.points[0]).toEqual({ x: 40, y: 20 });
    expect(states[3]!.strokes[0]!.points[0]).toEqual({ x: 10, y: 40 });
    expect(states[3]!.image).toEqual({ uri: 'turned:cropped:original', width: 30, height: 40 });
    expect(states[3]!.steps).toEqual(steps);
  });

  it('keeps an erased mark gone, and one Undo back it returns', async () => {
    const other = { ...stroke, colour: 'yellow' as const };
    const states = await replayPhotoSteps(ORIGINAL, [
      { type: 'stroke', stroke },
      { type: 'stroke', stroke: other },
      { type: 'erase', index: 0 },
    ]);
    expect(states[3]!.strokes).toEqual([other]);
    expect(states[2]!.strokes).toEqual([stroke, other]);
  });
});
