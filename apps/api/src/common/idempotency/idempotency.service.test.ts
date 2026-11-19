import { describe, expect, it } from 'vitest';
import { IdempotencyService } from './idempotency.service';
import type { IdempotencyRepository, IdempotencyRow } from './idempotency.repository';

const input = { key: 'k', userId: 'u', endpoint: 'POST /x', requestHash: 'h' };
const lostRace = Object.assign(new Error('Failed query'), {
  cause: { code: '23505', constraint: 'idempotency_key_pkey' },
});

/** A repository where the other request inserts the key between our find and our insert. */
function racing(afterwards: IdempotencyRow | null) {
  let finds = 0;
  return {
    find: async () => (finds++ === 0 ? null : afterwards),
    claim: async () => {
      throw lostRace;
    },
  } as unknown as IdempotencyRepository;
}

describe('IdempotencyService.claim', () => {
  it('answers a key claimed a moment ago by its twin as in progress, not a 500', async () => {
    const inFlight = { key: 'k', requestHash: 'h', responseStatus: null, responseBody: null, completedAt: null };
    await expect(new IdempotencyService(racing(inFlight)).claim(input)).rejects.toMatchObject({ status: 409 });
  });

  it('replays the twin when it has already finished', async () => {
    const done = { key: 'k', requestHash: 'h', responseStatus: 200, responseBody: { ok: 1 }, completedAt: new Date() };
    await expect(new IdempotencyService(racing(done)).claim(input)).resolves.toEqual({ status: 200, body: { ok: 1 } });
  });

  it('stops after one retry when the key is invisible (another user holds it)', async () => {
    await expect(new IdempotencyService(racing(null)).claim(input)).rejects.toMatchObject({ status: 409 });
  });
});
