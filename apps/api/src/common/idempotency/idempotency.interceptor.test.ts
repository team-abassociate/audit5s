import { Reflector } from '@nestjs/core';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { runWithRequestContext } from '../observability/request-context';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import type { IdempotencyService } from './idempotency.service';

/** A POST carrying an Idempotency-Key, from a signed-in actor. */
function post(interceptor: IdempotencyInterceptor, handler: CallHandler) {
  const context = {
    getType: () => 'http',
    getHandler: () => () => undefined,
    switchToHttp: () => ({
      getRequest: () => ({ method: 'POST', headers: { 'idempotency-key': 'k-1' }, body: {}, url: '/x' }),
    }),
  } as unknown as ExecutionContext;
  return runWithRequestContext(
    { requestId: 'r', actor: { userId: 'u-1' } as never, actorLabel: null, ipAddress: null, userAgent: null, jti: null },
    () => firstValueFrom(interceptor.intercept(context, handler)),
  );
}

describe('IdempotencyInterceptor', () => {
  it('stores the replay before the response leaves, so an immediate retry is not a 409', async () => {
    const order: string[] = [];
    let finish!: () => void;
    const service = {
      claim: async () => null,
      complete: () => new Promise<void>((resolve) => (finish = () => (order.push('completed'), resolve()))),
      release: async () => undefined,
    } as unknown as IdempotencyService;
    const response = post(new IdempotencyInterceptor(service, new Reflector()), { handle: () => of({ id: 1 }) }).then(
      (body) => (order.push('responded'), body),
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual([]);
    finish();
    expect(await response).toEqual({ id: 1 });
    expect(order).toEqual(['completed', 'responded']);
  });

  it('still answers when storing the replay fails, and does not free the key', async () => {
    const released: string[] = [];
    const service = {
      claim: async () => null,
      complete: async () => {
        throw new Error('db blip');
      },
      release: async (key: string) => void released.push(key),
    } as unknown as IdempotencyService;
    const body = await post(new IdempotencyInterceptor(service, new Reflector()), { handle: () => of({ id: 2 }) });
    expect(body).toEqual({ id: 2 });
    expect(released).toEqual([]);
  });

  it('frees the key before a failed operation’s error leaves, so the retry runs', async () => {
    const released: string[] = [];
    const service = {
      claim: async () => null,
      complete: async () => undefined,
      release: async (key: string) => void released.push(key),
    } as unknown as IdempotencyService;
    const failing = { handle: () => throwError(() => new Error('refused')) };
    await expect(post(new IdempotencyInterceptor(service, new Reflector()), failing)).rejects.toThrow('refused');
    expect(released).toEqual(['k-1']);
  });
});
