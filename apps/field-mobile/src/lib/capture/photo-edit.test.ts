import { describe, expect, it, vi } from 'vitest';
import { applyPhotoStep, reopenPhotoEdit } from './photo-edit';

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
  it('opens on the whole photo with the crop waiting, and Undo goes back through the rest', async () => {
    const rect = { x: 10, y: 10, width: 40, height: 30 };
    const states = await reopenPhotoEdit(ORIGINAL, [{ type: 'stroke', stroke }, { type: 'crop', rect }]);

    expect(states).toHaveLength(3);
    // It opens here: the image never cropped, the mark where it was drawn, the crop waiting.
    expect(states[2]).toMatchObject({ image: ORIGINAL, pendingCrop: rect });
    expect(states[2]!.strokes[0]!.points[0]).toEqual({ x: 50, y: 30 });
    // One Undo takes the crop off, the next the mark: the untouched original.
    expect(states[1]!.pendingCrop).toBeUndefined();
    expect(states[1]!.strokes).toHaveLength(1);
    expect(states[0]).toEqual({ image: ORIGINAL, strokes: [], steps: [] });
  });

  it('turns the waiting crop with the photo', async () => {
    const [opened] = (await reopenPhotoEdit(ORIGINAL, [{ type: 'crop', rect: { x: 10, y: 10, width: 40, height: 30 } }])).slice(-1);
    const turned = await applyPhotoStep(opened!, { type: 'rotate' });
    expect(turned.image).toEqual({ uri: 'turned:original', width: 60, height: 100 });
    expect(turned.pendingCrop).toEqual({ x: 20, y: 10, width: 30, height: 40 });
  });

  it('crops for real, and the crop stops waiting', async () => {
    const [opened] = (await reopenPhotoEdit(ORIGINAL, [{ type: 'crop', rect: { x: 10, y: 10, width: 40, height: 30 } }])).slice(-1);
    const rect = { x: 0, y: 0, width: 50, height: 50 };
    const cropped = await applyPhotoStep(opened!, { type: 'crop', rect });
    expect(cropped.pendingCrop).toBeUndefined();
    expect(cropped.steps).toEqual([{ type: 'crop', rect }]);
  });

  it('keeps an erased mark gone, and one Undo back it returns', async () => {
    const other = { ...stroke, colour: 'yellow' as const };
    const states = await reopenPhotoEdit(ORIGINAL, [
      { type: 'stroke', stroke },
      { type: 'stroke', stroke: other },
      { type: 'erase', index: 0 },
    ]);
    expect(states[3]!.strokes).toEqual([other]);
    expect(states[2]!.strokes).toEqual([stroke, other]);
  });
});
