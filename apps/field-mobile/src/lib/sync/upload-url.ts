/**
 * The upload address, made reachable from this phone.
 *
 * An API with no object store serves uploads itself, at the address it was configured
 * with — `127.0.0.1` on a developer's Mac. From a phone or an emulator that is the phone
 * itself: every PUT was refused, each photograph dead-lettered after eight attempts, and the
 * bar showed "need attention" for work that was never at fault. A loopback host can never
 * be right from a device, so it is replaced with the host the app already reaches the API
 * on. The signature covers the path and the query, not the host, so it still verifies. A
 * real object store's address is never loopback and passes through untouched.
 */
export function reachableUploadUrl(uploadUrl: string, apiBase: string): string {
  // String parsing rather than `URL`: React Native's is read-only and incomplete.
  const upload = ORIGIN.exec(uploadUrl);
  const api = ORIGIN.exec(apiBase);
  if (!upload || !api || !LOOPBACK.has(upload[2]!.toLowerCase())) return uploadUrl;
  return api[0] + uploadUrl.slice(upload[0].length);
}

/** `scheme://host[:port]`, with the host as group 2 (a bracketed IPv6 host included). */
const ORIGIN = /^(https?:\/\/)(\[[^\]]+\]|[^/:?#]+)(:\d+)?/i;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
