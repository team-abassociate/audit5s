import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppError } from '../errors';
import { IdempotencyRepository } from './idempotency.repository';

export interface StoredResponse {
  status: number;
  body: unknown;
}

/**
 * `Idempotency-Key` handling (ARCHITECTURE.md §8.2b), for operations with no natural key.
 *
 * Postgres-only, 48 hours. ARCHITECTURE.md described a Redis fast path in front of this;
 * STACK.md §6 forbids Redis, and at this volume the fast path bought nothing.
 *
 * Same key, same body → the stored response is replayed.
 * Same key, different body → 422 IDEMPOTENCY_KEY_REUSE, because that is a client bug and
 * silently running it would be worse than refusing.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly repository: IdempotencyRepository) {}

  static hashRequest(body: unknown): string {
    return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
  }

  /**
   * Claims the key. Returns the stored response if this is a replay of a completed call,
   * or `null` if the caller should proceed and then call `complete()`.
   */
  async claim(input: {
    key: string;
    userId: string;
    endpoint: string;
    requestHash: string;
  }): Promise<StoredResponse | null> {
    const existing = await this.repository.find(input.userId, input.key);

    if (existing) {
      if (existing.requestHash !== input.requestHash) {
        throw new AppError(
          'IDEMPOTENCY_KEY_REUSE',
          422,
          'Idempotency key reuse',
          'This Idempotency-Key was already used with a different request body',
        );
      }
      if (existing.completedAt && existing.responseStatus !== null) {
        return { status: existing.responseStatus, body: existing.responseBody };
      }
      // Still in flight. Refusing beats running the operation a second time.
      throw AppError.conflict('CONFLICT', 'A request with this Idempotency-Key is in progress');
    }

    await this.repository.claim(input);
    return null;
  }

  async complete(input: {
    key: string;
    userId: string;
    status: number;
    body: unknown;
  }): Promise<void> {
    await this.repository.complete(input);
  }

  /** Releases a claim whose operation failed, so a retry is not blocked by the first attempt. */
  async release(key: string, userId: string): Promise<void> {
    await this.repository.release(key, userId);
  }
}
