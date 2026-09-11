import type {
  SyncBatchRequest,
  SyncBatchResponse,
  SyncStatus,
  UploadIntentResponse,
} from '@audit5s/contracts';

/**
 * Everything the sync engine needs from the network, as one interface.
 *
 * This file is the **port**, and it imports nothing from the React Native runtime — not
 * `expo-constants`, not the app's `api` client, nothing. The adapter that does lives in
 * `http-transport.ts`.
 *
 * The split is load-bearing rather than tidy. `acceptance-phase4.e2e.test.ts` drives this
 * engine against a real server inside the API's test process, and importing the adapter
 * there would drag `expo-modules-core` into a Node bundle that cannot parse it. The engine
 * holds the rules; the adapter holds the requests; neither knows about the other's runtime.
 *
 * `uploadObject` is separate from `uploadIntent` for the reason §5 gives: the object goes
 * **straight to storage** on the presigned URL, not through the API, so it is a different
 * request to a different host with a different auth model — a bare PUT carrying no session.
 */
export interface SyncTransport {
  pushBatch(request: SyncBatchRequest): Promise<SyncBatchResponse>;
  uploadIntent(payload: Record<string, unknown>): Promise<UploadIntentResponse>;
  uploadObject(
    intent: UploadIntentResponse,
    localFileUri: string,
    contentType: string,
  ): Promise<void>;
  status(): Promise<SyncStatus>;
}

/**
 * A transport failure the engine can reason about.
 *
 * The status and `Retry-After` are carried explicitly because `decideRetry` branches on
 * both: a 429 with a stated wait is the server telling the device the answer, and a 422 is
 * a bug that must not be retried eight times.
 */
export class TransportError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

/** Reads the app's file into bytes. Injected so the engine stays runtime-agnostic. */
export type ReadLocalFile = (uri: string) => Promise<Uint8Array>;
