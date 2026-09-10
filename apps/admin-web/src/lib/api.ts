import type { ProblemDetails } from '@audit5s/contracts';

const BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '/api/v1';

/**
 * A failed request, carrying the server's RFC 7807 problem document.
 *
 * The UI branches on `code`, never on the status alone or on the prose — that is what the
 * stable machine codes in §8.1 are for. `FIELD_NOT_EDITABLE` in particular arrives with the
 * offending fields, which the Unit form renders inline rather than as a toast.
 */
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

  /** Field-level messages, keyed by field, for react-hook-form to display. */
  fieldErrors(): Record<string, string> {
    return Object.fromEntries((this.problem.errors ?? []).map((e) => [e.field, e.message]));
  }
}

export interface Session {
  accessToken: string;
  refreshToken: string;
}

let session: Session | null = null;
let onUnauthenticated: (() => void) | null = null;

export function setSession(next: Session | null): void {
  session = next;
  if (next) {
    // Web uses storage here rather than httpOnly cookies because the API is on another
    // origin behind Cloudflare and this is a login-gated internal tool. The compensating
    // controls are the 15-minute access token and rotating refresh (§12.3).
    localStorage.setItem('audit5s.session', JSON.stringify(next));
  } else {
    localStorage.removeItem('audit5s.session');
  }
}

export function loadSession(): Session | null {
  if (session) return session;
  try {
    const stored = localStorage.getItem('audit5s.session');
    session = stored ? (JSON.parse(stored) as Session) : null;
  } catch {
    session = null;
  }
  return session;
}

export function onSessionLost(handler: () => void): void {
  onUnauthenticated = handler;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Skips the refresh-and-retry dance; used by the refresh call itself. */
  raw?: boolean;
}

async function send<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const current = loadSession();
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (current) headers.authorization = `Bearer ${current.accessToken}`;

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

  const problem = payload as ProblemDetails;

  // One transparent refresh attempt on an expired access token; anything else is final.
  if (!options.raw && problem?.code === 'TOKEN_EXPIRED' && current) {
    const refreshed = await refresh(current.refreshToken);
    if (refreshed) {
      return send<T>(path, { ...options, raw: true });
    }
  }

  if (response.status === 401) {
    setSession(null);
    onUnauthenticated?.();
  }

  throw new ApiError(
    problem ?? {
      type: 'about:blank',
      title: response.statusText,
      status: response.status,
      code: 'INTERNAL_ERROR',
      requestId: 'unknown',
    },
  );
}

async function refresh(refreshToken: string): Promise<boolean> {
  const response = await fetch(`${BASE_URL}/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });

  if (!response.ok) {
    setSession(null);
    onUnauthenticated?.();
    return false;
  }

  const pair = (await response.json()) as Session;
  setSession(pair);
  return true;
}

export const api = {
  get: <T>(path: string) => send<T>(path),
  post: <T>(path: string, body?: unknown) => send<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body: unknown) => send<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string) => send<T>(path, { method: 'DELETE' }),
};
