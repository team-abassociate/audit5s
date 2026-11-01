// Apply a saved theme choice before the first paint; with none, the CSS follows the device
// (docs/design/LEDGER.md, Themes). Kept external for a script-src 'self' CSP.
try {
  const mode = globalThis.localStorage.getItem('audit5s-theme');
  if (mode === 'light' || mode === 'dark') globalThis.document.documentElement.setAttribute('data-theme', mode);
} catch {
  // No storage: the device setting decides.
}
