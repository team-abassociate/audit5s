// Apply the saved theme before the first paint. Kept external for a script-src 'self' CSP.
try {
  const mode = globalThis.localStorage.getItem('gemba-theme');
  globalThis.document.documentElement.setAttribute('data-theme', mode === 'dark' ? 'dark' : 'light');
} catch {
  globalThis.document.documentElement.setAttribute('data-theme', 'light');
}
