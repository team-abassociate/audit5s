import { AsyncLocalStorage } from 'node:async_hooks';
import type { ActorContext } from '@audit5s/domain';

/**
 * Per-request ambient state.
 *
 * Deliberately narrow: the request ID (for correlation and the audit log) and the resolved
 * actor. Business data does not belong here — passing it explicitly is what makes the
 * scope argument on every repository method visible rather than ambient (AZ-1).
 */
export interface RequestContext {
  requestId: string;
  actor: ActorContext | null;
  /** "Rahul Sharma (RA3210)" — snapshotted into audit_log so a rename cannot obscure it. */
  actorLabel: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  /** The access token's JTI, so a revocation can name the exact session. */
  jti: string | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, work: () => T): T {
  return storage.run(context, work);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/** Set once the guard chain has authenticated and resolved scope. */
export function setActor(actor: ActorContext, actorLabel: string): void {
  const context = storage.getStore();
  if (context) {
    context.actor = actor;
    context.actorLabel = actorLabel;
  }
}

export function setJti(jti: string): void {
  const context = storage.getStore();
  if (context) {
    context.jti = jti;
  }
}
