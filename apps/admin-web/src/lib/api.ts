import type { ProblemDetails } from '@audit5s/contracts';

/**
 * Where the API is.
 *
 * A build configured with `http://localhost:3000/api/v1` is still opened from other
 * machines — a Zone Leader's phone following a PDF's corrective-action link through a
 * tunnel. On that phone `localhost` is the phone, so every request failed with "Could not
 * reach the server". When the configured host is loopback and the page is not, the page
 * uses its own origin instead; Vite's dev server proxies `/api` to the API.
 */
export const BASE_URL = resolveBaseUrl(import.meta.env.VITE_API_BASE_URL as string | undefined);

function resolveBaseUrl(configured: string | undefined): string {
  if (!configured) return '/api/v1';
  if (typeof window === 'undefined') return configured;
  const loopback = (host: string) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  try {
    const url = new URL(configured, window.location.href);
    if (loopback(url.hostname) && !loopback(window.location.hostname)) {
      return url.pathname.replace(/\/+$/, '');
    }
  } catch {
    // Not a URL: use it as written.
  }
  return configured;
}

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
    // origin behind the reverse proxy and this is a login-gated internal tool. The compensating
    // controls are the 15-minute access token and rotating refresh (§12.3).
    localStorage.setItem('audit5s.session', JSON.stringify(next));
  } else {
    localStorage.removeItem('audit5s.session');
  }
}

/**
 * Read from storage every time, not once: tabs share one session, and a tab that rotated
 * the refresh token must not leave another holding the spent one — presenting that revokes
 * the whole family (R-1) and signs every tab out.
 */
export function loadSession(): Session | null {
  try {
    const stored = localStorage.getItem('audit5s.session');
    session = stored ? (JSON.parse(stored) as Session) : null;
  } catch {
    // Storage unavailable: keep what this tab already holds.
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

/**
 * One rotation at a time — in this tab, and across tabs.
 *
 * A refresh token is single-use, and presenting a spent one revokes the whole family (R-1).
 * The dashboard fires seven queries at once, so when the 15-minute access token lapsed all
 * seven refreshed with the same token: one won, the other six were read as token theft, and
 * the user was signed out every fifteen minutes. Now they share the rotation in flight, and
 * a Web Lock keeps a second tab from spending the token the first is already rotating.
 *
 * With that fixed, a session lasts as long as it is used: every rotation issues a fresh
 * 30-day refresh token (STACK.md §2), so only 30 days of not opening the app signs out.
 */
let refreshing: Promise<boolean> | null = null;

function refresh(spent: string): Promise<boolean> {
  refreshing ??= withRefreshLock(() => rotate(spent)).finally(() => {
    refreshing = null;
  });
  return refreshing;
}

function withRefreshLock(task: () => Promise<boolean>): Promise<boolean> {
  // Absent outside a secure context (plain http on a LAN address); one tab is then all it guards.
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) return task();
  // The lock is held until the promise the callback returns settles, i.e. for the whole rotation.
  return new Promise<boolean>((resolve, reject) => {
    void locks.request('audit5s.refresh', () => task().then(resolve, reject));
  });
}

async function rotate(spent: string): Promise<boolean> {
  // Another tab, or an earlier request in this one, may already have rotated it.
  const current = loadSession();
  if (!current) return false;
  if (current.refreshToken !== spent) return true;

  const response = await fetch(`${BASE_URL}/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: spent }),
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

/**
 * A response that is a **document**, not a payload.
 *
 * `POST /reports/preview` returns HTML for template iteration (§8.9). It goes through its
 * own function rather than `send` because `send` parses JSON, and because the two failure
 * modes differ: a problem document here still arrives as JSON, so it is parsed only on the
 * error path.
 */
async function sendText(path: string, body: unknown): Promise<string> {
  const current = loadSession();
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(current ? { authorization: `Bearer ${current.accessToken}` } : {}),
    },
    body: JSON.stringify(body),
  });

  if (response.ok) {
    return response.text();
  }

  const problem = (await response.json().catch(() => null)) as ProblemDetails | null;
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

/**
 * Every page of a list, followed by its cursor.
 *
 * A screen that counts things, or offers a picker of everything there is, cannot stop at
 * the first page: `limit` caps at 200 (`paginationQuerySchema`), and a list that quietly
 * ends there looks exactly like a Unit that has only ever had two audits. The ceiling is a
 * guard against a runaway loop, not a page size.
 */
export async function fetchAll<T>(path: string, ceiling = 5000): Promise<T[]> {
  const rows: T[] = [];
  let cursor: string | null = null;
  do {
    const page: Paged<T> = await send<Paged<T>>(
      cursor ? `${path}&cursor=${encodeURIComponent(cursor)}` : path,
    );
    rows.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor && rows.length < ceiling);
  return rows;
}

interface Paged<T> {
  data: T[];
  nextCursor: string | null;
}

export const api = {
  get: <T>(path: string) => send<T>(path),
  postText: (path: string, body: unknown) => sendText(path, body),
  post: <T>(path: string, body?: unknown) => send<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body: unknown) => send<T>(path, { method: 'PATCH', body }),
  put: <T>(path: string, body: unknown) => send<T>(path, { method: 'PUT', body }),
  delete: <T>(path: string) => send<T>(path, { method: 'DELETE' }),
};
