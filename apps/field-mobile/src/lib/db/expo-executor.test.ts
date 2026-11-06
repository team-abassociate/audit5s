import { describe, expect, it, vi } from 'vitest';

const opens = vi.hoisted(() => ({ started: [] as string[], finish: [] as Array<(value: unknown) => void> }));

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-file-system/legacy', () => ({}));
vi.mock('expo-sqlite', () => ({
  openDatabaseAsync: (name: string) =>
    new Promise((resolve) => {
      opens.started.push(name);
      opens.finish.push(resolve);
    }),
}));

const { openExpoExecutor } = await import('./expo-executor');
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('opening local databases (the web worker loads SQLite twice if two opens overlap)', () => {
  it('starts the next open only when the last has finished', async () => {
    const first = openExpoExecutor('signed-out.db');
    const second = openExpoExecutor('person.db');
    await settle();
    expect(opens.started).toEqual(['signed-out.db']);

    opens.finish[0]!({});
    await first;
    await settle();
    expect(opens.started).toEqual(['signed-out.db', 'person.db']);

    opens.finish[1]!({});
    await second;
  });
});
