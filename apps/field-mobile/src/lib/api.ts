import Constants from 'expo-constants';
import { randomUUID } from 'expo-crypto';
import { HEADER_DEVICE_ID, HEADER_IDEMPOTENCY_KEY, type ProblemDetails } from '@audit5s/contracts';
import { clearSession, getDeviceId, loadSession, saveSession, type StoredSession } from './secure-storage';

const BASE_URL =
  (Constants.expoConfig?.extra?.apiBaseUrl as string | undefined) ?? 'http://10.0.2.2:3000/api/v1';

/** A failed request, carrying the server's RFC 7807 document. The UI branches on `code`. */
export class ApiError extends Error {
  constructor(readonly problem: ProblemDetails) {
    super(problem.detail ?? problem.title);
    this.name = 'ApiError';
  }

  get code(): string {
    return this.problem.code;
  }

  get status(): number {
    return this.problem.status;
  }
}

let cached: StoredSession | null = null;
let onSessionLost: (() => void) | null = null;

export function setSessionLostHandler(handler: (() => void) | null): void {
  onSessionLost = handler;
}

export async function getSession(): Promise<StoredSession | null> {
  cached ??= await loadSession();
  return cached;
}

export async function setSession(next: StoredSession | null): Promise<void> {
  cached = next;
  if (next) {
    await saveSession(next);
  } else {
    await clearSession();
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Skips refresh-and-retry; used by the refresh call itself so it cannot recurse. */
  raw?: boolean;
  /** Minted once per write and reused by the token-refresh retry, so a replay is one change. */
  idempotencyKey?: string;
}

async function send<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const session = await getSession();
  const headers: Record<string, string> = {
    // Required on every mobile write (§8.1). Sent on reads too, so the server's
    // `last_seen_at` reflects the device even when it is only browsing.
    [HEADER_DEVICE_ID]: await getDeviceId(),
  };

  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.method && options.method !== 'GET') {
    options.idempotencyKey ??= randomUUID();
    headers[HEADER_IDEMPOTENCY_KEY] = options.idempotencyKey;
  }
  if (session) headers.authorization = `Bearer ${session.accessToken}`;

  const response = await fetch(`${BASE_URL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const payload: unknown = await response.json().catch(() => null);

  if (response.ok) {
    return payload as T;
  }

  const problem = payload as ProblemDetails | null;

  // One transparent refresh on an expired access token. Anything else is final: in
  // particular TOKEN_REUSED means the family was revoked (R-1), and retrying would just
  // revoke the next one too.
  if (!options.raw && problem?.code === 'TOKEN_EXPIRED' && session) {
    if (await refresh(session.refreshToken)) {
      return send<T>(path, { ...options, raw: true });
    }
  }

  if (response.status === 401) {
    await setSession(null);
    onSessionLost?.();
  }

  throw new ApiError(
    problem ?? {
      type: 'about:blank',
      title: response.statusText || 'Request failed',
      status: response.status,
      code: 'INTERNAL_ERROR',
      requestId: 'unknown',
    },
  );
}

async function refresh(refreshToken: string): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });

    if (!response.ok) {
      await setSession(null);
      onSessionLost?.();
      return false;
    }

    const pair = (await response.json()) as StoredSession;
    await setSession(pair);
    return true;
  } catch {
    // A network failure is not an authentication failure: keep the session so the user is
    // not signed out for walking into a steel-framed building.
    return false;
  }
}

export const api = {
  /** Where this build points. The deep-link route derives the web app's origin from it. */
  baseUrl: () => BASE_URL,
  get: <T>(path: string) => send<T>(path),
  post: <T>(path: string, body?: unknown) => send<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body: unknown) => send<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string) => send<T>(path, { method: 'DELETE' }),
};

/** The words to show for a failed request: the server's sentence and its field messages. */
export function problemMessage(error: unknown): string | null {
  if (!error) return null;
  if (error instanceof ApiError) {
    const fields = error.problem.errors ?? [];
    return fields.length > 0
      ? `${error.message}: ${fields.map((field) => field.message).join('; ')}`
      : error.message;
  }
  return 'Could not reach the server. Check the connection and try again.';
}
