import type {
  SyncBatchResponse,
  SyncStatus,
  UploadIntentResponse,
} from '@audit5s/contracts';
import { api, ApiError, apiBaseUrl } from '../api';
import { TransportError, type ReadLocalFile, type SyncTransport } from './transport';
import { reachableUploadUrl } from './upload-url';

/**
 * The production transport: the app's authenticated `api` client for the JSON calls, and a
 * bare `fetch` for the presigned PUT.
 */
export function createSyncTransport(readFile: ReadLocalFile): SyncTransport {
  return {
    async pushBatch(request) {
      try {
        return await api.post<SyncBatchResponse>('/sync/batch', request);
      } catch (error) {
        throw toTransportError(error);
      }
    },

    async uploadIntent(payload) {
      try {
        return await api.post<UploadIntentResponse>('/evidence/upload-intent', payload);
      } catch (error) {
        throw toTransportError(error);
      }
    },

    async uploadObject(intent, localFileUri, contentType) {
      const bytes = await readFile(localFileUri);

      // No `Authorization` header, deliberately: the URL carries its own authority, which
      // is the whole point of presigning (§5). Sending a session token here would be
      // harmless and misleading — it would suggest the API is in the path when it is not.
      const response = await fetch(reachableUploadUrl(intent.uploadUrl, apiBaseUrl()), {
        method: 'PUT',
        headers: { ...intent.requiredHeaders, 'content-type': contentType },
        // React Native's `fetch` types name the body differently from the DOM's, and the
        // bytes are the same either way.
        body: bytes as unknown as Parameters<typeof fetch>[1] extends { body?: infer B }
          ? B
          : never,
      });

      if (!response.ok) {
        throw new TransportError(
          `Upload failed: ${response.status}`,
          response.status,
          retryAfterMs(response.headers.get('retry-after')),
        );
      }
    },

    async status() {
      try {
        return await api.get<SyncStatus>('/sync/status');
      } catch (error) {
        throw toTransportError(error);
      }
    },
  };
}

function toTransportError(error: unknown): TransportError {
  if (error instanceof ApiError) {
    return new TransportError(error.message, error.status);
  }
  // A network failure carries no status, and `decideRetry` treats that as retryable —
  // which is the normal case in a plant and exactly what backoff is for.
  return new TransportError(
    error instanceof Error ? error.message : 'Network error',
    null,
  );
}

/** `Retry-After` is seconds or an HTTP date; both are honoured (§9.3). */
function retryAfterMs(header: string | null): number | null {
  if (!header) return null;

  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds) * 1000;

  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}
