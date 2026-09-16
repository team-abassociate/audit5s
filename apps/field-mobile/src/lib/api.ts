import Constants from 'expo-constants';
import { randomUUID } from 'expo-crypto';
import { HEADER_DEVICE_ID, HEADER_IDEMPOTENCY_KEY, type ProblemDetails } from '@audit5s/contracts';
import {
  clearSession,
  getDeviceId,
  loadServerAddress,
  loadSession,
  saveServerAddress,
  saveSession,
  type StoredSession,
} from './secure-storage';

/** Where this build points unless the device has been told otherwise. */
const DEFAULT_BASE_URL =
  (Constants.expoConfig?.extra?.apiBaseUrl as string | undefined) ?? 'http://10.0.2.2:3000/api/v1';

/**
 * The server this install talks to.
 *
 * A build bakes one address in, which is right for a deployment behind a hostname and
 * wrong on a bench test: the laptop moves to another Wi-Fi, takes a new address with it,
 * and an app compiled with the old one knocks at a door that is no longer there. So the
 * address is settable on the device and remembered in the keystore.
 */
let currentBaseUrl = DEFAULT_BASE_URL;

export function apiBaseUrl(): string {
  return currentBaseUrl;
}

export function defaultApiBaseUrl(): string {
  return DEFAULT_BASE_URL;
}

/** Reads the stored address. Called once at launch, before the first request goes out. */
export async function loadApiBaseUrl(): Promise<string> {
  currentBaseUrl = (await loadServerAddress()) ?? DEFAULT_BASE_URL;
  return currentBaseUrl;
}

/**
 * Remembers what a person typed. `null` — or an empty box — restores the build's own
 * address, so there is always a way back from a typo.
 */
export async function setApiBaseUrl(value: string | null): Promise<string> {
  currentBaseUrl =
    value === null || value.trim() === '' ? DEFAULT_BASE_URL : normaliseBaseUrl(value);
  await saveServerAddress(currentBaseUrl === DEFAULT_BASE_URL ? null : currentBaseUrl);
  return currentBaseUrl;
}

/**
 * `192.168.1.5`, `192.168.1.5:3000` or a whole URL, all into the API's base.
 *
 * Parsed by hand rather than with `URL`, whose React Native implementation is partial. A
 * plain host gets the API's port and path, which is what somebody reading an address off a
 * laptop screen will type; anything more specific is left as written.
 */
export function normaliseBaseUrl(value: string): string {
  const trimmed = withoutTrailingSlashes(value.trim());
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const separator = withScheme.indexOf('://');
  const scheme = withScheme.slice(0, separator).toLowerCase();
  const rest = withScheme.slice(separator + 3);
  const firstSlash = rest.indexOf('/');
  const host = firstSlash === -1 ? rest : rest.slice(0, firstSlash);
  const path = withoutTrailingSlashes(firstSlash === -1 ? '' : rest.slice(firstSlash));
  if (host === '') return DEFAULT_BASE_URL;

  // A bare host means somebody read an address off a laptop screen: give it the API's port
  // and path. Anything more specific was typed on purpose and is left alone.
  const authority = /:\d+$/.test(host) || scheme === 'https' ? host : `${host}:3000`;
  return `${scheme}://${authority}${path === '' ? '/api/v1' : path}`;
}

function withoutTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

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

  const response = await fetch(`${apiBaseUrl()}${path}`, {
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

/**
 * One rotation at a time.
 *
 * A refresh token is single-use, and presenting a spent one revokes the whole family (R-1).
 * When the access token lapses under several requests at once — a sync push beside a
 * screen's queries — each of them used to refresh with the same token: the first won and
 * the rest signed the user out. They now share the one rotation in flight.
 */
let refreshing: Promise<boolean> | null = null;

function refresh(spent: string): Promise<boolean> {
  refreshing ??= rotate(spent).finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function rotate(spent: string): Promise<boolean> {
  // A request that started before the last rotation comes back holding the token it spent;
  // the session already carries its successor, so a plain retry is all it needs.
  const current = await getSession();
  if (!current) return false;
  if (current.refreshToken !== spent) return true;

  try {
    const response = await fetch(`${apiBaseUrl()}/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: spent }),
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
  baseUrl: () => apiBaseUrl(),
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
