import { useEffect, useState } from 'react';

/**
 * Reads design-system token values out of the document.
 *
 * Recharts wants colours as strings, not classes, so this is the one sanctioned way to get
 * one (GEMBA-BOARD.md §8: "pass token values via CSS variables read from
 * `getComputedStyle`, never hard-coded hex"). It re-reads when the theme attribute
 * changes, so a chart repaints with the board instead of keeping the old palette.
 */
export function useToken(): (name: string) => string {
  const [, bump] = useState(0);

  useEffect(() => {
    const observer = new MutationObserver(() => bump((n) => n + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  return (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
